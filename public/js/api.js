'use strict';

/* API 封装与共享常量 */

const API = {
  async req(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `请求失败（${res.status}）`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },
  listPipelines: () => API.req('GET', '/api/pipelines'),
  createPipeline: (body) => API.req('POST', '/api/pipelines', body),
  deletePipeline: (id) => API.req('DELETE', `/api/pipelines/${id}`),
  getGraph: (id) => API.req('GET', `/api/pipelines/${id}/graph`),
  saveGraph: (id, body) => API.req('PUT', `/api/pipelines/${id}/graph`, body),
  triggerRun: (id, body) => API.req('POST', `/api/pipelines/${id}/run`, body || {}),
  listRuns: (limit = 30) => API.req('GET', `/api/runs?limit=${limit}`),
  getRun: (id) => API.req('GET', `/api/runs/${id}`),
  cancelRun: (id) => API.req('POST', `/api/runs/${id}/cancel`),
  resolveGate: (runId, stageId, body) => API.req('POST', `/api/runs/${runId}/gate/${stageId}`, body),
  dashboard: (gateHours) => API.req('GET', `/api/dashboard?gateHours=${gateHours}`),
  health: () => API.req('GET', '/api/health'),
};

const TYPE_META = {
  build:       { label: '构建',     color: '#2a78d6' },
  unit_test:   { label: '单测',     color: '#eb6834' },
  image:       { label: '镜像',     color: '#1baf7a' },
  deploy:      { label: '部署',     color: '#eda100' },
  manual_gate: { label: '人工卡点', color: '#e87ba4' },
};
const TYPE_ORDER = ['build', 'unit_test', 'image', 'deploy', 'manual_gate'];

const FAIL_POLICY_META = {
  abort:    { label: '失败中止', hint: '该阶段失败后，其下游阶段全部跳过，整条流水线标记失败。' },
  continue: { label: '失败继续', hint: '该阶段失败不阻断下游，下游照常执行；整条流水线仍记为失败。' },
  retry:    { label: '失败重试', hint: '失败后自动重试指定次数；重试耗尽仍失败则按“失败中止”处理。' },
};

const STATUS_META = {
  success:       { label: '成功',   icon: '✓', cls: 'success' },
  failed:        { label: '失败',   icon: '✕', cls: 'failed' },
  running:       { label: '运行中', icon: '◌', cls: 'running' },
  waiting_gate:  { label: '待审批', icon: '⏸', cls: 'running' },
  skipped:       { label: '已跳过', icon: '↓', cls: 'canceled' },
  gate_rejected: { label: '已驳回', icon: '✕', cls: 'failed' },
  pending:       { label: '等待中', icon: '○', cls: 'canceled' },
  canceled:      { label: '已取消', icon: '⊘', cls: 'canceled' },
};

function fmtDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} 分 ${sec % 60} 秒`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}

function fmtRelative(dateStr) {
  const t = new Date(dateStr).getTime();
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return `${d} 天前`;
}

function fmtClock(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtWaiting(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h <= 0) return `${m} 分钟`;
  return `${h} 小时 ${m} 分`;
}

let toastTimer = null;
function toast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
}
