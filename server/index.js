'use strict';

/**
 * 序流 HTTP 服务（零依赖）。
 * 路由：
 *   GET    /api/meta                        常量（阶段类型、失败策略、卡点阈值）
 *   GET    /api/pipelines                   流水线列表（含阶段）
 *   POST   /api/pipelines                   新建（DAG 校验，环会被拦截并返回环路径）
 *   GET    /api/pipelines/:id               详情
 *   PUT    /api/pipelines/:id               更新（同样做 DAG 校验）
 *   DELETE /api/pipelines/:id               删除
 *   GET    /api/runs?pipelineId=&limit=     执行记录
 *   POST   /api/pipelines/:id/trigger       触发一次执行（模拟）
 *   POST   /api/runs/:id/approve            人工卡点：通过 / 驳回
 *   GET    /api/stats/overview              仪表盘 KPI + 趋势 + 卡点红灯
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const store = require('./store');
const { validateStages, ValidationError, STAGE_TYPES, FAILURE_POLICIES, topoSort } = require('./dag');

const PORT = Number(process.env.PORT || 8130);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/** 人工卡点超过该小时数即红灯（仪表盘可临时覆盖）。 */
const GATE_RED_HOURS = Number(process.env.GATE_RED_HOURS || 4);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 2_000_000) reject(new ValidationError('请求体过大'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ValidationError('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const rid = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;

// ---------- 流水线 ----------

function listPipelines() {
  const db = store.load();
  return db.pipelines.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || '',
    stageCount: p.stages.length,
    gateCount: p.stages.filter((s) => s.type === 'gate').length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }));
}

function getPipeline(id) {
  return store.load().pipelines.find((p) => p.id === id) || null;
}

function normalizePipelineInput(body, existing) {
  const name = String(body.name || '').trim();
  if (!name) throw new ValidationError('流水线名称不能为空');
  if (name.length > 60) throw new ValidationError('流水线名称不能超过 60 个字符');

  const { stages } = validateStages(body.stages);
  if (stages.length > 50) throw new ValidationError('单条流水线阶段数不能超过 50');

  return {
    id: existing ? existing.id : rid('pl'),
    name,
    description: String(body.description || '').slice(0, 300),
    stages,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ---------- 执行（模拟引擎） ----------

function simulateRun(pipeline, trigger = 'manual', operator = '当前用户') {
  const now = Date.now();
  const startedAt = new Date(now).toISOString();

  // 触发后流水线停在第一个人工卡点等待审批；无卡点则整条直接成功。
  const stages = pipeline.stages.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    timeoutMin: s.timeoutMin,
    failurePolicy: s.failurePolicy,
    status: 'pending',
    startedAt: null,
    finishedAt: null,
    durationSec: null,
    reason: null,
  }));

  const byId = new Map(pipeline.stages.map((s) => [s.id, s]));

  const durationOf = (s) => {
    const base = { build: 200, test: 240, image: 90, deploy: 70, gate: 0 }[s.type] || 120;
    return base + (crypto.randomBytes(1).readUInt8(0) % 90);
  };

  // 按拓扑序、逐阶段模拟：首个卡点之前全部成功，卡点 waiting，卡点下游保持 pending。
  const order = topoSort(pipeline.stages) || pipeline.stages.map((s) => s.id);
  const firstGate = order.map((id) => byId.get(id)).find((s) => s.type === 'gate') || null;
  const recById = new Map(stages.map((s) => [s.id, s]));
  let cursor = now;
  let waitingGate = null;

  for (const id of order) {
    const rec = recById.get(id);
    const def = byId.get(id);
    if (firstGate && isDownstream(byId, firstGate.id, id)) {
      continue; // 卡点尚未通过，下游不动
    }
    if (firstGate && id === firstGate.id) {
      rec.status = 'waiting';
      rec.startedAt = new Date(cursor).toISOString();
      rec.reason = '等待人工审批';
      waitingGate = { stageId: rec.id, stageName: rec.name, since: new Date(cursor).toISOString() };
      continue;
    }
    const dur = durationOf(def);
    rec.status = 'success';
    rec.startedAt = new Date(cursor).toISOString();
    rec.finishedAt = new Date(cursor + dur * 1000).toISOString();
    rec.durationSec = dur;
    cursor += dur * 1000;
    if (def.type === 'gate') rec.reason = '人工审批通过（自动模拟）';
  }

  const finished = !firstGate;
  const run = {
    id: rid('run'),
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    trigger,
    triggeredBy: operator,
    status: finished ? 'success' : 'waiting',
    startedAt,
    finishedAt: finished ? new Date(cursor).toISOString() : null,
    durationSec: finished ? Math.round((cursor - now) / 1000) : null,
    commit: { sha: crypto.randomBytes(4).toString('hex'), message: '手动触发执行' },
    stages,
    waitingGate,
    createdAt: startedAt,
  };
  return run;
}

