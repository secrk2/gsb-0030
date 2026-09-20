'use strict';

/* ================= 序流 前端主逻辑 ================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.details = data.details;
    err.status = res.status;
    throw err;
  }
  return data;
};

const state = {
  meta: null,
  pipelines: [],
  selectedId: null,
  draft: null,           // 正在编辑的流水线（深拷贝）
  dirty: false,
  selectedStageId: null,
  cycle: null,           // 本地实时环检测结果
  runs: [],
  selectedRunId: null,
  gateHours: 4,
};

/* ---------------- 通用 UI ---------------- */

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtRelative(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}
function fmtDuration(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m} 分 ${s} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 小时 ${m % 60} 分`;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const STATUS_LABEL = { success: '成功', failed: '失败', waiting: '等待审批', running: '运行中', pending: '待执行', skipped: '已跳过' };
const STATUS_COLOR = {
  success: 'var(--ok)', failed: 'var(--danger)', waiting: 'var(--warn)',
  running: 'var(--series-blue)', pending: 'var(--muted)', skipped: 'var(--muted)',
};

/* ---------------- 视图切换 ---------------- */

$$('.nav-tab').forEach((btn) => btn.addEventListener('click', () => {
  const view = btn.dataset.view;
  if (view === 'editor' && state.dirty) {
    if (!confirm('当前流水线有未保存的修改，离开将丢失。确认切换？')) return;
    state.dirty = false;
  }
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', b === btn));
  $('#view-editor').classList.toggle('hidden', view !== 'editor');
  $('#view-dashboard').classList.toggle('hidden', view !== 'dashboard');
  if (view === 'dashboard') loadDashboard();
}));

/* ---------------- 左侧流水线列表 ---------------- */

async function loadPipelines(selectId) {
  const { items } = await api('/api/pipelines');
  state.pipelines = items;
  const list = $('#pipeline-list');
  list.innerHTML = '';
  for (const p of items) {
    const runs = await api(`/api/runs?pipelineId=${p.id}&limit=1`).catch(() => ({ items: [] }));
    const last = runs.items[0];
    const btn = document.createElement('button');
    btn.dataset.id = p.id;
    btn.className = `pl-card ${p.id === state.selectedId ? 'active' : ''}`;
    btn.innerHTML = `
      <span class="pl-name">
        <span class="pl-status-dot" style="background:${last ? STATUS_COLOR[last.status] : 'var(--border-strong)'}"></span>
        ${esc(p.name)}
      </span>
      <span class="pl-desc">${esc(p.description || '暂无描述')}</span>
      <span class="pl-meta">
        <span class="tag">${p.stageCount} 阶段</span>
        ${p.gateCount ? `<span class="tag">${p.gateCount} 卡点</span>` : ''}
        ${last ? `<span class="tag">${STATUS_LABEL[last.status] || last.status}</span>` : ''}
      </span>`;
    btn.addEventListener('click', () => selectPipeline(p.id));
    list.appendChild(btn);
  }
  $('#pipeline-count').textContent = `共 ${items.length} 条流水线`;
  if (selectId) await selectPipeline(selectId);
  else if (!state.selectedId && items.length) await selectPipeline(items[0].id);
}

async function selectPipeline(id) {
  if (state.dirty && !confirm('当前修改尚未保存，切换将丢失。是否继续？')) return;
  const pl = await api(`/api/pipelines/${id}`);
  state.selectedId = id;
  state.draft = structuredClone(pl);
  state.dirty = false;
  state.selectedStageId = null;
  state.cycle = null;
  $('#canvas-hint').classList.add('hidden');
  $$('.pl-card').forEach((c) => c.classList.toggle('active', c.dataset.id === pl.id));
  $('#btn-add-stage').disabled = false;
  $('#btn-auto-layout').disabled = false;
  $('#btn-trigger').disabled = false;
  $('#btn-save').disabled = false;
  $('#canvas-pipeline-name').textContent = pl.name;
  $('#canvas-pipeline-desc').textContent = pl.description || '';
  $('#run-badge').classList.add('hidden');
  switchRightTab('props');
  renderCanvas();
  renderProps();
  loadRuns();
}

$('#btn-new-pipeline').addEventListener('click', async () => {
  const n = state.pipelines.length + 1;
  const body = {
    name: `新流水线 ${n}`,
    description: '从一个构建阶段开始，拖拽圆点连线编排依赖',
    stages: [{ id: 'start', name: '开始构建', type: 'build', timeoutMin: 20, failurePolicy: 'abort', deps: [], x: 80, y: 220 }],
  };
  try {
    const pl = await api('/api/pipelines', { method: 'POST', body });
    toast('流水线已创建，拖圆点开始连线', 'success');
    await loadPipelines(pl.id);
  } catch (err) {
    toast(err.message, 'error');
  }
});

$('#btn-delete-pipeline').addEventListener('click', async () => {
  if (!state.draft) return;
  if (!confirm(`确认删除流水线「${state.draft.name}」？此操作不可恢复。`)) return;
  try {
    await api(`/api/pipelines/${state.selectedId}`, { method: 'DELETE' });
    toast('流水线已删除', 'success');
    state.draft = null;
    state.selectedId = null;
    state.dirty = false;
    await loadPipelines();
    if (!state.pipelines.length) {
      $('#canvas-pipeline-name').textContent = '请选择流水线';
      $('#canvas-pipeline-desc').textContent = '';
      $('#canvas-hint').classList.remove('hidden');
      nodeLayer.innerHTML = '';
      edgeLayer.innerHTML = '';
      for (const id of ['btn-add-stage', 'btn-auto-layout', 'btn-trigger', 'btn-save']) $(`#${id}`).disabled = true;
    }
  } catch (err) { toast(err.message, 'error'); }
});

