'use strict';

/* 应用入口：视图切换、健康检查、执行详情弹层 */

const App = {
  currentView: 'orchestration',

  async init() {
    document.querySelectorAll('.nav-item').forEach((btn) =>
      btn.addEventListener('click', () => this.switchView(btn.dataset.view))
    );
    document.getElementById('btn-close-modal').addEventListener('click', () => {
      document.getElementById('run-modal').classList.add('hidden');
    });
    document.getElementById('run-modal').addEventListener('click', (ev) => {
      if (ev.target.id === 'run-modal') document.getElementById('run-modal').classList.add('hidden');
    });

    await Orch.init();
    Dashboard.init();
    Dashboard.startAutoRefresh();
    this.pollHealth();
  },

  switchView(view) {
    this.currentView = view;
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    document.getElementById('view-orchestration').classList.toggle('hidden', view !== 'orchestration');
    document.getElementById('view-dashboard').classList.toggle('hidden', view !== 'dashboard');
    if (view === 'dashboard') Dashboard.load();
    if (view === 'orchestration') Orch.loadPipelines();
  },

  async pollHealth() {
    const dot = document.getElementById('health-dot');
    const tick = async () => {
      try {
        await API.health();
        dot.className = 'health-dot ok';
        dot.title = '服务正常 · 端口 8130';
      } catch {
        dot.className = 'health-dot bad';
        dot.title = '服务不可用';
      }
    };
    tick();
    setInterval(tick, 10000);
  },
};

async function openRunModal(runId) {
  const modal = document.getElementById('run-modal');
  const body = document.getElementById('run-modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';

  const render = async () => {
    try {
      const data = await API.getRun(runId);
      document.getElementById('run-modal-title').textContent =
        `#${data.run.id} · ${data.run.pipeline_name}`;
      body.innerHTML = renderRunDetail(data);
      bindRunActions(data, render);
    } catch (err) {
      body.innerHTML = `<div class="muted" style="padding:20px">${escapeHtml(err.message)}</div>`;
    }
  };
  await render();
}

function renderRunDetail(data) {
  const r = data.run;
  const m = STATUS_META[r.status] || { label: r.status, cls: '', icon: '?' };
  const trig = { manual: '手动触发', push: '代码推送', schedule: '定时触发' }[r.trigger_type] || r.trigger_type;
  const dur = r.finished_at
    ? fmtDuration(Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000))
    : '运行中';

  // 用边信息标注依赖（简略：按拓扑顺序展示即可）
  const rows = data.stageRuns
    .map((sr) => {
      const sm = STATUS_META[sr.status] || { label: sr.status, icon: '?', cls: '' };
      const tm = TYPE_META[sr.stage_type];
      const waiting =
        sr.status === 'waiting_gate'
          ? fmtWaiting(Math.round((Date.now() - new Date(sr.started_at)) / 1000))
          : null;
      return `
      <div class="sr-row" data-stage="${sr.stage_id}">
        <div class="sr-icon" style="color:${statusColor(sr.status)}">${sm.icon}</div>
        <div class="sr-main">
          <div class="sr-name">
            <span class="tc-dot" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${tm.color};margin-right:6px"></span>
            ${escapeHtml(sr.stage_name)}
            <span class="muted small">（${tm.label}）</span>
          </div>
          <div class="sr-msg">${escapeHtml(sr.message || '—')}</div>
          ${sr.status === 'waiting_gate' ? gatePanel(sr, waiting) : ''}
        </div>
        <div class="sr-right">
          <span class="pill ${sm.cls}">${sm.label}</span>
          <div style="margin-top:5px">
            ${sr.attempt > 1 ? `尝试 ${sr.attempt} 次 · ` : ''}
            ${sr.duration_sec != null ? fmtDuration(sr.duration_sec) : sr.status === 'waiting_gate' ? '已等待 ' + waiting : '—'}
          </div>
        </div>
      </div>`;
    })
    .join('');

  return `
    <div style="display:flex;gap:16px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
      <span class="pill ${m.cls}" style="font-size:13px">${m.icon} ${m.label}</span>
      <span class="muted small">${trig} · ${escapeHtml(r.triggered_by || '—')}</span>
      <span class="muted small">开始 ${fmtClock(r.started_at)}</span>
      <span class="muted small">总耗时 ${dur}</span>
      <span style="flex:1"></span>
      ${r.status === 'running' ? '<button class="btn btn-secondary btn-sm" id="btn-cancel-run">取消执行</button>' : ''}
    </div>
    ${rows}`;
}

function gatePanel(sr, waiting) {
  return `
    <div class="gate-actions">
      <button class="btn btn-primary btn-sm" data-gate="approve" data-stage="${sr.stage_id}">✓ 审批通过</button>
      <button class="btn btn-secondary btn-sm" data-gate="reject" data-stage="${sr.stage_id}">✕ 驳回</button>
      <span class="muted small" style="align-self:center">已等待 ${waiting}</span>
    </div>`;
}

function bindRunActions(data, rerender) {
  const cancelBtn = document.getElementById('btn-cancel-run');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('确定取消这次执行？未完成的阶段将被跳过。')) return;
      await API.cancelRun(data.run.id);
      toast('执行已取消');
      rerender();
    });
  }
  document.querySelectorAll('[data-gate]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const stageId = Number(btn.dataset.stage);
      const approved = btn.dataset.gate === 'approve';
      let reason = '';
      if (!approved) {
        reason = prompt('请填写驳回原因：') || '';
      }
      try {
        await API.resolveGate(data.run.id, stageId, { approved, reason, approver: '当前用户' });
        toast(approved ? '已审批通过，流水线继续执行' : '已驳回，流水线中止');
        await new Promise((r) => setTimeout(r, 300));
        rerender();
        Dashboard.load(true);
      } catch (err) {
        toast(err.message, true);
      }
    });
  });
}

function statusColor(status) {
  return {
    success: '#0ca30c',
    failed: '#d03b3b',
    gate_rejected: '#d03b3b',
    running: '#fab219',
    waiting_gate: '#e87ba4',
    skipped: '#b3b0a7',
    pending: '#b3b0a7',
  }[status] || '#898781';
}

window.addEventListener('DOMContentLoaded', () => App.init());
