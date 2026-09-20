'use strict';

/**
 * 种子数据：3 条流水线（含串行 / 并行分支 / 人工卡点）+ 23 条执行记录。
 * 时间锚定“现在”，保证仪表盘的“今日”指标永远有数据。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateStages } = require('./dag');
const store = require('./store');

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

function rid(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

/** 确定性伪随机：同一 index 永远得到同一结果，避免每次 seed 数据漂移。 */
function pseudo(seed, min, max) {
  const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  const f = x - Math.floor(x);
  return min + f * (max - min);
}

const PIPELINES = [
  {
    id: 'pl_backend',
    name: '后端服务发布',
    description: 'payment-api：构建 → 单测/集成测试（并行）→ 镜像 → 预发 → 生产审批 → 生产',
    stages: [
      { id: 'build', name: 'Maven 构建', type: 'build', timeoutMin: 20, failurePolicy: 'abort', deps: [], x: 60, y: 250 },
      { id: 'unit-test', name: '单元测试', type: 'test', timeoutMin: 15, failurePolicy: 'abort', deps: ['build'], x: 280, y: 110 },
      { id: 'integration-test', name: '集成测试', type: 'test', timeoutMin: 25, failurePolicy: 'abort', deps: ['build'], x: 280, y: 390 },
      { id: 'image', name: '构建&推送镜像', type: 'image', timeoutMin: 15, failurePolicy: 'abort', deps: ['unit-test', 'integration-test'], x: 500, y: 250 },
      { id: 'deploy-staging', name: '部署预发环境', type: 'deploy', timeoutMin: 10, failurePolicy: 'abort', deps: ['image'], x: 720, y: 250 },
      { id: 'gate-prod', name: '生产发布审批', type: 'gate', timeoutMin: 480, failurePolicy: 'abort', deps: ['deploy-staging'], x: 940, y: 250 },
      { id: 'deploy-prod', name: '部署生产环境', type: 'deploy', timeoutMin: 15, failurePolicy: 'abort', deps: ['gate-prod'], x: 1160, y: 250 },
    ],
  },
  {
    id: 'pl_frontend',
    name: '前端站点发布',
    description: 'web-portal：构建 → 单测/E2E（并行）→ 镜像 → 上线审批 → 生产节点 / CDN 刷新（并行）',
    stages: [
      { id: 'fe-build', name: 'Webpack 构建', type: 'build', timeoutMin: 15, failurePolicy: 'abort', deps: [], x: 60, y: 250 },
      { id: 'fe-unit', name: '单元测试', type: 'test', timeoutMin: 10, failurePolicy: 'abort', deps: ['fe-build'], x: 280, y: 110 },
      { id: 'fe-e2e', name: 'E2E 测试', type: 'test', timeoutMin: 30, failurePolicy: 'continue', deps: ['fe-build'], x: 280, y: 390 },
      { id: 'fe-image', name: '构建静态镜像', type: 'image', timeoutMin: 10, failurePolicy: 'abort', deps: ['fe-unit', 'fe-e2e'], x: 500, y: 250 },
      { id: 'fe-gate', name: '上线审批', type: 'gate', timeoutMin: 240, failurePolicy: 'abort', deps: ['fe-image'], x: 720, y: 250 },
      { id: 'fe-prod', name: '生产节点发布', type: 'deploy', timeoutMin: 10, failurePolicy: 'abort', deps: ['fe-gate'], x: 940, y: 130 },
      { id: 'fe-cdn', name: 'CDN 缓存刷新', type: 'deploy', timeoutMin: 10, failurePolicy: 'continue', deps: ['fe-gate'], x: 940, y: 370 },
    ],
  },
  {
    id: 'pl_infra',
    name: '基础设施变更',
    description: 'Terraform：计划 → 合规检查/安全扫描（并行，扫描失败可继续）→ 镜像 → 变更审批 → 灰度 → 全量',
    stages: [
      { id: 'cfg-build', name: 'Terraform Plan', type: 'build', timeoutMin: 10, failurePolicy: 'abort', deps: [], x: 60, y: 250 },
      { id: 'policy-test', name: '合规策略检查', type: 'test', timeoutMin: 10, failurePolicy: 'abort', deps: ['cfg-build'], x: 280, y: 110 },
      { id: 'sec-scan', name: '安全漏洞扫描', type: 'test', timeoutMin: 30, failurePolicy: 'continue', deps: ['cfg-build'], x: 280, y: 390 },
      { id: 'infra-image', name: 'AMI 镜像构建', type: 'image', timeoutMin: 20, failurePolicy: 'abort', deps: ['policy-test', 'sec-scan'], x: 500, y: 250 },
      { id: 'gate-change', name: '变更窗口审批', type: 'gate', timeoutMin: 360, failurePolicy: 'abort', deps: ['infra-image'], x: 720, y: 250 },
      { id: 'deploy-gray', name: '灰度发布 10%', type: 'deploy', timeoutMin: 15, failurePolicy: 'abort', deps: ['gate-change'], x: 940, y: 250 },
      { id: 'deploy-full', name: '全量发布', type: 'deploy', timeoutMin: 20, failurePolicy: 'abort', deps: ['deploy-gray'], x: 1160, y: 250 },
    ],
  },
];