/* ================= DAG 画布 ================= */

const viewport = $('#canvas-viewport');
const nodeLayer = $('#node-layer');
const edgeLayer = $('#edge-layer');
const edgeSvg = $('#edge-svg');
const edgeDraft = $('#edge-draft');
const NODE_W = 168;

function typeMeta(type) {
  return state.meta.stageTypeMeta[type] || { label: type, color: '#888', icon: '•' };
}

/** 与后端一致的环检测；返回 [id...首尾重复] 或 null */
function detectCycle(stages) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(stages.map((s) => [s.id, WHITE]));
  const stack = [], pos = new Map();
  const dfs = (u) => {
    color.set(u, GRAY); pos.set(u, stack.length); stack.push(u);
    for (const s of stages) {
      if (!s.deps.includes(u)) continue;
      const v = s.id;
      if (color.get(v) === GRAY) return [...stack.slice(pos.get(v)), v];
      if (color.get(v) === WHITE) { const f = dfs(v); if (f) return f; }
    }
    stack.pop(); pos.delete(u); color.set(u, BLACK);
    return null;
  };
  for (const s of stages) if (color.get(s.id) === WHITE) { const f = dfs(s.id); if (f) return f; }
  return null;
}

function recomputeCycle() {
  state.cycle = detectCycle(state.draft.stages);
  const banner = $('#cycle-banner');
  if (state.cycle) {
    const names = state.cycle.map((id) => state.draft.stages.find((s) => s.id === id)?.name || id);
    banner.innerHTML = `⛔ 检测到环形依赖：<strong>${names.join(' → ')}</strong>。请删除环上的一条连线，否则无法保存。`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

function markDirty() {
  state.dirty = true;
  recomputeCycle();
  redrawEdges();
}

function renderCanvas() {
  recomputeCycle();
  nodeLayer.innerHTML = '';
  const cycleSet = new Set(state.cycle || []);

  for (const stage of state.draft.stages) {
    const meta = typeMeta(stage.type);
    const node = document.createElement('div');
    node.className = `node ${stage.type === 'gate' ? 'gate' : ''} ${stage.id === state.selectedStageId ? 'selected' : ''} ${cycleSet.has(stage.id) ? 'cycle-hit' : ''}`;
    node.dataset.stageId = stage.id;
    node.style.left = `${stage.x}px`;
    node.style.top = `${stage.y}px`;
    node.style.setProperty('--type-color', meta.color);
    node.innerHTML = `
      <div class="node-head" style="background:${meta.color}">
        <span>${meta.icon}</span>
        <span class="node-type">${esc(stage.name)}</span>
      </div>
      <div class="node-body">
        <div class="node-meta"><span>${meta.label}</span><span>⏱ ${stage.timeoutMin} 分</span></div>
        <div class="node-policy">失败：${stage.failurePolicy === 'abort' ? '中止流水线' : '继续执行'}</div>
      </div>
      <span class="port port-in" data-port="in" title="依赖入口（连线从上游节点拖入）"></span>
      <span class="port port-out" data-port="out" title="按住拖到下游节点连线"></span>`;
    nodeLayer.appendChild(node);
  }

  sizeCanvas();
  redrawEdges();
}

function sizeCanvas() {
  let maxX = 900, maxY = 560;
  for (const stage of state.draft.stages) {
    maxX = Math.max(maxX, stage.x + NODE_W + 120);
    const el = nodeLayer.querySelector(`[data-stage-id="${CSS.escape(stage.id)}"]`);
    maxY = Math.max(maxY, stage.y + (el?.offsetHeight || 90) + 120);
  }
  edgeSvg.setAttribute('width', maxX);
  edgeSvg.setAttribute('height', maxY);
  edgeSvg.style.width = `${maxX}px`;
  edgeSvg.style.height = `${maxY}px`;
  nodeLayer.style.width = `${maxX}px`;
  nodeLayer.style.height = `${maxY}px`;
}

function nodeCenter(stage) {
  const el = nodeLayer.querySelector(`[data-stage-id="${CSS.escape(stage.id)}"]`);
  const h = el?.offsetHeight || 70;
  return { x: stage.x, y: stage.y, w: NODE_W, h, right: { x: stage.x + NODE_W, y: stage.y + h / 2 }, left: { x: stage.x, y: stage.y + h / 2 } };
}

function edgePath(x1, y1, x2, y2) {
  const dx = Math.max(42, Math.abs(x2 - x1) * 0.45);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

function redrawEdges() {
  edgeLayer.replaceChildren();
  if (!state.draft) return;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const byId = new Map(state.draft.stages.map((s) => [s.id, s]));
  const cycleEdges = new Set();
  if (state.cycle) {
    for (let i = 0; i < state.cycle.length - 1; i++) cycleEdges.add(`${state.cycle[i]}-->${state.cycle[i + 1]}`);
  }

  for (const stage of state.draft.stages) {
    for (const depId of stage.deps) {
      const dep = byId.get(depId);
      if (!dep) continue;
      const a = nodeCenter(dep);   // 上游：右端口出
      const b = nodeCenter(stage); // 下游：左端口入
      const d = edgePath(a.right.x, a.right.y, b.left.x, b.left.y);
      const g = document.createElementNS(SVGNS, 'g');
      const isCycle = cycleEdges.has(`${depId}-->${stage.id}`);

      const hit = document.createElementNS(SVGNS, 'path');
      hit.setAttribute('class', 'edge-hit');
      hit.setAttribute('d', d);
      const vis = document.createElementNS(SVGNS, 'path');
      vis.setAttribute('class', `edge ${isCycle ? 'edge-cycle' : ''}`);
      vis.setAttribute('d', d);
      vis.setAttribute('marker-end', `url(#${isCycle ? 'arrow-cycle' : 'arrow'})`);
      g.append(hit, vis);

      g.addEventListener('click', () => {
        if (confirm(`删除依赖连线：${dep.name} → ${stage.name}？`)) {
          stage.deps = stage.deps.filter((x) => x !== depId);
          renderCanvas();
          renderProps();
          markDirty();
          toast(`已删除连线：${dep.name} → ${stage.name}`);
        }
      });
      edgeLayer.appendChild(g);
    }
  }
}

/* ---------- 节点拖动 + 端口拖线（指针事件） ---------- */

function canvasPoint(e) {
  const r = viewport.getBoundingClientRect();
  return { x: e.clientX - r.left + viewport.scrollLeft, y: e.clientY - r.top + viewport.scrollTop };
}

nodeLayer.addEventListener('pointerdown', (e) => {
  const portEl = e.target.closest('.port');
  const nodeEl = e.target.closest('.node');
  if (!nodeEl) return;
  const stage = state.draft.stages.find((s) => s.id === nodeEl.dataset.stageId);

  if (portEl?.dataset.port === 'out') {
    startEdgeDrag(e, stage, nodeEl);
    return;
  }
  startNodeDrag(e, stage, nodeEl);
});

function startNodeDrag(e, stage, nodeEl) {
  e.preventDefault();
  selectStage(stage.id);
  const start = canvasPoint(e);
  const ox = stage.x, oy = stage.y;
  let moved = false;
  nodeEl.setPointerCapture?.(e.pointerId);
  nodeEl.style.cursor = 'grabbing';

  const move = (ev) => {
    const p = canvasPoint(ev);
    const nx = Math.max(0, ox + p.x - start.x);
    const ny = Math.max(0, oy + p.y - start.y);
    if (Math.abs(nx - ox) + Math.abs(ny - oy) > 2) moved = true;
    stage.x = nx; stage.y = ny;
    nodeEl.style.left = `${nx}px`;
    nodeEl.style.top = `${ny}px`;
    redrawEdges();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    nodeEl.style.cursor = '';
    if (moved) markDirty();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function startEdgeDrag(e, source, sourceEl) {
  e.preventDefault();
  e.stopPropagation();
  const c0 = nodeCenter(source).right;
  edgeDraft.setAttribute('d', edgePath(c0.x, c0.y, c0.x + 10, c0.y));
  const move = (ev) => {
    const p = canvasPoint(ev);
    edgeDraft.setAttribute('d', edgePath(c0.x, c0.y, p.x, p.y));
    // 悬停目标高亮
    $$('.node').forEach((n) => n.classList.remove('drop-target'));
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    if (over && over.dataset.stageId !== source.id) over.classList.add('drop-target');
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    edgeDraft.setAttribute('d', '');
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.node');
    $$('.node').forEach((n) => n.classList.remove('drop-target'));
    if (!over) return;
    const targetId = over.dataset.stageId;
    if (targetId === source.id) return toast('不能连接到自身', 'error');
    const target = state.draft.stages.find((s) => s.id === targetId);
    if (target.deps.includes(source.id)) return toast('该连线已存在');
    target.deps.push(source.id);
    renderCanvas();
    renderProps();
    markDirty();
    if (state.cycle) toast('这条连线形成了环，已在画布标红，请删除', 'error');
    else toast(`已连线：${source.name} → ${target.name}`, 'success');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// 点击空白取消选择
viewport.addEventListener('pointerdown', (e) => {
  if (e.target === viewport || e.target === edgeSvg || e.target === nodeLayer) {
    selectStage(null);
  }
});

/* ---------- 工具栏 ---------- */

$('#btn-add-stage').addEventListener('click', () => {
  const ids = new Set(state.draft.stages.map((s) => s.id));
  let n = state.draft.stages.length + 1, id = `stage-${n}`;
  while (ids.has(id)) { n++; id = `stage-${n}`; }
  const stage = {
    id, name: `新阶段 ${n}`, type: 'build', timeoutMin: 15, failurePolicy: 'abort',
    deps: [], x: 120 + (n % 4) * 40, y: 80 + n * 40,
  };
  state.draft.stages.push(stage);
  renderCanvas();
  selectStage(id);
  markDirty();
});

$('#btn-auto-layout').addEventListener('click', () => {
  // 按最长依赖链分层，同层纵向铺开
  const byId = new Map(state.draft.stages.map((s) => [s.id, s]));
  const level = new Map();
  const visit = (id) => {
    if (level.has(id)) return level.get(id);
    let l = 0;
    for (const d of byId.get(id).deps) l = Math.max(l, visit(d) + 1);
    level.set(id, l); return l;
  };
  state.draft.stages.forEach((s) => visit(s.id));
  const cols = new Map();
  for (const s of state.draft.stages) {
    const l = level.get(s.id);
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l).push(s);
  }
  const COL_W = 230, ROW_H = 130, X0 = 70, Y0 = 80;
  for (const [l, arr] of cols) {
    arr.forEach((s, i) => { s.x = X0 + Number(l) * COL_W; s.y = Y0 + i * ROW_H; });
  }
  renderCanvas();
  markDirty();
  toast('已按依赖层级自动排版');
});

$('#btn-trigger').addEventListener('click', async () => {
  try {
    const run = await api(`/api/pipelines/${state.selectedId}/trigger`, { method: 'POST', body: { trigger: 'manual' } });
    toast(`已触发：执行 ${run.id.slice(-6)}，状态「${STATUS_LABEL[run.status]}」`, 'success');
    loadRuns();
  } catch (err) { toast(err.message, 'error'); }
});

$('#btn-save').addEventListener('click', async () => {
  if (state.cycle) { toast('存在环形依赖，无法保存。请先删除环上的连线', 'error'); return; }
  try {
    await api(`/api/pipelines/${state.selectedId}`, {
      method: 'PUT',
      body: {
        name: state.draft.name,
        description: state.draft.description,
        stages: state.draft.stages.map(({ id, name, type, timeoutMin, failurePolicy, deps, x, y }) =>
          ({ id, name, type, timeoutMin, failurePolicy, deps, x, y })),
      },
    });
    state.dirty = false;
    toast('编排已保存', 'success');
    const keep = state.selectedId;
    await loadPipelines(keep);
  } catch (err) {
    if (err.details?.code === 'CYCLE' && err.details.cycle) {
      state.cycle = err.details.cycle;
      renderCanvas();
    }
    toast(err.message, 'error');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});

/* ================= 右栏：属性 ================= */

function selectStage(id) {
  state.selectedStageId = id;
  $$('.node').forEach((n) => n.classList.toggle('selected', n.dataset.stageId === id));
  renderProps();
}

function renderProps() {
  const form = $('#stage-form');
  const empty = $('#props-empty');
  const metaBox = $('#pipeline-meta');
  const stage = state.draft?.stages.find((s) => s.id === state.selectedStageId);

  metaBox.classList.toggle('hidden', !!stage);
  if (!state.draft) {
    form.classList.add('hidden'); empty.classList.remove('hidden');
    return;
  }
  if (!stage) {
    form.classList.add('hidden');
    empty.classList.add('hidden');
    metaBox.classList.remove('hidden');
    $('#f-pl-name').value = state.draft.name;
    $('#f-pl-desc').value = state.draft.description || '';
    return;
  }
  empty.classList.add('hidden');
  form.classList.remove('hidden');

  const typeSel = $('#f-type');
  if (!typeSel.options.length) {
    for (const [key, m] of Object.entries(state.meta.stageTypeMeta)) {
      typeSel.add(new Option(`${m.icon} ${m.label}`, key));
    }
  }
  $('#f-name').value = stage.name;
  $('#f-type').value = stage.type;
  $('#f-timeout').value = stage.timeoutMin;
  $('#f-policy').value = stage.failurePolicy;
  renderDeps(stage);
}

function renderDeps(stage) {
  const box = $('#f-deps');
  box.innerHTML = '';
  if (!stage.deps.length) {
    box.innerHTML = '<span class="deps-empty">无前置依赖（从节点右侧圆点拖出连线）</span>';
    return;
  }
  const byId = new Map(state.draft.stages.map((s) => [s.id, s]));
  for (const depId of stage.deps) {
    const dep = byId.get(depId);
    const chip = document.createElement('span');
    chip.className = 'dep-chip';
    chip.innerHTML = `${esc(dep ? dep.name : depId)}<button title="移除依赖">×</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      stage.deps = stage.deps.filter((x) => x !== depId);
      renderCanvas(); markDirty(); renderProps();
    });
    box.appendChild(chip);
  }
}

$('#f-pl-name').addEventListener('input', (e) => {
  state.draft.name = e.target.value;
  $('#canvas-pipeline-name').textContent = e.target.value || '未命名流水线';
  state.dirty = true;
});
$('#f-pl-desc').addEventListener('input', (e) => {
  state.draft.description = e.target.value;
  $('#canvas-pipeline-desc').textContent = e.target.value;
  state.dirty = true;
});

$('#btn-apply-stage').addEventListener('click', () => {
  const stage = state.draft.stages.find((s) => s.id === state.selectedStageId);
  if (!stage) return;
  const name = $('#f-name').value.trim();
  if (!name) return toast('阶段名称不能为空', 'error');
  stage.name = name;
  stage.type = $('#f-type').value;
  stage.timeoutMin = Math.max(1, Number($('#f-timeout').value) || 15);
  stage.failurePolicy = $('#f-policy').value;
  renderCanvas();
  markDirty();
  toast('阶段属性已更新（记得保存编排）');
});

$('#btn-delete-stage').addEventListener('click', () => {
  const stage = state.draft.stages.find((s) => s.id === state.selectedStageId);
  if (!stage) return;
  if (!confirm(`删除阶段「${stage.name}」？相关连线会一并删除。`)) return;
  state.draft.stages = state.draft.stages.filter((s) => s.id !== stage.id);
  for (const s of state.draft.stages) s.deps = s.deps.filter((d) => d !== stage.id);
  state.selectedStageId = null;
  renderCanvas();
  renderProps();
  markDirty();
  toast('阶段已删除');
});

/* 右栏 tab 切换 */
function switchRightTab(name) {
  $$('.right-tab').forEach((b) => b.classList.toggle('active', b.dataset.rtab === name));
  $('#rtab-props').classList.toggle('hidden', name !== 'props');
  $('#rtab-runs').classList.toggle('hidden', name !== 'runs');
}
$$('.right-tab').forEach((b) => b.addEventListener('click', () => switchRightTab(b.dataset.rtab)));

/* ================= 右栏：执行记录 ================= */

async function loadRuns() {
  if (!state.selectedId) return;
  const { items } = await api(`/api/runs?pipelineId=${state.selectedId}&limit=30`);
  state.runs = items;
  const badge = $('#run-badge');
  badge.textContent = items.length;
  badge.classList.toggle('hidden', !items.length);
  renderRunsList();
  if (state.selectedRunId && items.some((r) => r.id === state.selectedRunId)) renderRunDetail();
  else { state.selectedRunId = null; $('#run-detail').classList.add('hidden'); }
}

function renderRunsList() {
  const box = $('#runs-list');
  box.innerHTML = '';
  if (!state.runs.length) { box.innerHTML = '<div class="empty-tip">暂无执行记录，点上方「触发运行」</div>'; return; }
  for (const run of state.runs) {
    const card = document.createElement('div');
    card.className = 'run-card';
    card.innerHTML = `
      <div class="rc-top">
        <span class="run-status ${run.status}">${STATUS_LABEL[run.status]}</span>
        <span class="muted">#${esc(run.id.slice(-6))}</span>
        <span class="rc-time">${fmtRelative(run.startedAt)}</span>
      </div>
      <div class="rc-meta">${esc(run.triggeredBy)} · ${esc(run.commit.sha)} · ${run.durationSec != null ? fmtDuration(run.durationSec) : '未结束'}</div>`;
    card.addEventListener('click', () => { state.selectedRunId = run.id; renderRunDetail(); });
    box.appendChild(card);
  }
}

function renderRunDetail() {
  const run = state.runs.find((r) => r.id === state.selectedRunId);
  const box = $('#run-detail');
  if (!run) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="small muted" style="margin-bottom:6px">${fmtTime(run.startedAt)} 触发 · ${esc(run.commit.message)}</div>
    ${run.stages.map((s) => `
      <div class="rd-stage">
        <span class="rd-dot" style="background:${STATUS_COLOR[s.status]}"></span>
        <span class="rd-name">${esc(s.name)}</span>
        <span class="run-status ${s.status}" style="font-size:10px">${STATUS_LABEL[s.status]}</span>
        <span class="rd-dur">${s.durationSec != null ? fmtDuration(s.durationSec) : ''}</span>
        ${s.reason ? `<div class="rd-reason">${esc(s.reason)}</div>` : ''}
      </div>`).join('')}
    <div class="rd-actions" id="rd-actions"></div>`;
  if (run.status === 'waiting') {
    const actions = $('#rd-actions', box);
    const ok = document.createElement('button');
    ok.className = 'btn btn-primary btn-sm';
    ok.textContent = '✓ 审批通过';
    ok.addEventListener('click', () => approve(run.id, { decision: 'approve', operator: '当前用户' }));
    const no = document.createElement('button');
    no.className = 'btn btn-danger-ghost btn-sm';
    no.textContent = '✗ 驳回';
    no.addEventListener('click', () => {
      const comment = prompt('驳回原因（将记录在执行历史中）', '不在变更窗口内');
      if (comment != null) approve(run.id, { decision: 'reject', comment, operator: '当前用户' });
    });
    actions.append(ok, no);
  }
}

async function approve(runId, body) {
  try {
    await api(`/api/runs/${runId}/approve`, { method: 'POST', body });
    toast('审批已提交', 'success');
    await loadRuns();
    await loadPipelines();
  } catch (err) { toast(err.message, 'error'); }
}

/* ================= 仪表盘 ================= */

async function loadDashboard() {
  if (!state.meta) return;
  try {
    const stats = await api(`/api/stats/overview?gateHours=${state.gateHours}`);
    renderDashboard(stats);
  } catch (err) { toast(err.message, 'error'); }
}

function renderDashboard(s) {
  const t = s.today;
  $('#kpi-total').textContent = t.total;
  $('#kpi-total-sub').textContent = `运行中 ${t.running} · 等待 ${t.waiting} · 失败 ${t.failed}`;
  $('#kpi-rate').textContent = `${t.successRate}%`;
  $('#kpi-rate-sub').textContent = `今日完成 ${t.finished} 次，成功 ${t.success} 次 · 近30天 ${s.last30Days.successRate}%`;
  $('#kpi-avg').textContent = fmtDuration(t.avgDurationSec);
  $('#kpi-avg-sub').textContent = `按今日 ${t.finished} 条已完成记录统计`;
  $('#thr-hint').textContent = `（> ${s.gateRedHours} 小时）`;

  const gateTile = $('#kpi-gate-tile');
  $('#kpi-gates').textContent = s.gateAlerts.redCount;
  gateTile.classList.toggle('red', s.gateAlerts.redCount > 0);
  $('#kpi-gates-sub').textContent = s.gateAlerts.redCount > 0
    ? `${s.gateAlerts.redCount} 个人工卡点超时未处理，另有 ${s.gateAlerts.waitingCount - s.gateAlerts.redCount} 个等待中`
    : `当前 ${s.gateAlerts.waitingCount} 个卡点等待中，均未超阈值`;

  renderTrend(s.trend);
  renderGates(s.gateAlerts.items, s.gateRedHours);
  renderRecentRuns();
}

function renderTrend(trend) {
  const maxTotal = Math.max(1, ...trend.map((d) => d.total));
  const H = 150;
  const box = $('#trend-chart');
  box.innerHTML = `
    <div class="chart-legend">
      <span class="lg-item"><span class="lg-swatch" style="background:var(--series-aqua)"></span>成功</span>
      <span class="lg-item"><span class="lg-swatch" style="background:var(--danger)"></span>失败</span>
      <span class="lg-item"><span class="lg-swatch" style="background:var(--warn)"></span>等待审批</span>
      <span class="lg-item"><span class="lg-swatch" style="background:var(--series-blue)"></span>运行中</span>
    </div>
    <div class="trend-bars">
      ${trend.map((d, i) => {
        const segs = [
          ['success', d.success], ['failed', d.failed], ['waiting', d.waiting], ['running', d.running],
        ].filter(([, v]) => v > 0);
        const heightPct = (d.total / maxTotal) * 100;
        const date = new Date(d.date);
        const label = i === trend.length - 1 ? '今天' : `${date.getMonth() + 1}/${date.getDate()}`;
        return `
          <div class="tb-col" data-tip='${d.date}：共 ${d.total} 次（成功 ${d.success} / 失败 ${d.failed} / 等待 ${d.waiting} / 运行中 ${d.running}）'>
            <span class="tb-total">${d.total || ''}</span>
            <div class="tb-stack" style="height:${Math.max(d.total ? 6 : 0, (heightPct / 100) * H)}px">
              ${segs.map(([k, v]) => `<div class="tb-seg seg-${k}" style="flex:${v}" data-tip="${STATUS_LABEL[k]} ${v} 次"></div>`).join('')}
            </div>
            <span class="tb-day ${i === trend.length - 1 ? 'tb-today' : ''}">${label}</span>
          </div>`;
      }).join('')}
    </div>`;

  // 悬浮提示
  box.querySelectorAll('[data-tip]').forEach((el) => {
    el.addEventListener('mouseenter', (e) => showChartTip(el.dataset.tip, e));
    el.addEventListener('mouseleave', hideChartTip);
  });

  $('#trend-table').innerHTML = `
    <table>
      <thead><tr><th>日期</th><th>总数</th><th>成功</th><th>失败</th><th>等待</th><th>运行中</th><th>成功率</th></tr></thead>
      <tbody>${[...trend].reverse().map((d) => {
        const fin = d.success + d.failed;
        const rate = fin ? Math.round((d.success / fin) * 100) : 100;
        return `<tr><td>${i18nDate(d.date)}</td><td>${d.total}</td><td>${d.success}</td><td>${d.failed}</td><td>${d.waiting}</td><td>${d.running}</td><td>${rate}%</td></tr>`;
      }).join('')}</tbody>
    </table>`;
}

function i18nDate(iso) {
  const d = new Date(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((today - that) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '昨天';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

let tipEl = null;
function showChartTip(text, e) {
  hideChartTip();
  tipEl = document.createElement('div');
  tipEl.className = 'toast';
  tipEl.style.pointerEvents = 'none';
  tipEl.textContent = text;
  document.body.appendChild(tipEl);
  const r = tipEl.getBoundingClientRect();
  tipEl.style.left = `${Math.min(e.clientX + 12, window.innerWidth - r.width - 12)}px`;
  tipEl.style.top = `${e.clientY - r.height - 12}px`;
  tipEl.style.transform = 'none';
  tipEl.style.bottom = 'auto';
}
function hideChartTip() {
  tipEl?.remove();
  tipEl = null;
}

function renderGates(items, threshold) {
  $('#gates-summary').textContent = `阈值 ${threshold} 小时 · 共 ${items.length} 个等待卡点`;
  const box = $('#gates-list');
  if (!items.length) { box.innerHTML = '<div class="empty-tip">没有等待中的人工卡点 🎉</div>'; return; }
  box.innerHTML = items.map((g) => `
    <div class="gate-item ${g.over ? 'red' : 'warn'}">
      <div class="gi-top">
        <span class="${g.over ? 'red-lamp' : 'yellow-lamp'}"></span>
        ${g.over ? '红灯' : '等待中'}
        <span>${esc(g.pipelineName)} · ${esc(g.stageName)}</span>
        <span class="gi-wait">${g.waitHours} 小时</span>
      </div>
      <div class="gi-sub">
        <span>运行 #${esc(g.runId.slice(-6))} · 触发人 ${esc(g.triggeredBy)}</span>
        <span>进入卡点：${fmtTime(g.since)}（${fmtRelative(g.since)}）</span>
      </div>
    </div>`).join('');
}

async function renderRecentRuns() {
  const { items } = await api('/api/runs?limit=12');
  $('#recent-runs').innerHTML = `
    <table>
      <thead><tr><th>流水线</th><th>状态</th><th>触发</th><th>提交</th><th>开始时间</th><th class="num">时长</th></tr></thead>
      <tbody>${items.map((r) => `
        <tr>
          <td>${esc(r.pipelineName)}</td>
          <td><span class="run-status ${r.status}">${STATUS_LABEL[r.status]}</span></td>
          <td><span class="trigger-tag">${({ manual: '手动', webhook: 'Webhook', schedule: '定时' })[r.trigger] || r.trigger} · ${esc(r.triggeredBy)}</span></td>
          <td class="muted"><code>${esc(r.commit.sha)}</code> ${esc(r.commit.message)}</td>
          <td>${fmtTime(r.startedAt)} <span class="muted">(${fmtRelative(r.startedAt)})</span></td>
          <td class="num">${fmtDuration(r.durationSec)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

$('#gate-hours').addEventListener('change', (e) => {
  const v = Math.max(1, Math.min(168, Number(e.target.value) || 4));
  state.gateHours = v;
  e.target.value = v;
  loadDashboard();
});
$('#btn-refresh-dash').addEventListener('click', loadDashboard);

/* ---------------- 时钟 ---------------- */
function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
setInterval(tickClock, 1000);
tickClock();

/* ---------------- 启动 ---------------- */
(async function init() {
  state.meta = await api('/api/meta');
  state.gateHours = state.meta.gateRedHours;
  $('#gate-hours').value = state.gateHours;
  await loadPipelines();
})().catch((err) => toast(`初始化失败：${err.message}`, 'error'));
