'use strict';

/**
 * 流水线模拟执行引擎。
 *
 * 设计要点：
 * - advanceRun() 是唯一的推进函数，可重入、幂等：根据 stage_runs 现状 +
 *   依赖边决定哪些 pending 阶段可以启动 / 跳过，直到状态稳定。
 * - 人工卡点阶段进入 waiting_gate 后挂起，审批接口改写状态后再次调用
 *   advanceRun()，因此即使进程重启，审批后也能继续推进。
 * - 非人工阶段为“模拟执行”：立即按阶段类型生成一段耗时并落库。
 * - 失败策略：abort 失败即令下游 skipped；continue 下游照常；retry 先按
 *   retry_times 重试，耗尽后按 abort 处理。
 */

const { db } = require('./db');
const { findCycle, topoLevels } = require('./dag');

// runId -> Promise，串行化同一次运行的推进，避免审批与触发并发打架
const advancing = new Map();
// runId -> stageName，演示用：强制某阶段失败
const forcedFailures = new Map();

const DURATION_RANGE = {
  build: [90, 420],
  unit_test: [45, 300],
  image: [30, 180],
  deploy: [20, 120],
  manual_gate: [0, 0],
};

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function loadGraph(client, pipelineId) {
  const pRes = await client.query('SELECT * FROM pipelines WHERE id = $1', [pipelineId]);
  if (pRes.rowCount === 0) return null;
  const sRes = await client.query('SELECT * FROM stages WHERE pipeline_id = $1 ORDER BY id', [pipelineId]);
  const eRes = await client.query('SELECT * FROM stage_edges WHERE pipeline_id = $1 ORDER BY id', [pipelineId]);
  return { pipeline: pRes.rows[0], stages: sRes.rows, edges: eRes.rows };
}

