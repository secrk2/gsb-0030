'use strict';

const express = require('express');
const { db } = require('./db');
const { findCycle, formatCycle, topoLevels } = require('./dag');
const engine = require('./engine');

const router = express.Router();

const STAGE_TYPES = ['build', 'unit_test', 'image', 'deploy', 'manual_gate'];
const FAIL_POLICIES = ['abort', 'continue', 'retry'];

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

// ---------- 流水线 ----------

router.get(
  '/api/pipelines',
  wrap(async (req, res) => {
    const { rows } = await db().query(`SELECT * FROM pipelines ORDER BY id`);
    if (rows.length) {
      // id 为库内 bigint，净化为整数后内联
      const ids = rows.map((r) => Number(r.id));
      const idList = ids.join(',');
      const stageCnt = await db().query(
        `SELECT pipeline_id, COUNT(*)::int AS n FROM stages WHERE pipeline_id IN (${idList}) GROUP BY pipeline_id`
      );
      const runInfo = await db().query(
        `SELECT DISTINCT ON (pipeline_id) pipeline_id, status
           FROM runs WHERE pipeline_id IN (${idList}) ORDER BY pipeline_id, started_at DESC`
      );
      const runCnt = await db().query(
        `SELECT pipeline_id, COUNT(*)::int AS n FROM runs WHERE pipeline_id IN (${idList}) GROUP BY pipeline_id`
      );
      const sm = new Map(stageCnt.rows.map((r) => [r.pipeline_id, r.n]));
      const rm = new Map(runCnt.rows.map((r) => [r.pipeline_id, r.n]));
      const lm = new Map(runInfo.rows.map((r) => [r.pipeline_id, r.status]));
      for (const p of rows) {
        p.stage_count = sm.get(p.id) || 0;
        p.run_count = rm.get(p.id) || 0;
        p.last_status = lm.get(p.id) || null;
      }
    }
    res.json(rows);
  })
);

router.post(
  '/api/pipelines',
  wrap(async (req, res) => {
    const { name, description = '', repoUrl = '', branch = 'main' } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: '流水线名称不能为空' });
    const { rows } = await db().query(
      'INSERT INTO pipelines (name, description, repo_url, branch) VALUES ($1,$2,$3,$4) RETURNING *',
      [String(name).trim(), description, repoUrl, branch]
    );
    res.status(201).json(rows[0]);
  })
);

router.put(
  '/api/pipelines/:id',
  wrap(async (req, res) => {
    const { name, description, repoUrl, branch } = req.body || {};
    const { rows } = await db().query(
      `UPDATE pipelines SET
         name=COALESCE($2,name), description=COALESCE($3,description),
         repo_url=COALESCE($4,repo_url), branch=COALESCE($5,branch)
       WHERE id=$1 RETURNING *`,
      [req.params.id, name, description, repoUrl, branch]
    );
    if (!rows.length) return res.status(404).json({ error: '流水线不存在' });
    res.json(rows[0]);
  })
);

