'use strict';

/* ============================================================
 * 流水线编排视图：左列表 + 中画布 + 右属性
 * ============================================================ */

const Orch = {
  pipelines: [],
  currentId: null,
  graph: null, // { stages:[{key,...}], edges:[{key,...}] }
  canvas: null,
  dirty: false,
  uid: 1,

  async init() {
    this.canvas = new DAGCanvas(document.getElementById('dag-svg'), {
      onSelectNode: (key) => this.renderProps(key),
      onSelectEdge: () => {},
      onConnect: (from, to) => this.addEdge(from, to),
      onDeleteEdge: (edgeKey) => this.deleteEdge(edgeKey),
      onMove: () => this.setDirty(true),
    });

    document.getElementById('btn-new-pipeline').addEventListener('click', () => this.newPipeline());
    document.getElementById('btn-add-stage').addEventListener('click', () => this.addStage());
    document.getElementById('btn-auto-layout').addEventListener('click', () => this.autoLayout());
    document.getElementById('btn-run').addEventListener('click', () => this.triggerRun());
    document.getElementById('btn-save').addEventListener('click', () => this.save());
    document.getElementById('btn-dismiss-cycle').addEventListener('click', () => {
      document.getElementById('cycle-banner').classList.add('hidden');
    });

    await this.loadPipelines();
  },

  async reload() {
    await this.loadPipelines();
    if (this.currentId) await this.openPipeline(this.currentId);
  },

  // ---------- 左：流水线列表 ----------
  async loadPipelines() {
    this.pipelines = await API.listPipelines();
    const list = document.getElementById('pipeline-list');
    list.innerHTML = '';
    for (const p of this.pipelines) {
      const btn = document.createElement('button');
      btn.className = 'pl-item' + (p.id === this.currentId ? ' active' : '');
      btn.innerHTML = `
        <div class="pl-name">
          <span class="status-dot ${p.last_status || 'canceled'}"></span>
          <span>${escapeHtml(p.name)}</span>
        </div>
        <div class="pl-desc">${escapeHtml(p.description || p.repo_url || '暂无描述')}</div>
        <div class="pl-meta">
          <span>${p.stage_count} 个阶段</span>
          <span>累计 ${p.run_count} 次运行</span>
        </div>`;
      btn.addEventListener('click', () => this.confirmOpen(p.id));
      list.appendChild(btn);
    }
    if (!this.currentId && this.pipelines[0]) this.openPipeline(this.pipelines[0].id);
  },

  confirmOpen(id) {
    if (this.dirty) {
      if (!confirm('当前编排尚未保存，切换将丢失改动，确定继续？')) return;
    }
    this.openPipeline(id);
  },

  async openPipeline(id) {
    this.currentId = id;
    document.getElementById('cycle-banner').classList.add('hidden');
    const raw = await API.getGraph(id);
    this.graph = {
      pipeline: raw.pipeline,
      stages: raw.stages.map((s) => ({
        key: `db-${s.id}`,
        id: s.id,
        name: s.name,
        type: s.type,
        timeoutSec: s.timeout_sec,
        failPolicy: s.fail_policy,
        retryTimes: s.retry_times,
        gateOwner: s.gate_owner,
        posX: s.pos_x,
        posY: s.pos_y,
      })),
      edges: raw.edges.map((e) => ({
        key: `e-${e.id}`,
        fromStageId: `db-${e.from_stage_id}`,
        toStageId: `db-${e.to_stage_id}`,
      })),
    };
    this.uid = 1;
    this.setDirty(false);
    this.canvas.clearCycle();
    this.canvas.setData(this.graph);
    this.updateChrome();
    this.renderProps(null);
    document.querySelectorAll('.pl-item').forEach((el, i) => el.classList.toggle('active', this.pipelines[i]?.id === id));
  },

  updateChrome() {
    const p = this.graph?.pipeline;
    document.getElementById('canvas-pipeline-name').textContent = p ? p.name : '请选择一条流水线';
    document.getElementById('canvas-pipeline-meta').textContent = p ? `${p.repo_url || ''} · ${p.branch || ''}` : '';
    document.getElementById('canvas-empty').style.display = this.graph ? 'none' : 'flex';
    for (const id of ['btn-add-stage', 'btn-auto-layout', 'btn-run', 'btn-save']) {
      document.getElementById(id).disabled = !this.graph;
    }
    document.getElementById('save-state').textContent = this.dirty ? '● 有未保存的改动' : '已保存';
  },

  async newPipeline() {
    const name = prompt('请输入新流水线名称：', '新流水线');
    if (!name || !name.trim()) return;
    const p = await API.createPipeline({ name: name.trim(), description: '', branch: 'main' });
    await this.loadPipelines();
    await this.openPipeline(p.id);
    toast('流水线已创建，请在画布上编排阶段');
  },

  // ---------- 画布操作 ----------
  addStage() {
    if (!this.graph) return;
    const n = this.graph.stages.length;
    const stage = {
      key: `new-${this.uid++}`,
      name: `新阶段 ${n + 1}`,
      type: 'build',
      timeoutSec: 1800,
      failPolicy: 'abort',
      retryTimes: 0,
      gateOwner: '',
      posX: 120 + (n % 4) * 40,
      posY: 120 + n * 36,
    };
    this.graph.stages.push(stage);
    this.canvas.setData(this.graph);
    this.canvas.selectNode(stage.key);
    this.renderProps(stage.key);
    this.setDirty(true);
  },

  addEdge(fromKey, toKey) {
    if (fromKey === toKey) return;
    this.canvas.clearCycle();
    if (this.graph.edges.some((e) => e.fromStageId === fromKey && e.toStageId === toKey)) {
      toast('该依赖连线已存在');
      return;
    }
    // 反向连线即时检测（保存时后端还会再兜一次并给出完整环）
    this.graph.edges.push({ key: `new-edge-${this.uid++}`, fromStageId: fromKey, toStageId: toKey });
    const localCycle = ClientDag.findCycle(this.graph.stages, this.graph.edges);
    if (localCycle) {
      this.graph.edges.pop();
      this.canvas.setCycle(localCycle);
      this.canvas.setData(this.graph);
      this.flashCycle(`连线将形成环：${localCycle.map((n) => n.name).join(' → ')}，已阻止`);
      return;
    }
    this.canvas.setData(this.graph);
    this.setDirty(true);
  },

  deleteEdge(edgeKey) {
    this.graph.edges = this.graph.edges.filter((e) => e.key !== edgeKey);
    this.canvas.selectedEdgeKey = null;
    this.canvas.clearCycle();
    this.canvas.setData(this.graph);
    this.setDirty(true);
  },

  deleteStage(key) {
    const s = this.graph.stages.find((x) => x.key === key);
    if (!s) return;
    if (!confirm(`确定删除阶段「${s.name}」？与其相连的依赖线会一并删除。`)) return;
    this.graph.stages = this.graph.stages.filter((x) => x.key !== key);
    this.graph.edges = this.graph.edges.filter((e) => e.fromStageId !== key && e.toStageId !== key);
    this.canvas.setData(this.graph);
    this.renderProps(null);
    this.setDirty(true);
  },

  flashCycle(msg) {
    toast(msg, true);
  },

  autoLayout() {
    const levels = ClientDag.levels(this.graph.stages, this.graph.edges);
    this.canvas.autoLayout(levels);
    this.setDirty(true);
  },

  async save() {
    if (!this.graph) return;
    const payload = {
      stages: this.graph.stages.map((s) => ({
        key: s.key,
        ...(s.id ? { id: s.id } : {}),
        name: s.name.trim(),
        type: s.type,
        timeoutSec: s.timeoutSec,
        failPolicy: s.failPolicy,
        retryTimes: s.retryTimes,
        gateOwner: s.gateOwner,
        posX: s.posX,
        posY: s.posY,
      })),
      edges: this.graph.edges.map((e) => ({ fromStageId: e.fromStageId, toStageId: e.toStageId })),
    };
    try {
      const saved = await API.saveGraph(this.currentId, payload);
      // 用后端返回重建，获得真实 id / edge id
      this.graph = {
        pipeline: saved.pipeline,
        stages: saved.stages.map((s) => ({
          key: `db-${s.id}`,
          id: s.id,
          name: s.name,
          type: s.type,
          timeoutSec: s.timeout_sec,
          failPolicy: s.fail_policy,
          retryTimes: s.retry_times,
          gateOwner: s.gate_owner,
          posX: s.pos_x,
          posY: s.pos_y,
        })),
        edges: saved.edges.map((e) => ({
          key: `e-${e.id}`,
          fromStageId: `db-${e.from_stage_id}`,
          toStageId: `db-${e.to_stage_id}`,
        })),
      };
      this.canvas.clearCycle();
      this.canvas.setData(this.graph);
      this.renderProps(this.canvas.selectedNodeKey);
      this.setDirty(false);
      this.loadPipelines();
      toast('编排已保存');
    } catch (err) {
      if (err.data?.code === 'CYCLE_DETECTED') {
        this.showCycleBanner(err.data);
      } else {
        toast(err.message, true);
      }
    }
  },

  showCycleBanner(data) {
    document.getElementById('cycle-path').textContent = data.error.replace(/^.*?：/, '');
    document.getElementById('cycle-banner').classList.remove('hidden');
    this.canvas.setCycle(data.cycle);
    toast('环形依赖已拦截', true);
  },

  async triggerRun() {
    if (!this.graph) return;
    try {
      const { runId } = await API.triggerRun(this.currentId, { triggeredBy: '当前用户' });
      toast(`已触发运行 #${runId}`);
      this.loadPipelines();
      setTimeout(() => openRunModal(runId), 300);
    } catch (err) {
      if (err.data?.code === 'CYCLE_DETECTED') this.showCycleBanner(err.data);
      else toast(err.message, true);
    }
  },

  // ---------- 右：阶段属性 ----------
  renderProps(key) {
    const box = document.getElementById('stage-props');
    const s = key ? this.graph?.stages.find((x) => x.key === key) : null;
    if (!s) {
      box.innerHTML = `<div class="props-empty muted">在画布上点击一个阶段节点进行编辑；<br/>拖线即可建立阶段依赖，无需下拉选择。</div>`;
      return;
    }

    box.innerHTML = `
      <div class="form-row">
        <label>阶段名称</label>
        <input type="text" data-f="name" value="${escapeAttr(s.name)}" />
      </div>
      <div class="form-row">
        <label>阶段类型</label>
        <div class="type-chips">
          ${TYPE_ORDER.map((t) => `
            <button type="button" class="type-chip ${s.type === t ? 'on' : ''}" data-f="type" data-v="${t}">
              <span class="tc-dot" style="background:${TYPE_META[t].color}"></span>${TYPE_META[t].label}
            </button>`).join('')}
        </div>
      </div>
      <div class="form-row">
        <label>超时时间</label>
        <div class="form-inline">
          <input type="number" min="1" data-f="timeoutMin" value="${Math.max(1, Math.round(s.timeoutSec / 60))}" />
          <select data-f="timeoutUnit">
            <option value="min" selected>分钟</option>
            <option value="sec">秒</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <label>失败策略</label>
        <div class="seg">
          ${Object.entries(FAIL_POLICY_META).map(([k, m]) => `
            <button type="button" class="${s.failPolicy === k ? 'on' : ''}" data-f="failPolicy" data-v="${k}">${m.label}</button>
          `).join('')}
        </div>
        <div class="hint-box" id="policy-hint">${FAIL_POLICY_META[s.failPolicy].hint}</div>
      </div>
      <div class="form-row" id="retry-row" style="${s.failPolicy === 'retry' ? '' : 'display:none'}">
        <label>重试次数</label>
        <input type="number" min="0" max="10" data-f="retryTimes" value="${s.retryTimes ?? 0}" />
      </div>
      <div class="form-row" id="owner-row" style="${s.type === 'manual_gate' ? '' : 'display:none'}">
        <label>卡点负责人</label>
        <input type="text" data-f="gateOwner" value="${escapeAttr(s.gateOwner || '')}" placeholder="例如：张婷" />
        <div class="hint-box">流水线运行到此阶段会挂起，等待负责人在执行详情中审批通过或驳回。</div>
      </div>
      <div class="props-actions">
        <button class="btn btn-danger" id="btn-delete-stage">删除阶段</button>
      </div>`;

    const update = (patch) => {
      Object.assign(s, patch);
      this.canvas.setData(this.graph);
      this.setDirty(true);
    };

    box.querySelector('[data-f="name"]').addEventListener('change', (ev) => {
      const v = ev.target.value.trim();
      if (!v) return toast('阶段名称不能为空', true);
      if (this.graph.stages.some((x) => x !== s && x.name === v)) return toast('阶段名称不能重复', true);
      update({ name: v });
    });
    box.querySelectorAll('[data-f="type"]').forEach((b) =>
      b.addEventListener('click', () => {
        update({ type: b.dataset.v });
        this.renderProps(s.key);
      })
    );
    box.querySelectorAll('[data-f="failPolicy"]').forEach((b) =>
      b.addEventListener('click', () => {
        update({ failPolicy: b.dataset.v });
        this.renderProps(s.key);
      })
    );
    box.querySelector('[data-f="timeoutMin"]').addEventListener('change', (ev) => {
      const unit = box.querySelector('[data-f="timeoutUnit"]').value;
      const v = Math.max(1, Number(ev.target.value) || 1);
      update({ timeoutSec: unit === 'min' ? v * 60 : v });
    });
    box.querySelector('[data-f="timeoutUnit"]').addEventListener('change', () => {
      const v = Math.max(1, Number(box.querySelector('[data-f="timeoutMin"]').value) || 1);
      const unit = box.querySelector('[data-f="timeoutUnit"]').value;
      update({ timeoutSec: unit === 'min' ? v * 60 : v });
    });
    box.querySelector('[data-f="retryTimes"]').addEventListener('change', (ev) => {
      update({ retryTimes: Math.max(0, Math.min(10, Number(ev.target.value) || 0)) });
    });
    const ownerInput = box.querySelector('[data-f="gateOwner"]');
    if (ownerInput) ownerInput.addEventListener('change', (ev) => update({ gateOwner: ev.target.value.trim() }));
    box.querySelector('#btn-delete-stage').addEventListener('click', () => this.deleteStage(s.key));
  },

  setDirty(v) {
    this.dirty = v;
    this.updateChrome();
  },
};