const FAIL_REASONS = {
  build: '构建失败：编译错误 / 依赖拉取超时',
  test: '断言失败，详见测试报告',
  image: '镜像推送失败：registry 连接超时',
  deploy: '部署失败：健康检查未通过',
  gate: '人工审批驳回：不在变更窗口内',
};

const PEOPLE = ['林晓', '赵启航', '陈墨', '周雨桐', '王诤', '李棠'];
const TRIGGERS = ['manual', 'webhook', 'schedule'];

/** 每条规格：[流水线下标, 开始于几小时前, 结果, 失败阶段(可空), 附加] */
const SPECS = [
  [0, 0.3, 'success'],
  [2, 1.2, 'waiting', null, { gateStage: 'gate-change', gateHours: 1.0 }],
  [1, 2.0, 'success'],
  [0, 3.5, 'failed', 'unit-test'],
  [2, 5.0, 'success'],
  [0, 6.5, 'running', null, { through: 'image' }],
  [0, 26.0, 'waiting', null, { gateStage: 'gate-prod', gateHours: 25.5 }],
  [1, 28.0, 'success'],
  [2, 30.0, 'failed', 'policy-test'],
  [0, 49.0, 'success'],
  [1, 52.0, 'success'],
  [2, 55.0, 'waiting', null, { gateStage: 'gate-change', gateHours: 6.2 }],
  [1, 72.0, 'failed', 'fe-prod'],
  [0, 76.0, 'success'],
  [2, 98.0, 'success'],
  [0, 102.0, 'success'],
  [1, 124.0, 'success'],
  [2, 128.0, 'failed', 'gate-change'],
  [0, 148.0, 'success'],
  [1, 152.0, 'failed', 'fe-e2e'],
  [2, 172.0, 'success'],
  [0, 178.0, 'success'],
  [1, 196.0, 'success'],
];

function stageDurationSec(stage, seed) {
  const ranges = {
    build: [120, 260],
    test: [90, 340],
    image: [60, 150],
    deploy: [40, 130],
    gate: [240, 1400],
  };
  const [lo, hi] = ranges[stage.type];
  return Math.round(pseudo(seed, lo, hi));
}

/** 按拓扑层级算出每个阶段的起止偏移（秒），同层并行取 max。 */
function buildTimings(pipeline, seed) {
  const byId = new Map(pipeline.stages.map((s) => [s.id, s]));
  const start = new Map();
  const end = new Map();
  const visit = (id) => {
    if (start.has(id)) return;
    const s = byId.get(id);
    let st = 0;
    for (const dep of s.deps) {
      visit(dep);
      st = Math.max(st, end.get(dep));
    }
    start.set(id, st);
    end.set(id, st + stageDurationSec(s, seed + id.length * 13));
  };
  pipeline.stages.forEach((s) => visit(s.id));
  return { start, end };
}