router.delete(
  '/api/pipelines/:id',
  wrap(async (req, res) => {
    const { rowCount } = await db().query('DELETE FROM pipelines WHERE id=$1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: '流水线不存在' });
    res.status(204).end();
  })
);

// 完整图：阶段 + 边（画布一次拿全）
router.get(
  '/api/pipelines/:id/graph',
  wrap(async (req, res) => {
    const graph = await engine.loadGraph(db(), Number(req.params.id));
    if (!graph) return res.status(404).json({ error: '流水线不存在' });
    const normEdges = graph.edges.map((e) => ({ fromStageId: e.from_stage_id, toStageId: e.to_stage_id }));
    const { levels } = topoLevels(graph.stages, normEdges);
    res.json({ ...graph, levels });
  })
);

// 整张图一次性保存（画布“保存”时提交；在这里做环形依赖拦截）
router.put(
  '/api/pipelines/:id/graph',
  wrap(async (req, res) => {
    const pid = Number(req.params.id);
    const { stages = [], edges = [] } = req.body || {};

    for (const s of stages) {
      if (!s.name || !String(s.name).trim()) return res.status(400).json({ error: '存在未命名的阶段' });
      if (!STAGE_TYPES.includes(s.type)) return res.status(400).json({ error: `阶段「${s.name}」类型非法` });
      if (!FAIL_POLICIES.includes(s.failPolicy)) return res.status(400).json({ error: `阶段「${s.name}」失败策略非法` });
      if (!Number.isInteger(s.timeoutSec) || s.timeoutSec <= 0)
        return res.status(400).json({ error: `阶段「${s.name}」超时时间必须为正整数秒` });
    }
    const dupNames = stages.map((s) => s.name).filter((n, i, arr) => arr.indexOf(n) !== i);
    if (dupNames.length) return res.status(400).json({ error: `阶段名称重复：${[...new Set(dupNames)].join('、')}` });
    // 每个阶段以客户端 key 标识：新阶段用 tempId（如 "new-1"），
    // 已保存阶段用 "db-<id>"；边只引用这些 key。先在临时图上做环检测，
    // 避免脏数据落库。
    const keyOf = (s, i) => s.key || (s.id != null ? `db-${s.id}` : `new-${i}`);
    const keyByIndex = stages.map((s, i) => keyOf(s, i));
    const indexByKey = new Map(keyByIndex.map((k, i) => [k, i]));

    if (edges.some((e) => e.fromStageId === e.toStageId))
      return res.status(400).json({ error: '不允许阶段指向自身' });

    const resolvedEdges = [];
    for (const e of edges) {
      const fi = indexByKey.get(e.fromStageId);
      const ti = indexByKey.get(e.toStageId);
      if (fi == null || ti == null) {
        return res.status(400).json({ error: '存在连接到已删除阶段的边' });
      }
      resolvedEdges.push({ fromStageId: `n${fi}`, toStageId: `n${ti}` });
    }
    const cycleNodes = stages.map((s, i) => ({ id: `n${i}`, name: s.name }));
    const cycle = findCycle(cycleNodes, resolvedEdges);
    if (cycle) {
      return res.status(422).json({
        error: `检测到环形依赖，请断开环路上的一条连线：${formatCycle(cycle)}`,
        code: 'CYCLE_DETECTED',
        cycle,
      });
    }

    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const exists = await client.query('SELECT 1 FROM pipelines WHERE id=$1', [pid]);
      if (!exists.rowCount) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: '流水线不存在' });
      }
      // 简化策略：全量替换阶段与边（id 由前端带回；新阶段无 id）
      await client.query('DELETE FROM stage_edges WHERE pipeline_id=$1', [pid]);
      const old = await client.query('SELECT id FROM stages WHERE pipeline_id=$1', [pid]);
      const keptIds = new Set(stages.filter((s) => s.id).map((s) => s.id));
      for (const r of old.rows) {
        if (!keptIds.has(r.id)) await client.query('DELETE FROM stages WHERE id=$1', [r.id]);
      }

      const dbIdByIndex = new Map();
      for (let i = 0; i < stages.length; i++) {
        const s = stages[i];
        if (s.id) {
          await client.query(
            `UPDATE stages SET name=$2,type=$3,timeout_sec=$4,fail_policy=$5,retry_times=$6,
               gate_owner=$7,pos_x=$8,pos_y=$9 WHERE id=$10 AND pipeline_id=$1`,
            [pid, s.name.trim(), s.type, s.timeoutSec, s.failPolicy, s.retryTimes ?? 0, s.gateOwner ?? '', s.posX ?? 80, s.posY ?? 80, s.id]
          );
          dbIdByIndex.set(i, s.id);
        } else {
          const ins = await client.query(
            `INSERT INTO stages (pipeline_id,name,type,timeout_sec,fail_policy,retry_times,gate_owner,pos_x,pos_y)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [pid, s.name.trim(), s.type, s.timeoutSec, s.failPolicy, s.retryTimes ?? 0, s.gateOwner ?? '', s.posX ?? 80, s.posY ?? 80]
          );
          dbIdByIndex.set(i, ins.rows[0].id);
        }
      }

      for (const e of resolvedEdges) {
        const fromId = dbIdByIndex.get(Number(e.fromStageId.slice(1)));
        const toId = dbIdByIndex.get(Number(e.toStageId.slice(1)));
        if (!fromId || !toId) continue;
        await client.query(
          'INSERT INTO stage_edges (pipeline_id, from_stage_id, to_stage_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [pid, fromId, toId]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    const graph = await engine.loadGraph(db(), pid);
    const savedEdges = graph.edges.map((e) => ({ fromStageId: e.from_stage_id, toStageId: e.to_stage_id }));
    res.json({ ...graph, levels: topoLevels(graph.stages, savedEdges).levels });
  })
);

// 单阶段快速新增（在画布上双击空白处也走整图保存，此接口供简单场景）
router.post(
  '/api/pipelines/:id/stages',
  wrap(async (req, res) => {
    const pid = Number(req.params.id);
    const { name, type, timeoutSec = 1800, failPolicy = 'abort', retryTimes = 0, gateOwner = '', posX = 80, posY = 80 } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: '阶段名称不能为空' });
    if (!STAGE_TYPES.includes(type)) return res.status(400).json({ error: '阶段类型非法' });
    if (!FAIL_POLICIES.includes(failPolicy)) return res.status(400).json({ error: '失败策略非法' });
    try {
      const { rows } = await db().query(
        `INSERT INTO stages (pipeline_id,name,type,timeout_sec,fail_policy,retry_times,gate_owner,pos_x,pos_y)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [pid, name.trim(), type, timeoutSec, failPolicy, retryTimes, gateOwner, posX, posY]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: '同一流水线内阶段名称不能重复' });
      throw e;
    }
  })
);