/** target 是否在 from 的下游（from 的边能否走到 target）。 */
function isDownstream(byId, from, target) {
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

function approveRun(run, body) {
  const decision = body.decision === 'reject' ? 'rejected' : 'approved';
  if (!run.waitingGate) throw new ValidationError('该执行当前没有等待中的人工卡点');
  const gate = run.stages.find((s) => s.id === run.waitingGate.stageId);
  if (!gate || gate.status !== 'waiting') throw new ValidationError('卡点状态异常');

  const now = new Date().toISOString();
  gate.finishedAt = now;
  gate.reason = decision === 'approved'
    ? `人工审批通过（${body.operator || '审批人'}）`
    : `人工审批驳回：${body.comment || '未填写原因'}`;

  if (decision === 'rejected') {
    gate.status = 'failed';
    // 驳回 = 中止：下游全部跳过
    for (const s of run.stages) {
      if (s.status === 'pending') {
        s.status = 'skipped';
        s.reason = `人工卡点「${gate.name}」被驳回，流水线中止`;
      }
    }
    run.status = 'failed';
    run.finishedAt = now;
  } else {
    gate.status = 'success';
    // 模拟：通过后下游全部成功跑完
    const pipeline = getPipeline(run.pipelineId);
    const byId = new Map((pipeline?.stages || []).map((s) => [s.id, s]));
    let cursor = Date.now();
    for (const s of run.stages) {
      if (s.status === 'pending') {
        const def = byId.get(s.id);
        const dur = def ? { build: 200, test: 240, image: 90, deploy: 70 }[def.type] || 120 : 60;
        s.status = 'success';
        s.startedAt = new Date(cursor).toISOString();
        s.finishedAt = new Date(cursor + dur * 1000).toISOString();
        s.durationSec = dur;
        cursor += dur * 1000;
      }
    }
    run.status = 'success';
    run.finishedAt = new Date(cursor).toISOString();
    run.durationSec = Math.round((cursor - new Date(run.startedAt).getTime()) / 1000);
  }
  run.waitingGate = null;
  return run;
}

// ---------- 仪表盘统计 ----------

function startOfToday(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

function buildStats(redHours) {
  const db = store.load();
  const now = Date.now();
  const todayStart = startOfToday();

  const todayRuns = db.runs.filter((r) => new Date(r.startedAt).getTime() >= todayStart);
  const finishedToday = todayRuns.filter((r) => ['success', 'failed'].includes(r.status));
  const successToday = finishedToday.filter((r) => r.status === 'success');
  const avgDur = finishedToday.length
    ? Math.round(finishedToday.reduce((a, r) => a + (r.durationSec || 0), 0) / finishedToday.length)
    : 0;

  // 近 7 天趋势
  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const dayStart = todayStart - i * 86400000;
    const dayEnd = dayStart + 86400000;
    const list = db.runs.filter((r) => {
      const t = new Date(r.startedAt).getTime();
      return t >= dayStart && t < dayEnd;
    });
    const fin = list.filter((r) => ['success', 'failed'].includes(r.status));
    trend.push({
      date: new Date(dayStart).toISOString().slice(0, 10),
      total: list.length,
      success: fin.filter((r) => r.status === 'success').length,
      failed: fin.filter((r) => r.status === 'failed').length,
      waiting: list.filter((r) => r.status === 'waiting').length,
      running: list.filter((r) => r.status === 'running').length,
    });
  }

  // 人工卡点红灯
  const thresholdMs = redHours * 3600000;
  const redGates = db.runs
    .filter((r) => r.status === 'waiting' && r.waitingGate)
    .map((r) => {
      const since = new Date(r.waitingGate.since).getTime();
      const waitHours = (now - since) / 3600000;
      return {
        runId: r.id,
        pipelineId: r.pipelineId,
        pipelineName: r.pipelineName,
        stageId: r.waitingGate.stageId,
        stageName: r.waitingGate.stageName,
        since: r.waitingGate.since,
        waitHours: Math.round(waitHours * 10) / 10,
        triggeredBy: r.triggeredBy,
        over: waitHours >= redHours,
      };
    })
    .sort((a, b) => b.waitHours - a.waitHours);

  const overGates = redGates.filter((g) => g.over);

  // 全量成功率（近 30 天，作为副指标）
  const since30 = now - 30 * 86400000;
  const runs30 = db.runs.filter((r) => new Date(r.startedAt).getTime() >= since30 && ['success', 'failed'].includes(r.status));
  const successRate30 = runs30.length
    ? Math.round((runs30.filter((r) => r.status === 'success').length / runs30.length) * 1000) / 10
    : 100;

  return {
    generatedAt: new Date().toISOString(),
    gateRedHours: redHours,
    today: {
      total: todayRuns.length,
      finished: finishedToday.length,
      success: successToday.length,
      failed: finishedToday.length - successToday.length,
      running: todayRuns.filter((r) => r.status === 'running').length,
      waiting: todayRuns.filter((r) => r.status === 'waiting').length,
      successRate: finishedToday.length
        ? Math.round((successToday.length / finishedToday.length) * 1000) / 10
        : 100,
      avgDurationSec: avgDur,
    },
    last30Days: { total: runs30.length, successRate: successRate30 },
    trend,
    gateAlerts: { redCount: overGates.length, waitingCount: redGates.length, items: redGates },
    totals: { pipelines: db.pipelines.length, runs: db.runs.length },
  };
}

// ---------- HTTP 路由 ----------

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method;

  if (parts[1] === 'meta' && method === 'GET') {
    return sendJson(res, 200, {
      stageTypes: STAGE_TYPES,
      failurePolicies: FAILURE_POLICIES,
      gateRedHours: GATE_RED_HOURS,
      stageTypeMeta: {
        build: { label: '构建', color: '#2a78d6', icon: '🔨' },
        test: { label: '单测', color: '#1baf7a', icon: '🧪' },
        image: { label: '镜像', color: '#eb6834', icon: '📦' },
        deploy: { label: '部署', color: '#eda100', icon: '🚀' },
        gate: { label: '人工卡点', color: '#d55181', icon: '✋' },
      },
    });
  }

  if (parts[1] === 'pipelines') {
    // /api/pipelines
    if (parts.length === 2) {
      if (method === 'GET') return sendJson(res, 200, { items: listPipelines() });
      if (method === 'POST') {
        const body = await readBody(req);
        const pl = normalizePipelineInput(body, null);
        if (store.load().pipelines.some((p) => p.name === pl.name)) {
          throw new ValidationError(`已存在同名流水线：${pl.name}`);
        }
        store.load().pipelines.push(pl);
        store.save();
        return sendJson(res, 201, pl);
      }
    }

    const id = parts[2];
    if (parts.length === 3 && id) {
      const pl = getPipeline(id);
      if (!pl) return sendJson(res, 404, { error: '流水线不存在' });
      if (method === 'GET') return sendJson(res, 200, pl);
      if (method === 'PUT') {
        const body = await readBody(req);
        const updated = normalizePipelineInput(body, pl);
        const db = store.load();
        if (db.pipelines.some((p) => p.name === updated.name && p.id !== id)) {
          throw new ValidationError(`已存在同名流水线：${updated.name}`);
        }
        Object.assign(pl, updated);
        store.save();
        return sendJson(res, 200, pl);
      }
      if (method === 'DELETE') {
        const db = store.load();
        db.pipelines = db.pipelines.filter((p) => p.id !== id);
        store.save();
        return sendJson(res, 200, { ok: true });
      }
    }

    // /api/pipelines/:id/trigger
    if (parts.length === 4 && parts[3] === 'trigger' && method === 'POST') {
      const pl = getPipeline(id);
      if (!pl) return sendJson(res, 404, { error: '流水线不存在' });
      const body = await readBody(req).catch(() => ({}));
      const run = simulateRun(pl, body.trigger || 'manual', body.operator || '当前用户');
      store.load().runs.unshift(run);
      store.save();
      return sendJson(res, 201, run);
    }
  }

  if (parts[1] === 'runs') {
    if (parts.length === 2 && method === 'GET') {
      let items = store.load().runs;
      const pipelineId = url.searchParams.get('pipelineId');
      if (pipelineId) items = items.filter((r) => r.pipelineId === pipelineId);
      const status = url.searchParams.get('status');
      if (status) items = items.filter((r) => r.status === status);
      const limit = Math.min(Number(url.searchParams.get('limit') || 50), 200);
      items = items.slice(0, limit);
      return sendJson(res, 200, { items });
    }
    // /api/runs/:id/approve
    if (parts.length === 4 && parts[3] === 'approve' && method === 'POST') {
      const run = store.load().runs.find((r) => r.id === parts[2]);
      if (!run) return sendJson(res, 404, { error: '执行记录不存在' });
      const body = await readBody(req);
      approveRun(run, body);
      store.save();
      return sendJson(res, 200, run);
    }
  }

  if (parts[1] === 'stats' && parts[2] === 'overview' && method === 'GET') {
    const redHours = Number(url.searchParams.get('gateHours')) || GATE_RED_HOURS;
    return sendJson(res, 200, buildStats(redHours));
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------- 静态资源 ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  // 前端 SPA 式兜底：未知非 /api 路径回到 index.html
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); }
        else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      sendJson(res, err.statusCode, { error: err.message, details: err.details });
    } else {
      console.error('[server]', err);
      sendJson(res, 500, { error: '服务器内部错误', detail: err.message });
    }
  }
});

server.listen(PORT, () => {
  // 首次启动若数据文件不存在则自动播种
  if (!fs.existsSync(store.DATA_FILE)) {
    try {
      require('./seed').seed(true);
    } catch (err) {
      console.error('[seed] 自动播种失败：', err.message);
    }
  }
  console.log(`序流已启动：http://localhost:${PORT}`);
});

module.exports = { server, buildStats, simulateRun };
