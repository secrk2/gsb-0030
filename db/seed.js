'use strict';

/**
 * 初始数据：3 条流水线 + 24 条执行记录。
 * 幂等：仅当 pipelines 表为空时写入。
 * 包含：成功/失败/取消/重试成功/人工驳回/人工卡点等待（含超时红灯）等各种形态。
 */

const { initDb, db, waitForDb } = require('../src/db');

// 可复现的伪随机（mulberry32），保证每次重建的初始数据一致
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260919);
const ri = (min, max) => Math.floor(min + rand() * (max - min + 1));

const TYPE_LABEL = {
  build: '构建',
  unit_test: '单测',
  image: '镜像',
  deploy: '部署',
  manual_gate: '人工卡点',
};

const PIPELINES = [
  {
    name: '支付后端发布线',
    description: '支付核心服务：构建 → 单测 → 镜像 → 上线卡点 → 生产部署',
    repoUrl: 'git@example.com:pay/backend.git',
    branch: 'release',
    stages: [
      { name: 'Maven 构建', type: 'build', timeoutSec: 1800, failPolicy: 'abort', x: 60, y: 180 },
      { name: '单元测试', type: 'unit_test', timeoutSec: 1200, failPolicy: 'abort', x: 280, y: 180 },
      { name: '构建镜像', type: 'image', timeoutSec: 900, failPolicy: 'retry', retryTimes: 2, x: 500, y: 180 },
      { name: '上线审批卡点', type: 'manual_gate', timeoutSec: 14400, failPolicy: 'abort', gateOwner: '张婷', x: 720, y: 180 },
      { name: '部署生产', type: 'deploy', timeoutSec: 600, failPolicy: 'abort', x: 940, y: 180 },
    ],
    edges: [
      ['Maven 构建', '单元测试'],
      ['单元测试', '构建镜像'],
      ['构建镜像', '上线审批卡点'],
      ['上线审批卡点', '部署生产'],
    ],
  },
  {
    name: '官网前端发布线',
    description: 'Web 前端：构建后单测与镜像打包并行，验收卡点通过后部署',
    repoUrl: 'git@example.com:web/portal.git',
    branch: 'main',
    stages: [
      { name: 'Node 构建', type: 'build', timeoutSec: 1500, failPolicy: 'abort', x: 60, y: 200 },
      { name: 'Jest 单测', type: 'unit_test', timeoutSec: 900, failPolicy: 'continue', x: 300, y: 80 },
      { name: '构建镜像', type: 'image', timeoutSec: 900, failPolicy: 'abort', x: 300, y: 320 },
      { name: '预发验收卡点', type: 'manual_gate', timeoutSec: 21600, failPolicy: 'abort', gateOwner: '李锐', x: 560, y: 200 },
      { name: '部署 CDN', type: 'deploy', timeoutSec: 600, failPolicy: 'abort', x: 800, y: 200 },
    ],
    edges: [
      ['Node 构建', 'Jest 单测'],
      ['Node 构建', '构建镜像'],
      ['Jest 单测', '预发验收卡点'],
      ['构建镜像', '预发验收卡点'],
      ['预发验收卡点', '部署 CDN'],
    ],
  },
  {
    name: '移动端打包线',
    description: 'App 包体：构建 → 单测（失败放行）→ 镜像 → 发布确认卡点',
    repoUrl: 'git@example.com:mobile/app.git',
    branch: 'develop',
    stages: [
      { name: 'Gradle 构建', type: 'build', timeoutSec: 2400, failPolicy: 'abort', x: 60, y: 160 },
      { name: '仪器化单测', type: 'unit_test', timeoutSec: 1800, failPolicy: 'continue', x: 300, y: 160 },
      { name: '渠道镜像', type: 'image', timeoutSec: 1200, failPolicy: 'retry', retryTimes: 1, x: 540, y: 160 },
      { name: '发布确认卡点', type: 'manual_gate', timeoutSec: 28800, failPolicy: 'abort', gateOwner: '王越', x: 780, y: 160 },
    ],
    edges: [
      ['Gradle 构建', '仪器化单测'],
      ['仪器化单测', '渠道镜像'],
      ['渠道镜像', '发布确认卡点'],
    ],
  },
];

const DUR = {
  build: [120, 420],
  unit_test: [70, 280],
  image: [45, 160],
  deploy: [35, 110],
  manual_gate: [300, 5400],
};