// ---------- 执行 ----------

router.post(
  '/api/pipelines/:id/run',
  wrap(async (req, res) => {
    const runId = await engine.triggerRun(Number(req.params.id), {
      triggerType: req.body?.triggerType || 'manual',
      triggeredBy: req.body?.triggeredBy || '当前用户',
      failStage: req.body?.failStage,
    });
    res.status(201).json({ runId });
  })
);

router.get(
  '/api/runs',
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const { rows } = await db().query(
      `SELECT r.*, p.name AS pipeline_name
         FROM runs r JOIN pipelines p ON p.id=r.pipeline_id
        ORDER BY r.started_at DESC LIMIT $1`,
      [limit]
    );
    if (rows.length) {
      const idList = rows.map((r) => Number(r.id)).join(',');
      const srRows = await db().query(
        `SELECT run_id, status FROM stage_runs WHERE run_id IN (${idList})`
      );
      const agg = new Map();
      for (const x of srRows.rows) {
        let a = agg.get(x.run_id);
        if (!a) {
          a = { ok_count: 0, fail_count: 0, gate_count: 0 };
          agg.set(x.run_id, a);
        }
        if (x.status === 'success') a.ok_count++;
        if (x.status === 'failed' || x.status === 'gate_rejected') a.fail_count++;
        if (x.status === 'waiting_gate') a.gate_count++;
      }
      for (const r of rows) {
        Object.assign(r, agg.get(r.id) || { ok_count: 0, fail_count: 0, gate_count: 0 });
      }
    }
    res.json(rows);
  })
);

router.get(
  '/api/runs/:id',
  wrap(async (req, res) => {
    const runRes = await db().query(
      `SELECT r.*, p.name AS pipeline_name FROM runs r JOIN pipelines p ON p.id=r.pipeline_id WHERE r.id=$1`,
      [req.params.id]
    );
    if (!runRes.rowCount) return res.status(404).json({ error: '执行记录不存在' });
    const srRes = await db().query(
      `SELECT sr.*, s.name AS stage_name, s.type AS stage_type, s.fail_policy
         FROM stage_runs sr JOIN stages s ON s.id=sr.stage_id
        WHERE sr.run_id=$1 ORDER BY s.id`,
      [req.params.id]
    );
    const graph = await engine.loadGraph(db(), runRes.rows[0].pipeline_id);
    res.json({ run: runRes.rows[0], stageRuns: srRes.rows, edges: graph ? graph.edges : [] });
  })
);

router.post(
  '/api/runs/:id/cancel',
  wrap(async (req, res) => {
    await engine.cancelRun(Number(req.params.id));
    res.status(204).end();
  })
);