/* 前端本地即时环检测 / 分层（与后端 src/dag.js 同算法，基于 key） */
const ClientDag = {
  findCycle(stages, edges) {
    const adj = new Map(stages.map((s) => [s.key, []]));
    for (const e of edges) {
      if (adj.has(e.fromStageId) && adj.has(e.toStageId)) adj.get(e.fromStageId).push(e.toStageId);
    }
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map(stages.map((s) => [s.key, WHITE]));
    const stack = [], pos = new Map();
    const dfs = (u) => {
      color.set(u, GRAY);
      pos.set(u, stack.length);
      stack.push(u);
      for (const v of adj.get(u)) {
        if (color.get(v) === GRAY) return stack.slice(pos.get(v)).concat(v);
        if (color.get(v) === WHITE) {
          const f = dfs(v);
          if (f) return f;
        }
      }
      stack.pop();
      pos.delete(u);
      color.set(u, BLACK);
      return null;
    };
    for (const s of stages) {
      if (color.get(s.key) === WHITE) {
        const cyc = dfs(s.key);
        if (cyc) return cyc.map((k) => ({ key: k, name: stages.find((s) => s.key === k).name }));
      }
    }
    return null;
  },

  levels(stages, edges) {
    const indeg = new Map(stages.map((s) => [s.key, 0]));
    const adj = new Map(stages.map((s) => [s.key, []]));
    for (const e of edges) {
      if (indeg.has(e.fromStageId) && indeg.has(e.toStageId)) {
        adj.get(e.fromStageId).push(e.toStageId);
        indeg.set(e.toStageId, indeg.get(e.toStageId) + 1);
      }
    }
    let frontier = stages.filter((s) => indeg.get(s.key) === 0).map((s) => s.key);
    const out = [];
    while (frontier.length) {
      out.push(frontier.slice());
      const next = [];
      for (const u of frontier) {
        for (const v of adj.get(u)) {
          indeg.set(v, indeg.get(v) - 1);
          if (indeg.get(v) === 0) next.push(v);
        }
      }
      frontier = next;
    }
    return out;
  },
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