// 执行记录。minAgo = 运行开始距现在的分钟数；
// fail: 在某阶段失败（下游 skipped）；gateReject: 卡点驳回；
// gateWaitingHours: 卡点已等待小时数（运行仍 running，下游 pending）；
// retryStage: 该阶段重试后成功；canceled: 中途取消。
const RUNS = [
  // 支付后端 8 条
  { p: 0, minAgo: 60 * 10 + 25, trig: 'push', by: 'gitlab-bot' },
  { p: 0, minAgo: 60 * 8 + 40, trig: 'manual', by: '张婷', fail: '单元测试' },
  { p: 0, minAgo: 60 * 7 + 10, trig: 'push', by: 'gitlab-bot' },
  { p: 0, minAgo: 60 * 4 + 35, trig: 'manual', by: '周凯' },
  { p: 0, minAgo: 60 * 3 + 5, trig: 'schedule', by: '定时巡检', fail: '部署生产' },
  { p: 0, minAgo: 60 * 5 + 20, trig: 'manual', by: '陈晨', gateWaitingHours: 5.3 },
  { p: 0, minAgo: 60 * 1, trig: 'push', by: 'gitlab-bot' },
  { p: 0, minAgo: 60 * 26, trig: 'push', by: 'gitlab-bot' },
  { p: 0, minAgo: 60 * 24 * 2 + 300, trig: 'manual', by: '张婷', gateReject: '上线审批卡点', rejectReason: '灰度指标异常，驳回发布' },
  { p: 0, minAgo: 60 * 24 * 3 + 120, trig: 'schedule', by: '定时巡检' },
  // 官网前端 8 条
  { p: 0 + 1, minAgo: 60 * 9 + 20, trig: 'push', by: 'github-bot' },
  { p: 1, minAgo: 60 * 6 + 50, trig: 'manual', by: '李锐', retryStage: '构建镜像' },
  { p: 1, minAgo: 60 * 26 + 40, trig: 'manual', by: '李锐', gateWaitingHours: 26.5 },
  { p: 1, minAgo: 60 * 22, trig: 'push', by: 'github-bot' },
  { p: 1, minAgo: 60 * 30, trig: 'manual', by: '何苗', fail: 'Node 构建' },
  { p: 1, minAgo: 60 * 24 * 2 + 200, trig: 'push', by: 'github-bot', canceled: true, cancelAt: 'Jest 单测' },
  { p: 1, minAgo: 60 * 24 * 4 + 360, trig: 'push', by: 'github-bot' },
  { p: 1, minAgo: 60 * 24 * 6 + 60, trig: 'schedule', by: '定时巡检' },
  // 移动端 8 条
  { p: 2, minAgo: 60 * 10 + 10, trig: 'schedule', by: '定时巡检' },
  { p: 2, minAgo: 60 * 5 + 40, trig: 'push', by: 'gitlab-bot', fail: '仪器化单测' }, // continue 放行：下游照跑
  { p: 2, minAgo: 60 * 1 + 20, trig: 'manual', by: '王越', gateWaitingHours: 1.3 }, // 未超阈值，不亮红灯
  { p: 2, minAgo: 60 * 27, trig: 'manual', by: '王越' },
  { p: 2, minAgo: 60 * 24 * 3 + 420, trig: 'push', by: 'gitlab-bot' },
  { p: 2, minAgo: 60 * 24 * 5 + 180, trig: 'manual', by: '王越', gateReject: '发布确认卡点', rejectReason: '发现崩溃率回退，暂不发布' },
];

