'use strict';

/* ============================================================
 * 仪表盘视图
 * ============================================================ */

const Dashboard = {
  gateHours: 4,
  timer: null,

  init() {
    document.getElementById('gate-hours').addEventListener('change', (ev) => {
      this.gateHours = Math.max(1, Math.min(168, Number(ev.target.value) || 4));
      this.load();
    });
    document.getElementById('btn-refresh-dash').addEventListener('click', () => this.load());
  },

  startAutoRefresh() {
    this.stopAutoRefresh();
    this.timer = setInterval(() => {
      if (App.currentView === 'dashboard') this.load(true);
    }, 15000);
  },
  stopAutoRefresh() {
    if (this.timer) clearInterval(this.timer);
  },

  async load(silent) {
    try {
      const d = await API.dashboard(this.gateHours);
      this.renderKpis(d);
      this.renderRunsChart(d.trend7d);
      this.renderRateChart(d.trend7d);
      this.renderStuck(d);
      await this.renderRecent();
    } catch (err) {
      if (!silent) toast(err.message, true);
    }
  },

  // ---------- KPI ----------
  renderKpis(d) {
    const t = d.today;
    const ratePct = t.successRate == null ? '—' : (t.successRate * 100).toFixed(1) + '%';
    const stuckN = d.stuckGates.length;
    const kpis = [
      {
        label: '今日运行次数',
        value: t.total,
        sub: `运行中 ${t.running} · 失败 ${t.failed}`,
        meter: null,
      },
      {
        label: '今日成功率',
        value: ratePct,
        sub: t.total ? `成功 ${t.success} / 共 ${t.total} 次` : '今日暂无运行',
        meter: t.successRate == null ? null : Math.round(t.successRate * 100),
      },
      {
        label: '今日平均时长',
        value: fmtDuration(t.avgDurationSec || null),
        sub: '仅统计已结束的运行',
        meter: null,
      },
      {
        label: `卡点超时红灯（>${d.gateHours}h）`,
        value: stuckN,
        sub: stuckN ? '需要立即处理' : `另有 ${d.waitingGateCount} 个卡点等待中`,
        alert: stuckN > 0,
        meter: null,
      },
    ];

    document.getElementById('kpi-row').innerHTML = kpis
      .map(
        (k) => `
      <div class="kpi ${k.alert ? 'kpi-alert' : ''}">
        <div class="kpi-label">
          ${k.alert ? '<span class="red-dot"></span>' : ''}${k.label}
        </div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
        ${k.meter != null ? `<div class="mini-meter"><i style="width:${k.meter}%"></i></div>` : ''}
      </div>`
      )
      .join('');
  },

  // ---------- 近 7 天运行次数（柱状） ----------
  renderRunsChart(trend) {
    const W = 520, H = 220, M = { t: 18, r: 16, b: 34, l: 36 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const maxV = Math.max(4, ...trend.map((d) => d.total));
    const bw = iw / trend.length;
    const y = (v) => M.t + ih - (v / maxV) * ih;

    const dayLabel = (s) => {
      const d = new Date(s);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    const bars = trend
      .map((d, i) => {
        const cx = M.l + bw * i + bw / 2;
        const w = Math.min(34, bw - 22);
        const h = (d.total / maxV) * ih;
        const x = cx - w / 2;
        const yy = y(d.total);
        return `
          <rect class="bar" data-i="${i}" x="${x}" y="${yy}" width="${w}" height="${Math.max(0, h - 1)}" rx="4"
                fill="#2a78d6" opacity="${d.total ? 1 : 0.35}"></rect>
          <text x="${cx}" y="${yy - 6}" text-anchor="middle" font-size="11.5" fill="#52514e"
                opacity="${d.total ? 1 : 0}">${d.total}</text>
          <text x="${cx}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#898781">${dayLabel(d.day)}</text>`;
      })
      .join('');

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((g) => {
        const yy = M.t + ih - g * ih;
        const v = Math.round(maxV * g);
        return `
          <line x1="${M.l}" y1="${yy}" x2="${W - M.r}" y2="${yy}" stroke="#e1e0d9" stroke-width="1"/>
          <text x="${M.l - 8}" y="${yy + 4}" text-anchor="end" font-size="10.5" fill="#898781">${v}</text>`;
      })
      .join('');

    const svg = `
      <svg class="viz-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${grid}
        <line x1="${M.l}" y1="${M.t + ih}" x2="${W - M.r}" y2="${M.t + ih}" stroke="#c3c2b7" stroke-width="1"/>
        ${bars}
      </svg>`;
    const host = document.getElementById('chart-runs');
    host.innerHTML = svg;

    host.querySelectorAll('.bar').forEach((el) => {
      el.addEventListener('mousemove', (ev) => {
        const d = trend[Number(el.dataset.i)];
        Tooltip.show(ev, `${dayLabel(d.day)}<br/>运行 <b>${d.total}</b> 次 · 成功 ${d.success} 次`);
        el.setAttribute('fill', '#1c5cab');
      });
      el.addEventListener('mouseleave', () => {
        Tooltip.hide();
        el.setAttribute('fill', '#2a78d6');
      });
    });
  },

  // ---------- 近 7 天成功率（折线） ----------
  renderRateChart(trend) {
    const W = 520, H = 220, M = { t: 18, r: 16, b: 34, l: 40 };
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const xs = trend.map((_, i) => M.l + (iw * (i + 0.5)) / trend.length);
    const y = (v) => M.t + ih - v * ih;

    const dayLabel = (s) => {
      const d = new Date(s);
      return `${d.getMonth() + 1}/${d.getDate()}`;
    };

    // 无数据的日子断开线段
    let line = '', dots = '', started = false;
    trend.forEach((d, i) => {
      if (d.rate == null) {
        started = false;
        return;
      }
      const px = xs[i], py = y(d.rate);
      line += (started ? 'L ' : 'M ') + px + ' ' + py + ' ';
      started = true;
      dots += `
        <circle class="dot" data-i="${i}" cx="${px}" cy="${py}" r="7" fill="transparent"/>
        <circle cx="${px}" cy="${py}" r="4" fill="#0ca30c" stroke="#fcfcfb" stroke-width="2"/>`;
    });

    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((g) => {
        const yy = y(g);
        return `
          <line x1="${M.l}" y1="${yy}" x2="${W - M.r}" y2="${yy}" stroke="#e1e0d9" stroke-width="1"/>
          <text x="${M.l - 8}" y="${yy + 4}" text-anchor="end" font-size="10.5" fill="#898781">${Math.round(g * 100)}%</text>`;
      })
      .join('');

    const xlabels = trend
      .map((d, i) => `<text x="${xs[i]}" y="${H - 12}" text-anchor="middle" font-size="11" fill="#898781">${dayLabel(d.day)}</text>`)
      .join('');

    const host = document.getElementById('chart-runs');
    const svg = `
      <svg class="viz-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        ${grid}
        <path d="${line}" fill="none" stroke="#0ca30c" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${xlabels}
        <line x1="${M.l}" y1="${M.t}" x2="${M.l}" y2="${M.t + ih}" stroke="#c3c2b7" stroke-width="1"/>
      </svg>`;
    const rateHost = document.getElementById('chart-rate');
    rateHost.innerHTML = svg;

    rateHost.querySelectorAll('.dot').forEach((el) => {
      el.addEventListener('mousemove', (ev) => {
        const d = trend[Number(el.dataset.i)];
        Tooltip.show(ev, `${dayLabel(d.day)}<br/>成功率 <b>${(d.rate * 100).toFixed(1)}%</b><br/><span class="muted">${d.success}/${d.total} 次</span>`);
      });
      el.addEventListener('mouseleave', () => Tooltip.hide());
    });
  },

  // ---------- 红灯 ----------
  renderStuck(d) {
    document.getElementById('stuck-thr-label').textContent = d.gateHours;
    const count = document.getElementById('stuck-count');
    count.textContent = d.stuckGates.length;
    count.className = 'badge ' + (d.stuckGates.length ? 'badge-critical' : 'badge-ok');

    const list = document.getElementById('stuck-list');
    if (!d.stuckGates.length) {
      list.innerHTML = `<div class="stuck-empty"><b>✓ 没有超时卡点</b>，全部人工审批都在 ${d.gateHours} 小时阈值内。</div>`;
      return;
    }
    list.innerHTML = d.stuckGates
      .map((g, i) => {
        const overH = g.waiting_sec / 3600;
        const urgent = overH >= d.gateHours * 2;
        return `
        <div class="stuck-item ${urgent ? 'urgent' : ''}">
          <span class="red-dot"></span>
          <div class="stuck-main">
            <div class="stuck-title">${escapeHtml(g.stage_name)} · ${escapeHtml(g.pipeline_name)}</div>
            <div class="stuck-sub">
              运行 #${g.run_id} · ${fmtClock(g.started_at)} 进入卡点
              ${g.gate_claimed_by ? ' · 负责人 ' + escapeHtml(g.gate_claimed_by) : ''}
            </div>
          </div>
          <div class="stuck-wait">
            <b>${fmtWaiting(g.waiting_sec)}</b>
            <span>等待时长</span>
          </div>
          <button class="btn btn-primary btn-sm" data-run="${g.run_id}">去处理</button>
        </div>`;
      })
      .join('');
    list.querySelectorAll('button[data-run]').forEach((b) =>
      b.addEventListener('click', () => openRunModal(Number(b.dataset.run)))
    );
  },

  // ---------- 最近执行 ----------
  async renderRecent() {
    const runs = await API.listRuns(30);
    const rows = runs
      .map((r) => {
        const m = STATUS_META[r.status] || { label: r.status, cls: '', icon: '?' };
        const dur =
          r.status === 'running'
            ? '运行中'
            : fmtDuration(Math.max(0, Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 1000)));
        const trig = { manual: '手动', push: '代码推送', schedule: '定时' }[r.trigger_type] || r.trigger_type;
        return `
        <tr class="clickable" data-run="${r.id}">
          <td class="num">#${r.id}</td>
          <td>${escapeHtml(r.pipeline_name)}</td>
          <td><span class="pill ${m.cls}">${m.icon} ${m.label}</span></td>
          <td>${trig}</td>
          <td>${escapeHtml(r.triggered_by || '—')}</td>
          <td>${fmtRelative(r.started_at)}</td>
          <td class="num">${dur}</td>
        </tr>`;
      })
      .join('');
    document.getElementById('recent-runs').innerHTML = `
      <table class="data">
        <thead><tr>
          <th>#</th><th>流水线</th><th>状态</th><th>触发方式</th><th>触发人</th><th>开始于</th><th>耗时</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    document.querySelectorAll('#recent-runs tr[data-run]').forEach((tr) =>
      tr.addEventListener('click', () => openRunModal(Number(tr.dataset.run)))
    );
  },
};

const Tooltip = {
  el: null,
  ensure() {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'viz-tooltip hidden';
      document.body.appendChild(this.el);
    }
    return this.el;
  },
  show(ev, html) {
    const el = this.ensure();
    el.innerHTML = html;
    el.classList.remove('hidden');
    el.style.left = ev.clientX + 'px';
    el.style.top = ev.clientY + 'px';
  },
  move(ev) {
    const el = this.ensure();
    el.style.left = ev.clientX + 'px';
    el.style.top = ev.clientY + 'px';
  },
  hide() {
    this.ensure().classList.add('hidden');
  },
};