async function triggerRun(pipelineId, opts = {}) {
  const pool = db();
  const graph = await loadGraph(pool, pipelineId);
  if (!graph) {
    const err = new Error('流水线不存在');
    err.status = 404;
    throw err;
  }
  const normEdges = graph.edges.map((e) => ({
    fromStageId: e.from_stage_id,
    toStageId: e.to_stage_id,
  }));
  const cycle = findCycle(graph.stages, normEdges);
  if (cycle) {
    const err = new Error('流水线存在环形依赖，无法执行');
    err.status = 400;
    err.cycle = cycle;
    throw err;
  }

  const client = await pool.connect();
  let runId;
  try {
    await client.query('BEGIN');
    const runRes = await client.query(
      `INSERT INTO runs (pipeline_id, trigger_type, triggered_by, started_at)
       VALUES ($1, $2, $3, now()) RETURNING *`,
      [pipelineId, opts.triggerType || 'manual', opts.triggeredBy || '']
    );
    runId = runRes.rows[0].id;
    for (const s of graph.stages) {
      await client.query(
        `INSERT INTO stage_runs (run_id, stage_id, status) VALUES ($1, $2, 'pending')`,
        [runId, s.id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    client.release();
    throw e;
  }
  client.release();

  if (opts.failStage) forcedFailures.set(runId, opts.failStage);
  await advanceRun(runId);
  return runId;
}

function advanceRun(runId) {
  let chain = advancing.get(runId) || Promise.resolve();
  chain = chain
    .then(() => advanceRunInner(runId))
    .catch((err) => {
      console.error(`[engine] run ${runId} 推进失败:`, err.message);
    });
  advancing.set(runId, chain);
  return chain;
}

async function advanceRunInner(runId) {
  const pool = db();

  // 多轮推进：每完成/跳过一个阶段都可能解锁下游
  for (let round = 0; round < 200; round++) {
    const runRes = await pool.query('SELECT * FROM runs WHERE id = $1', [runId]);
    if (runRes.rowCount === 0) return;
    const run = runRes.rows[0];
    if (run.status !== 'running') return;

    const stagesRes = await pool.query(
      `SELECT s.* FROM stages s JOIN stage_runs sr ON sr.stage_id = s.id
       WHERE sr.run_id = $1 ORDER BY s.id`,
      [runId]
    );
    const stages = stagesRes.rows;
    const edgesRes = await pool.query(
      `SELECT e.* FROM stage_edges e
       JOIN stage_runs sr ON sr.run_id = $1 AND sr.stage_id = e.to_stage_id`,
      [runId]
    );
    // 仅保留本次运行内仍存在的阶段之间的边
    const stageIds = new Set(stages.map((s) => s.id));
    const edges = edgesRes.rows
      .filter((e) => stageIds.has(e.from_stage_id))
      .map((e) => ({ fromStageId: e.from_stage_id, toStageId: e.to_stage_id }));

    const srRes = await pool.query('SELECT * FROM stage_runs WHERE run_id = $1', [runId]);
    const srByStage = new Map(srRes.rows.map((sr) => [sr.stage_id, sr]));

    const { order } = topoLevels(stages, edges);
    let changed = false;

    for (const stageId of order) {
      const stage = stages.find((s) => s.id === stageId);
      const sr = srByStage.get(stageId);
      if (!sr || sr.status !== 'pending') continue;

      const deps = edges.filter((e) => e.toStageId === stageId).map((e) => srByStage.get(e.fromStageId));
      const blockers = deps.filter((d) => d && ['failed', 'skipped', 'gate_rejected'].includes(d.status));

      if (blockers.length) {
        const hard = blockers.some((d) => {
          if (d.status === 'skipped' || d.status === 'gate_rejected') return true;
          const depStage = stages.find((s) => s.id === d.stage_id);
          // continue 放行；abort / retry（重试耗尽）阻断
          return depStage.fail_policy !== 'continue';
        });
        if (hard) {
          await pool.query(
            `UPDATE stage_runs SET status='skipped', message=$2, started_at=now(), finished_at=now(), duration_sec=0
             WHERE run_id=$1 AND stage_id=$3`,
            [runId, '上游阶段失败，按失败策略中止', stageId]
          );
          changed = true;
          continue;
        }
      }

      const allDepsResolved = deps.every(
        (d) =>
          d &&
          (d.status === 'success' ||
            (d.status === 'failed' && stages.find((s) => s.id === d.stage_id).fail_policy === 'continue'))
      );
      if (!allDepsResolved) continue;

      // 启动该阶段
      if (stage.type === 'manual_gate') {
        await pool.query(
          `UPDATE stage_runs SET status='waiting_gate', started_at=now(), attempt=1, message=$2
           WHERE run_id=$1 AND stage_id=$3`,
          [runId, `等待人工卡点审批（负责人：${stage.gate_owner || '未指定'}）`, stageId]
        );
        changed = true;
        continue;
      }

      const result = await executeStage(runId, stage, forcedFailures.get(runId));
      changed = changed || result;
    }

    if (!changed) break;
  }

  await finalizeIfDone(runId);
}

async function executeStage(runId, stage, forcedFailName) {
  const pool = db();
  const [minD, maxD] = DURATION_RANGE[stage.type] || [30, 180];
  const maxAttempts = stage.fail_policy === 'retry' ? 1 + stage.retry_times : 1;
  let attempt = 1;
  let changed = false;

  while (attempt <= maxAttempts) {
    const duration = randInt(minD, maxD);
    const finishAt = new Date();
    const startAt = new Date(finishAt.getTime() - duration * 1000);
    const shouldFail = forcedFailName === stage.name || (stage.fail_policy === 'retry' && attempt < maxAttempts && Math.random() < 0.5);
    // 注：retry 策略下有概率模拟一次抖动失败后重试成功，便于展示 attempt

    if (!shouldFail) {
      const msg = attempt > 1 ? `第 ${attempt} 次尝试成功` : '执行成功';
      await pool.query(
        `UPDATE stage_runs SET status='success', attempt=$2, started_at=$3, finished_at=$4,
           duration_sec=$5, message=$6 WHERE run_id=$1 AND stage_id=$7`,
        [runId, attempt, startAt, finishAt, duration, msg, stage.id]
      );
      return true;
    }

    if (attempt < maxAttempts) {
      await pool.query(
        `UPDATE stage_runs SET attempt=$2, message='执行失败，准备重试' WHERE run_id=$1 AND stage_id=$3`,
        [runId, attempt + 1, stage.id]
      );
      changed = true;
      attempt++;
      continue;
    }

    // 最终失败
    await pool.query(
      `UPDATE stage_runs SET status='failed', attempt=$2, started_at=$3, finished_at=$4,
         duration_sec=$5, message=$6 WHERE run_id=$1 AND stage_id=$7`,
      [
        runId,
        attempt,
        startAt,
        finishAt,
        duration,
        forcedFailName === stage.name ? '模拟执行失败（强制失败）' : `执行失败（已重试 ${stage.retry_times} 次）`,
        stage.id,
      ]
    );
    forcedFailures.delete(runId);
    return true;
  }
  return changed;
}

async function finalizeIfDone(runId) {
  const pool = db();
  const pending = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stage_runs
     WHERE run_id=$1 AND status IN ('pending','running','waiting_gate')`,
    [runId]
  );
  if (pending.rows[0].n > 0) return;

  const bad = await pool.query(
    `SELECT COUNT(*)::int AS n FROM stage_runs
     WHERE run_id=$1 AND status IN ('failed','gate_rejected')`,
    [runId]
  );
  const status = bad.rows[0].n > 0 ? 'failed' : 'success';
  await pool.query('UPDATE runs SET status=$2, finished_at=now() WHERE id=$1 AND status=$3', [
    runId,
    status,
    'running',
  ]);
  forcedFailures.delete(runId);
}

async function resolveGate(runId, stageId, approver, approved, reason) {
  const pool = db();
  const sr = await pool.query('SELECT * FROM stage_runs WHERE run_id=$1 AND stage_id=$2', [runId, stageId]);
  if (sr.rowCount === 0) {
    const err = new Error('阶段执行记录不存在');
    err.status = 404;
    throw err;
  }
  if (sr.rows[0].status !== 'waiting_gate') {
    const err = new Error('该人工卡点不在等待审批状态');
    err.status = 409;
    throw err;
  }
  await pool.query(
    `UPDATE stage_runs
       SET status=$3, gate_claimed=now(), gate_claimed_by=$4, finished_at=now(),
           duration_sec=GREATEST(1, EXTRACT(EPOCH FROM now())::int - EXTRACT(EPOCH FROM started_at)::int),
           message=$5
     WHERE run_id=$1 AND stage_id=$2`,
    [
      runId,
      stageId,
      approved ? 'success' : 'gate_rejected',
      approver || '匿名审批人',
      approved ? `人工审批通过（${approver || '匿名审批人'}）` : `人工审批驳回：${reason || '未填写原因'}`,
    ]
  );
  if (!approved) {
    // 驳回 = 整条运行失败，下游随后会被 advance 标记 skipped
  }
  await advanceRun(runId);
}

async function cancelRun(runId) {
  const pool = db();
  const run = await pool.query('SELECT * FROM runs WHERE id=$1', [runId]);
  if (run.rowCount === 0) {
    const err = new Error('运行不存在');
    err.status = 404;
    throw err;
  }
  if (run.rows[0].status !== 'running') {
    const err = new Error('仅运行中的执行可以取消');
    err.status = 409;
    throw err;
  }
  await pool.query(
    `UPDATE stage_runs SET status='skipped', finished_at=COALESCE(finished_at, now()),
       message='执行被手动取消' WHERE run_id=$1 AND status IN ('pending','running','waiting_gate')`,
    [runId]
  );
  await pool.query(`UPDATE runs SET status='canceled', finished_at=now() WHERE id=$1`, [runId]);
  forcedFailures.delete(runId);
}

module.exports = { triggerRun, advanceRun, resolveGate, cancelRun, loadGraph };