async function insertGraph(client, def) {
  const p = await client.query(
    'INSERT INTO pipelines (name, description, repo_url, branch) VALUES ($1,$2,$3,$4) RETURNING id',
    [def.name, def.description, def.repoUrl, def.branch]
  );
  const pid = p.rows[0].id;
  const idByName = new Map();
  for (const s of def.stages) {
    const r = await client.query(
      `INSERT INTO stages (pipeline_id,name,type,timeout_sec,fail_policy,retry_times,gate_owner,pos_x,pos_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [pid, s.name, s.type, s.timeoutSec, s.failPolicy, s.retryTimes || 0, s.gateOwner || '', s.x, s.y]
    );
    idByName.set(s.name, r.rows[0].id);
  }
  for (const [from, to] of def.edges) {
    await client.query(
      'INSERT INTO stage_edges (pipeline_id, from_stage_id, to_stage_id) VALUES ($1,$2,$3)',
      [pid, idByName.get(from), idByName.get(to)]
    );
  }
  return { pid, idByName };
}

async function insertRun(client, pipeDef, meta, ctx) {
  const start = new Date(Date.now() - meta.minAgo * 60 * 1000);
  let status = 'success';
  if (meta.fail) status = 'failed';
  if (meta.gateReject) status = 'failed';
  if (meta.canceled) status = 'canceled';
  if (meta.gateWaitingHours != null) status = 'running';

  const run = await client.query(
    `INSERT INTO runs (pipeline_id, status, trigger_type, triggered_by, started_at, finished_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [ctx.pid, status, meta.trig, meta.by || '', start, status === 'running' ? null : new Date(start.getTime() + ri(240, 900) * 1000)]
  );
  const runId = run.rows[0].id;

  // 按定义顺序逐个落阶段（种子图的边都按顺序声明）。
  // hardStop 表示出现了“中止型”阻断（abort 失败 / 卡点驳回 / 取消）；
  // continue 型失败不阻断下游，但整条 run 仍记为 failed。
  let cursor = new Date(start);
  let hardStop = false;
  for (const s of pipeDef.stages) {
    const dur = ri(...DUR[s.type]);
    const st = new Date(cursor);
    const fin = new Date(st.getTime() + dur * 1000);
    let srStatus = 'success';
    let message = '执行成功';
    let attempt = 1;
    let claimedBy = '';
    let startedAt = st;
    let finishedAt = fin;
    let durationSec = dur;

    // 1) 已被中止型阻断：跳过
    if (hardStop) {
      srStatus = meta.canceled ? 'skipped' : 'skipped';
      message = meta.canceled ? '执行被手动取消' : '上游阶段失败，按失败策略中止';
      finishedAt = startedAt;
      durationSec = 0;
    } else if (s.type === 'manual_gate') {
      // 2) 人工卡点：等待 / 通过 / 驳回
      if (meta.gateWaitingHours != null) {
        srStatus = 'waiting_gate';
        startedAt = new Date(Date.now() - meta.gateWaitingHours * 3600 * 1000);
        finishedAt = null;
        durationSec = null;
        message = `等待人工卡点审批（负责人：${s.gateOwner}）`;
      } else if (meta.gateReject === s.name) {
        srStatus = 'gate_rejected';
        message = `人工审批驳回：${meta.rejectReason}`;
        claimedBy = s.gateOwner;
        hardStop = true;
      } else {
        srStatus = 'success';
        message = `人工审批通过（${s.gateOwner}）`;
        claimedBy = s.gateOwner;
      }
    } else if (meta.fail === s.name) {
      // 3) 指定失败点：continue 不阻断下游，其余中止
      srStatus = 'failed';
      message = '模拟执行失败：退出码非 0';
      hardStop = s.failPolicy !== 'continue';
    } else if (meta.canceled && s.name === meta.cancelAt) {
      // 4) 取消点（视为从该阶段起中止）
      srStatus = 'skipped';
      message = '执行被手动取消';
      finishedAt = startedAt;
      durationSec = 0;
      hardStop = true;
    } else if (meta.retryStage === s.name) {
      attempt = 2;
      message = '第 1 次尝试执行失败，第 2 次尝试成功';
    }

    // 5) 等待中的卡点：其下游一律 pending
    const gateIdx = pipeDef.stages.findIndex((x) => x.type === 'manual_gate');
    const myIdx = pipeDef.stages.findIndex((x) => x.name === s.name);
    if (meta.gateWaitingHours != null && myIdx > gateIdx) {
      srStatus = 'pending';
      message = '';
      startedAt = null;
      finishedAt = null;
      durationSec = null;
    }

    await client.query(
      `INSERT INTO stage_runs (run_id, stage_id, status, attempt, started_at, finished_at, duration_sec, message, gate_claimed, gate_claimed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        runId,
        ctx.idByName.get(s.name),
        srStatus,
        attempt,
        startedAt,
        finishedAt,
        durationSec,
        message,
        claimedBy ? fin : null,
        claimedBy,
      ]
    );

    if (finishedAt && finishedAt > cursor) cursor = finishedAt;
  }

  // 用最后阶段实际结束时间回填 run.finished_at
  if (status !== 'running') {
    const maxFin = await client.query(
      'SELECT MAX(finished_at) AS m FROM stage_runs WHERE run_id=$1',
      [runId]
    );
    await client.query('UPDATE runs SET finished_at=$2 WHERE id=$1', [runId, maxFin.rows[0].m]);
  }
}

async function seed() {
  const pool = db();
  const guard = await pool.query('SELECT COUNT(*)::int AS n FROM pipelines');
  if (guard.rows[0].n > 0) {
    console.log('已存在流水线数据，跳过种子写入。');
    return false;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ctxs = [];
    for (const def of PIPELINES) {
      ctxs.push(await insertGraph(client, def));
    }
    for (const meta of RUNS) {
      await insertRun(client, PIPELINES[meta.p], meta, ctxs[meta.p]);
    }
    await client.query('COMMIT');
    console.log(`种子数据写入完成：${PIPELINES.length} 条流水线，${RUNS.length} 条执行记录。`);
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  (async () => {
    await initDb();
    await waitForDb();
    await seed();
    process.exit(0);
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { seed };
