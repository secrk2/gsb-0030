'use strict';

/* ============================================================
 * 端到端测试：pg-mem 承载 SQL，直接驱动 Express app 与引擎。
 * 覆盖：环检测拦截（返回那条环）、并行/串行、失败策略、
 *       人工卡点挂起/审批/驳回、仪表盘统计、种子数据完整性。
 * 运行：npm test
 * ============================================================ */

const assert = require('assert');
const { newDb } = require('pg-mem');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ---- 用 pg-mem 打桩 pg 模块 ----
const mem = newDb();
const pgMemAdapter = mem.adapters.createPg();
const fakePool = pgMemAdapter.Pool;

const pgPath = require.resolve('pg');
require.cache[pgPath] = {
  id: pgPath,
  filename: pgPath,
  loaded: true,
  exports: { ...pgMemAdapter, Pool: fakePool },
};

const { initDb, db } = require('../src/db');
const { findCycle, topoLevels, formatCycle } = require('../src/dag');

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    });
}

async function createPipelineWithStages(defs) {
  const p = await db().query(
    'INSERT INTO pipelines (name, description) VALUES ($1,$2) RETURNING id',
    [defs.name || '测试线', '']
  );
  const pid = p.rows[0].id;
  const idByName = new Map();
  for (const s of defs.stages) {
    const r = await db().query(
      `INSERT INTO stages (pipeline_id,name,type,timeout_sec,fail_policy,retry_times,gate_owner,pos_x,pos_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [pid, s.name, s.type, s.timeoutSec ?? 1800, s.failPolicy || 'abort', s.retryTimes ?? 0, s.gateOwner ?? '', s.x ?? 0, s.y ?? 0]
    );
    idByName.set(s.name, r.rows[0].id);
  }
  for (const [a, b] of defs.edges || []) {
    await db().query('INSERT INTO stage_edges (pipeline_id, from_stage_id, to_stage_id) VALUES ($1,$2,$3)', [
      pid,
      idByName.get(a),
      idByName.get(b),
    ]);
  }
  return { pid, idByName };
}

async function runStatuses(runId, idByName) {
  const { rows } = await db().query(
    `SELECT s.name, sr.status FROM stage_runs sr JOIN stages s ON s.id=sr.stage_id WHERE sr.run_id=$1`,
    [runId]
  );
  const byName = Object.fromEntries(rows.map((r) => [r.name, r.status]));
  return byName;
}

async function main() {
  await initDb();
  const { app } = require('../src/server');
  const engine = require('../src/engine');

  console.log('DAG 单元逻辑：');

  await test('无环图 findCycle 返回 null', () => {
    const nodes = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }, { id: 3, name: 'C' }];
    assert.strictEqual(findCycle(nodes, [{ fromStageId: 1, toStageId: 2 }, { fromStageId: 2, toStageId: 3 }]), null);
  });

  await test('直接环 A→B→A 被找出并格式化', () => {
    const nodes = [{ id: 1, name: '构建' }, { id: 2, name: '镜像' }];
    const cyc = findCycle(nodes, [
      { fromStageId: 1, toStageId: 2 },
      { fromStageId: 2, toStageId: 1 },
    ]);
    assert.ok(cyc, '应检测到环');
    assert.strictEqual(cyc[0].name, cyc[cyc.length - 1].name);
    assert.strictEqual(formatCycle(cyc), '构建 → 镜像 → 构建');
  });

  await test('深度分支中的环 C→D→E→C 被找出', () => {
    const nodes = [1, 2, 3, 4, 5].map((i) => ({ id: i, name: 'S' + i }));
    const edges = [
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
      [5, 3],
    ].map(([a, b]) => ({ fromStageId: a, toStageId: b }));
    const cyc = findCycle(nodes, edges);
    assert.deepStrictEqual(cyc.map((n) => n.name), ['S3', 'S4', 'S5', 'S3']);
  });

  await test('拓扑分层：并行分支同层', () => {
    const nodes = [1, 2, 3, 4].map((i) => ({ id: i, name: 'S' + i }));
    const edges = [
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ].map(([a, b]) => ({ fromStageId: a, toStageId: b }));
    const { levels } = topoLevels(nodes, edges);
    assert.deepStrictEqual(levels, [[1], [2, 3], [4]]);
  });

  console.log('引擎行为：');

  await test('串行全绿：全部 success，run 收尾 success', async () => {
    const { pid, idByName } = await createPipelineWithStages({
      stages: [{ name: 'A', type: 'build' }, { name: 'B', type: 'image' }, { name: 'C', type: 'deploy' }],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
    });
    const runId = await engine.triggerRun(pid);
    const st = await runStatuses(runId, idByName);
    assert.deepStrictEqual(st, { A: 'success', B: 'success', C: 'success' });
    const run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'success');
  });

  await test('并行分支：无依赖的阶段同批执行', async () => {
    const { pid } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'build' },
        { name: 'B', type: 'unit_test' },
        { name: 'C', type: 'image' },
        { name: 'D', type: 'deploy' },
      ],
      edges: [
        ['A', 'B'],
        ['A', 'C'],
        ['B', 'D'],
        ['C', 'D'],
      ],
    });
    const runId = await engine.triggerRun(pid);
    const { rows } = await db().query(
      `SELECT s.name, sr.status, sr.duration_sec FROM stage_runs sr
         JOIN stages s ON s.id=sr.stage_id WHERE sr.run_id=$1`,
      [runId]
    );
    assert.strictEqual(rows.length, 4);
    assert.ok(rows.every((r) => r.status === 'success'));
  });

  await test('abort 失败：失败点及下游 failed/skipped，run=failed', async () => {
    const { pid } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'build' },
        { name: 'B', type: 'unit_test', failPolicy: 'abort' },
        { name: 'C', type: 'deploy' },
      ],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
      ],
    });
    const runId = await engine.triggerRun(pid, { failStage: 'B' });
    const st = await runStatuses(runId);
    assert.strictEqual(st.A, 'success');
    assert.strictEqual(st.B, 'failed');
    assert.strictEqual(st.C, 'skipped');
    const run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'failed');
  });

  await test('continue 失败：下游继续执行，但 run=failed', async () => {
    const { pid } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'unit_test', failPolicy: 'continue' },
        { name: 'B', type: 'image', failPolicy: 'abort' },
      ],
      edges: [['A', 'B']],
    });
    const runId = await engine.triggerRun(pid, { failStage: 'A' });
    const st = await runStatuses(runId);
    assert.strictEqual(st.A, 'failed');
    assert.strictEqual(st.B, 'success');
    const run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'failed');
  });

  await test('retry 策略：强制失败时重试耗尽后 failed', async () => {
    const { pid } = await createPipelineWithStages({
      stages: [{ name: 'A', type: 'image', failPolicy: 'retry', retryTimes: 2 }],
      edges: [],
    });
    const runId = await engine.triggerRun(pid, { failStage: 'A' });
    const sr = (await db().query('SELECT status, attempt FROM stage_runs WHERE run_id=$1', [runId])).rows[0];
    assert.strictEqual(sr.status, 'failed');
    assert.strictEqual(sr.attempt, 3);
  });

  await test('人工卡点：运行挂起在 waiting_gate，审批通过后跑完', async () => {
    const { pid, idByName } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'build' },
        { name: 'G', type: 'manual_gate', gateOwner: '张婷' },
        { name: 'D', type: 'deploy' },
      ],
      edges: [
        ['A', 'G'],
        ['G', 'D'],
      ],
    });
    const runId = await engine.triggerRun(pid);
    let st = await runStatuses(runId);
    assert.strictEqual(st.A, 'success');
    assert.strictEqual(st.G, 'waiting_gate');
    assert.strictEqual(st.D, 'pending');
    let run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'running');

    await engine.resolveGate(runId, idByName.get('G'), '张婷', true, '');
    st = await runStatuses(runId);
    assert.strictEqual(st.G, 'success');
    assert.strictEqual(st.D, 'success');
    run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'success');
  });

  await test('人工卡点驳回：gate_rejected 且下游 skipped，run=failed', async () => {
    const { pid, idByName } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'build' },
        { name: 'G', type: 'manual_gate' },
        { name: 'D', type: 'deploy' },
      ],
      edges: [
        ['A', 'G'],
        ['G', 'D'],
      ],
    });
    const runId = await engine.triggerRun(pid);
    await engine.resolveGate(runId, idByName.get('G'), '李锐', false, '指标异常');
    const st = await runStatuses(runId);
    assert.strictEqual(st.G, 'gate_rejected');
    assert.strictEqual(st.D, 'skipped');
    const run = (await db().query('SELECT status FROM runs WHERE id=$1', [runId])).rows[0];
    assert.strictEqual(run.status, 'failed');
  });

  await test('对有环流水线触发执行被拒绝', async () => {
    const { pid } = await createPipelineWithStages({
      stages: [
        { name: 'A', type: 'build' },
        { name: 'B', type: 'image' },
      ],
      edges: [
        ['A', 'B'],
        ['B', 'A'],
      ],
    });
    await assert.rejects(() => engine.triggerRun(pid), /环形依赖/);
  });

  console.log('HTTP API（整图保存的环拦截）：');

  // 起一个临时服务做真实 HTTP 调用
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const call = (method, urlPath, body) =>
    new Promise((resolve, reject) => {
      const data = body !== undefined ? JSON.stringify(body) : null;
      const req = http.request(
        { hostname: '127.0.0.1', port, path: urlPath, method, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => resolve({ status: res.statusCode, body: buf ? JSON.parse(buf) : null }));
        }
      );
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });

  await test('PUT graph 保存合法图成功', async () => {
    const created = await call('POST', '/api/pipelines', { name: 'HTTP线' });
    const pid = created.body.id;
    const res = await call('PUT', `/api/pipelines/${pid}/graph`, {
      stages: [
        { key: 'new-0', name: '构建', type: 'build', timeoutSec: 600, failPolicy: 'abort', retryTimes: 0, posX: 0, posY: 0 },
        { key: 'new-1', name: '镜像', type: 'image', timeoutSec: 600, failPolicy: 'abort', retryTimes: 0, posX: 300, posY: 0 },
      ],
      edges: [{ fromStageId: 'new-0', toStageId: 'new-1' }],
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.stages.length, 2);
    assert.strictEqual(res.body.edges.length, 1);
  });

  await test('PUT graph 环被 422 拦截并返回环路径', async () => {
    const created = await call('POST', '/api/pipelines', { name: '环线' });
    const pid = created.body.id;
    const res = await call('PUT', `/api/pipelines/${pid}/graph`, {
      stages: ['构建', '镜像', '部署'].map((name, i) => ({
        key: `new-${i}`,
        name,
        type: 'build',
        timeoutSec: 600,
        failPolicy: 'abort',
        retryTimes: 0,
        posX: i * 240,
        posY: 0,
      })),
      edges: [
        { fromStageId: 'new-0', toStageId: 'new-1' },
        { fromStageId: 'new-1', toStageId: 'new-2' },
        { fromStageId: 'new-2', toStageId: 'new-0' },
      ],
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'CYCLE_DETECTED');
    assert.strictEqual(res.body.cycle[0].name, res.body.cycle.at(-1).name);
    assert.ok(res.body.error.includes('构建 → 镜像 → 部署 → 构建'));
    // 脏数据未落库
    const left = await db().query('SELECT COUNT(*)::int AS n FROM stages WHERE pipeline_id=$1', [pid]);
    assert.strictEqual(left.rows[0].n, 0);
  });

  await test('PUT graph 重复阶段名被 400 拦截', async () => {
    const created = await call('POST', '/api/pipelines', { name: '重名线' });
    const pid = created.body.id;
    const res = await call('PUT', `/api/pipelines/${pid}/graph`, {
      stages: [
        { key: 'new-0', name: 'X', type: 'build', timeoutSec: 600, failPolicy: 'abort', retryTimes: 0 },
        { key: 'new-1', name: 'X', type: 'image', timeoutSec: 600, failPolicy: 'abort', retryTimes: 0 },
      ],
      edges: [],
    });
    assert.strictEqual(res.status, 400);
  });

  await test('健康检查可用', async () => {
    const res = await call('GET', '/api/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  server.close();

  console.log('种子数据：');

  // 重新建一套干净库验证种子
  const mem2 = newDb();
  const adapter2 = mem2.adapters.createPg();
  const pgMem2 = adapter2;
  // 直接在当前库中清表后跑种子（init.sql 幂等）
  await db().query('TRUNCATE pipelines CASCADE');
  const { seed } = require('../db/seed');
  await seed();

  await test('至少 3 条流水线', async () => {
    const r = await db().query('SELECT COUNT(*)::int AS n FROM pipelines');
    assert.ok(r.rows[0].n >= 3, `实际 ${r.rows[0].n}`);
  });

  await test('至少 20 条执行记录', async () => {
    const r = await db().query('SELECT COUNT(*)::int AS n FROM runs');
    assert.ok(r.rows[0].n >= 20, `实际 ${r.rows[0].n}`);
  });

  await test('每条流水线图无环', async () => {
    const { rows: pipes } = await db().query('SELECT id FROM pipelines');
    for (const p of pipes) {
      const s = await db().query('SELECT id, name FROM stages WHERE pipeline_id=$1', [p.id]);
      const e = await db().query('SELECT from_stage_id, to_stage_id FROM stage_edges WHERE pipeline_id=$1', [p.id]);
      assert.strictEqual(findCycle(s.rows, e.rows), null);
    }
  });

  await test('种子包含 waiting_gate 卡点记录（红灯有数据）', async () => {
    const r = await db().query(`SELECT COUNT(*)::int AS n FROM stage_runs WHERE status='waiting_gate'`);
    assert.ok(r.rows[0].n >= 3, `实际 ${r.rows[0].n}`);
  });

  await test('仪表盘接口返回完整结构', async () => {
    const server2 = app.listen(0);
    await new Promise((r) => server2.once('listening', r));
    const port2 = server2.address().port;
    const res = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${port2}/api/dashboard?gateHours=4`, (resp) => {
        let buf = '';
        resp.on('data', (c) => (buf += c));
        resp.on('end', () => resolve(JSON.parse(buf)));
      }).on('error', reject);
    });
    server2.close();
    assert.ok(typeof res.today.total === 'number');
    assert.strictEqual(res.trend7d.length, 7);
    assert.ok(Array.isArray(res.stuckGates));
    // 种子里有 5.3h 与 26.5h 两个卡点超 4 小时阈值
    assert.ok(res.stuckGates.length >= 2, `红灯数 ${res.stuckGates.length}`);
  });

  console.log(`\n全部通过：${passed} 个测试 ✓`);
}

main().catch((e) => {
  console.error('\n测试失败：', e);
  process.exit(1);
});