// 人工卡点审批/驳回
router.post(
  '/api/runs/:id/gate/:stageId',
  wrap(async (req, res) => {
    const approved = req.body?.approved !== false;
    await engine.resolveGate(
      Number(req.params.id),
      Number(req.params.stageId),
      req.body?.approver || '当前用户',
      approved,
      req.body?.reason || ''
    );
    res.status(204).end();
  })
);

// ---------- 仪表盘 ----------

router.get(
  '/api/dashboard',
  wrap(async (req, res) => {
    const gateHours = Math.max(1, Number(req.query.gateHours) || 4);

    // 时间边界在 JS 中计算后作为参数传入（便于移植与测试）
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOf7d = new Date(startOfToday.getTime() - 6 * 86400000);
    const gateThreshold = new Date(now.getTime() - gateHours * 3600000);

    // 今日运行（取明细在 JS 聚合，避免依赖聚合 FILTER 的方言差异）
    const todayRows = await db().query(
      `SELECT status,
              EXTRACT(EPOCH FROM finished_at) - EXTRACT(EPOCH FROM started_at) AS dur
         FROM runs WHERE started_at >= $1`,
      [startOfToday]
    );
    const today = { total: todayRows.rows.length, success: 0, failed: 0, running: 0 };
    let durSum = 0, durN = 0;
    for (const r of todayRows.rows) {
      if (r.status === 'success') today.success++;
      else if (r.status === 'failed') today.failed++;
      else if (r.status === 'running') today.running++;
      if (r.dur != null) { durSum += r.dur; durN++; }
    }
    today.successRate = today.total ? Number((today.success / today.total).toFixed(4)) : null;
    today.avgDurationSec = durN ? Math.round(durSum / durN) : 0;

    // 近 7 天明细取回来后在 JS 里按天聚合（补齐没有运行的日子）
    const trendRows = await db().query(
      `SELECT started_at, status FROM runs WHERE started_at >= $1`,
      [startOf7d]
    );
    const dayKey = (d) => new Date(d).toDateString();
    const buckets = new Map();
    for (let i = 0; i < 7; i++) {
      const day = new Date(startOfToday.getTime() - (6 - i) * 86400000);
      buckets.set(dayKey(day), { day: day.toISOString(), total: 0, success: 0 });
    }
    for (const r of trendRows.rows) {
      const b = buckets.get(dayKey(r.started_at));
      if (b) {
        b.total++;
        if (r.status === 'success') b.success++;
      }
    }
    const trend = [...buckets.values()].map((b) => ({
      ...b,
      rate: b.total ? Number((b.success / b.total).toFixed(4)) : null,
    }));

    // 卡在人工卡点超过 N 小时
    const stuck = await db().query(
      `SELECT sr.id AS stage_run_id, sr.run_id, sr.stage_id, sr.started_at,
              s.name AS stage_name, p.id AS pipeline_id, p.name AS pipeline_name,
              sr.gate_claimed_by,
              EXTRACT(EPOCH FROM now())::int - EXTRACT(EPOCH FROM sr.started_at)::int AS waiting_sec
         FROM stage_runs sr
         JOIN stages s ON s.id=sr.stage_id
         JOIN runs r ON r.id=sr.run_id
         JOIN pipelines p ON p.id=r.pipeline_id
        WHERE sr.status='waiting_gate'
          AND sr.started_at < $1
        ORDER BY sr.started_at`,
      [gateThreshold]
    );

    const waitingAll = await db().query(
      `SELECT COUNT(*)::int AS n FROM stage_runs WHERE status='waiting_gate'`
    );

    const t = today;
    res.json({
      gateHours,
      today: {
        total: t.total,
        success: t.success,
        failed: t.failed,
        running: t.running,
        successRate: t.successRate,
        avgDurationSec: t.avgDurationSec,
      },
      trend7d: trend,
      stuckGates: stuck.rows,
      waitingGateCount: waitingAll.rows[0].n,
    });
  })
);

router.get(
  '/api/health',
  wrap(async (req, res) => {
    await db().query('SELECT 1');
    res.json({ ok: true, service: 'xuliu', port: 8130 });
  })
);

module.exports = router;