function makeRun(spec, idx) {
  const [plIdx, hoursAgo, outcome, failStageId, extra] = spec;
  const pipeline = PIPELINES[plIdx];
  const now = Date.now();
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  // 锚定“今天”：无论当前几点（含刚过零点），今日记录都落在 [今天00:00, 两分钟前] 区间内
  let startedAt = now - Math.round(hoursAgo * HOUR);
  const lower = dayStart.getTime() + 30 * 1000;
  const upper = now - 120 * 1000;
  if (hoursAgo < 24) startedAt = Math.min(Math.max(startedAt, lower), upper);
  const seedBase = idx * 17 + plIdx * 101 + 3;

  const run = {
    id: rid('run'),
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    trigger: TRIGGERS[idx % TRIGGERS.length],
    triggeredBy: PEOPLE[idx % PEOPLE.length],
    status: outcome,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationSec: null,
    commit: {
      sha: crypto.createHash('sha1').update(`xuliu-${idx}`).digest('hex').slice(0, 8),
      message: ['feat: 合并支付回调重试', 'fix: 登录态过期刷新', 'chore: 升级基础镜像', 'refactor: 拆分订单聚合根'][idx % 4],
    },
    stages: [],
    waitingGate: null,
    createdAt: new Date(startedAt).toISOString(),
  };

  const { start, end } = buildTimings(pipeline, seedBase);
  const byId = new Map(pipeline.stages.map((s) => [s.id, s]));

  // waiting：卡点的上游全部成功，卡点 waiting，卡点下游 pending
  if (outcome === 'waiting') {
    const gateId = extra.gateStage;
    const gateSince = Math.max(now - Math.round(extra.gateHours * HOUR), startedAt + 60 * 1000);
    for (const s of pipeline.stages) {
      if (s.id === gateId) {
        run.stages.push(mkStage(s, 'waiting', null, null, null, `已等待 ${extra.gateHours.toFixed(1)} 小时，等待审批`));
      } else if (isDownstreamOf(byId, gateId, s.id)) {
        run.stages.push(mkStage(s, 'pending'));
      } else {
        const st = startedAt + start.get(s.id) * 1000;
        const en = st + stageDurationSec(s, seedBase + s.id.length * 13) * 1000;
        run.stages.push(mkStage(s, 'success', st, en, Math.round((en - st) / 1000)));
      }
    }
    run.waitingGate = { stageId: gateId, stageName: byId.get(gateId).name, since: new Date(gateSince).toISOString() };
    return run;
  }

  // running：through 阶段之前成功，through 当前 running，其余 pending
  if (outcome === 'running') {
    const throughId = extra.through;
    for (const s of pipeline.stages) {
      if (s.id === throughId) {
        run.stages.push(mkStage(s, 'running', startedAt + start.get(s.id) * 1000, null, Math.round((now - startedAt) / 1000) - start.get(s.id) * 1000 > 0 ? Math.round((now - startedAt) / 1000) - start.get(s.id) * 1000 : 30));
      } else if (isReachableBefore(byId, throughId, s.id)) {
        const st = startedAt + start.get(s.id) * 1000;
        const en = st + stageDurationSec(s, seedBase + s.id.length * 13) * 1000;
        run.stages.push(mkStage(s, 'success', st, en, Math.round((en - st) / 1000)));
      } else {
        run.stages.push(mkStage(s, 'pending'));
      }
    }
    return run;
  }

  // finished（success / failed）
  for (const s of pipeline.stages) {
    if (s.id === failStageId) {
      const st = startedAt + start.get(s.id) * 1000;
      const dur = Math.round(stageDurationSec(s, seedBase + s.id.length * 13) * 0.6);
      run.stages.push(mkStage(s, 'failed', st, st + dur * 1000, dur, FAIL_REASONS[s.type]));
      continue;
    }
    if (failStageId && isDownstreamOf(byId, failStageId, s.id)) {
      const failed = byId.get(failStageId);
      if (failed.failurePolicy === 'abort') {
        run.stages.push(mkStage(s, 'skipped', null, null, null, `上游阶段「${failed.name}」失败，失败策略为中止`));
        continue;
      }
    }
    const st = startedAt + start.get(s.id) * 1000;
    let en = st + stageDurationSec(s, seedBase + s.id.length * 13) * 1000;
    const stageRec = mkStage(s, 'success', st, en, Math.round((en - st) / 1000));
    if (s.type === 'gate') {
      stageRec.reason = `人工审批通过（${PEOPLE[(idx + 2) % PEOPLE.length]}）`;
    }
    run.stages.push(stageRec);
  }

  const lastEnd = Math.max(
    ...run.stages.filter((x) => x.finishedAt).map((x) => new Date(x.finishedAt).getTime())
  );
  run.finishedAt = new Date(lastEnd).toISOString();
  run.durationSec = Math.round((lastEnd - startedAt) / 1000);
  return run;
}

function mkStage(s, status, st, en, dur, reason) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    timeoutMin: s.timeoutMin,
    failurePolicy: s.failurePolicy,
    status,
    startedAt: st ? new Date(st).toISOString() : null,
    finishedAt: en ? new Date(en).toISOString() : null,
    durationSec: dur ?? null,
    reason: reason || null,
  };
}

/** target 是否在 from 的下游（沿 deps 反向边可达）。 */
function isDownstreamOf(byId, from, target) {
  if (from === target) return false;
  const seen = new Set();
  const walk = (id) => {
    for (const s of byId.values()) {
      if (s.deps.includes(id) && !seen.has(s.id)) {
        seen.add(s.id);
        walk(s.id);
      }
    }
  };
  walk(from);
  return seen.has(target);
}

/** target 是否为 through 的上游（沿 deps 正向可达）。 */
function isReachableBefore(byId, through, target) {
  // target 是 through 的上游
  if (through === target) return false;
  const seen = new Set();
  const walk = (id) => {
    const node = byId.get(id);
    for (const dep of node.deps) {
      if (!seen.has(dep)) { seen.add(dep); walk(dep); }
    }
  };
  walk(through);
  return seen.has(target);
}

function generate() {
  for (const p of PIPELINES) {
    validateStages(p.stages); // 种子数据自身必须无环
    p.createdAt = new Date(Date.now() - 20 * 24 * HOUR).toISOString();
    p.updatedAt = new Date(Date.now() - 2 * HOUR).toISOString();
  }
  const runs = SPECS.map((spec, i) => makeRun(spec, i));
  return {
    pipelines: PIPELINES,
    runs,
    meta: { seededAt: new Date().toISOString(), version: 1 },
  };
}

function seed(force) {
  if (fs.existsSync(store.DATA_FILE) && !force) {
    console.log(`[seed] 数据文件已存在：${store.DATA_FILE}（加 --force 覆盖）`);
    return false;
  }
  const data = generate();
  store.replaceAll(data);
  console.log(`[seed] 已写入 ${data.pipelines.length} 条流水线、${data.runs.length} 条执行记录 -> ${store.DATA_FILE}`);
  return true;
}

if (require.main === module) {
  seed(process.argv.includes('--force'));
}

module.exports = { generate, seed, PIPELINES };
