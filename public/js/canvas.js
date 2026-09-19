'use strict';

/* ============================================================
 * DAGCanvas —— 纯 SVG 流水线画布
 *
 * 交互（全部为真实指针操作，非下拉选依赖）：
 *  - 按住节点体拖动：移动节点
 *  - 从节点右侧圆点按下拖到另一节点左侧圆点：建立依赖边
 *  - 单击连线选中，中点出现 ×，或按 Delete/Backspace 删除
 *  - 单击节点选中（供右端属性面板编辑）
 *  - 环上的节点与边红色虚线高亮
 * ============================================================ */

const NODE_W = 184;
const NODE_H = 78;
const SVG_NS = 'http://www.w3.org/2000/svg';

class DAGCanvas {
  constructor(svg, handlers = {}) {
    this.svg = svg;
    this.h = handlers;
    this.stages = [];
    this.edges = [];
    this.selectedNodeKey = null;
    this.selectedEdgeKey = null;
    this.cycleNames = new Set();
    this.cycleEdgeKeys = new Set();

    this.nodeLayer = svg.querySelector('#node-layer');
    this.edgeLayer = svg.querySelector('#edge-layer');
    this.ghostLayer = svg.querySelector('#ghost-edge-layer');

    this.drag = null; // 当前指针操作
    this.bindEvents();
  }

  setData({ stages, edges }) {
    this.stages = stages || [];
    this.edges = edges || [];
    if (this.selectedNodeKey && !this.stages.some((s) => s.key === this.selectedNodeKey)) {
      this.selectedNodeKey = null;
    }
    this.render();
  }

  selectNode(key) {
    this.selectedNodeKey = key;
    this.selectedEdgeKey = null;
    this.render();
  }

  selectEdgeNone() {
    this.selectedEdgeKey = null;
    this.render();
  }

  /** cycleNodes: [{id,name}...]（首尾同名表示闭合） */
  setCycle(cycleNodes) {
    this.cycleNames = new Set((cycleNodes || []).map((n) => n.name));
    this.cycleEdgeKeys = new Set();
    if (cycleNodes && cycleNodes.length > 1) {
      for (let i = 0; i < cycleNodes.length - 1; i++) {
        this.cycleEdgeKeys.add(`${cycleNodes[i].name}->${cycleNodes[i + 1].name}`);
      }
    }
    this.render();
  }

  clearCycle() {
    this.setCycle([]);
  }

  // ---------- 坐标 ----------
  toSvgPoint(clientX, clientY) {
    const pt = this.svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(this.svg.getScreenCTM().inverse());
  }

  nodeByKey(key) {
    return this.stages.find((s) => s.key === key);
  }

  // ---------- 渲染 ----------
  render() {
    this.edgeLayer.innerHTML = '';
    this.nodeLayer.innerHTML = '';

    for (const e of this.edges) this.edgeLayer.appendChild(this.renderEdge(e));
    for (const s of this.stages) this.nodeLayer.appendChild(this.renderNode(s));

    // 按内容扩展画布
    let maxX = 1200, maxY = 640;
    for (const s of this.stages) {
      maxX = Math.max(maxX, s.posX + NODE_W + 160);
      maxY = Math.max(maxY, s.posY + NODE_H + 160);
    }
    this.svg.setAttribute('width', maxX);
    this.svg.setAttribute('height', maxY);
  }

  renderEdge(e) {
    const from = this.nodeByKey(e.fromStageId);
    const to = this.nodeByKey(e.toStageId);
    if (!from || !to) return document.createElementNS(SVG_NS, 'g');
    const x1 = from.posX + NODE_W, y1 = from.posY + NODE_H / 2;
    const x2 = to.posX, y2 = to.posY + NODE_H / 2;
    const d = this.edgePath(x1, y1, x2, y2);

    const key = `${from.name}->${to.name}`;
    const selected = this.selectedEdgeKey === e.key;
    const onCycle = this.cycleEdgeKeys.has(key);

    const g = document.createElementNS(SVG_NS, 'g');
    g.dataset.edgeKey = e.key;

    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('class', 'edge-hit');
    g.appendChild(hit);

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'edge-path' + (selected ? ' selected' : '') + (onCycle ? ' cycle-hit' : ''));
    path.setAttribute('marker-end', onCycle ? 'url(#arrow-cycle)' : 'url(#arrow)');
    g.appendChild(path);

    if (selected) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const del = document.createElementNS(SVG_NS, 'g');
      del.setAttribute('transform', `translate(${mx},${my})`);
      del.style.cursor = 'pointer';
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('r', 9);
      c.setAttribute('fill', '#d03b3b');
      del.appendChild(c);
      const x = document.createElementNS(SVG_NS, 'text');
      x.textContent = '×';
      x.setAttribute('text-anchor', 'middle');
      x.setAttribute('y', 3.5);
      x.setAttribute('font-size', '13');
      x.setAttribute('fill', '#fff');
      x.setAttribute('pointer-events', 'none');
      del.appendChild(x);
      del.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        this.h.onDeleteEdge && this.h.onDeleteEdge(e.key);
      });
      g.appendChild(del);
    }

    g.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.selectedEdgeKey = e.key;
      this.selectedNodeKey = null;
      this.h.onSelectEdge && this.h.onSelectEdge(e.key);
      this.render();
    });
    return g;
  }

  edgePath(x1, y1, x2, y2) {
    const dx = Math.max(48, Math.abs(x2 - x1) * 0.5);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
  }

  renderNode(s) {
    const meta = TYPE_META[s.type];
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'g-node' + (this.selectedNodeKey === s.key ? ' selected' : '') + (this.cycleNames.has(s.name) ? ' cycle-hit' : ''));
    g.setAttribute('transform', `translate(${s.posX},${s.posY})`);
    g.dataset.nodeKey = s.key;

    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'node-rect');
    rect.setAttribute('width', NODE_W);
    rect.setAttribute('height', NODE_H);
    rect.setAttribute('rx', 9);
    g.appendChild(rect);

    // 左侧类型色条
    const bar = document.createElementNS(SVG_NS, 'rect');
    bar.setAttribute('x', 1); bar.setAttribute('y', 1);
    bar.setAttribute('width', 5); bar.setAttribute('height', NODE_H - 2);
    bar.setAttribute('rx', 2);
    bar.setAttribute('fill', meta.color);
    g.appendChild(bar);

    // 类型图标（人工卡点）
    const titleX = 16;
    const title = document.createElementNS(SVG_NS, 'text');
    title.setAttribute('class', 'node-title');
    title.setAttribute('x', titleX);
    title.setAttribute('y', 26);
    title.textContent = s.type === 'manual_gate' ? '⏸ ' + s.name : s.name;
    g.appendChild(title);

    const sub = document.createElementNS(SVG_NS, 'text');
    sub.setAttribute('class', 'node-sub');
    sub.setAttribute('x', titleX);
    sub.setAttribute('y', 46);
    const timeoutMin = s.timeoutSec >= 60 ? Math.round(s.timeoutSec / 60) + ' 分' : s.timeoutSec + ' 秒';
    sub.textContent = `${meta.label} · 超时 ${timeoutMin}`;
    g.appendChild(sub);

    const policy = document.createElementNS(SVG_NS, 'text');
    policy.setAttribute('x', titleX);
    policy.setAttribute('y', 65);
    policy.setAttribute('font-size', '10.5');
    policy.setAttribute('fill', '#898781');
    const retryText = s.failPolicy === 'retry' ? `（${s.retryTimes ?? 0} 次）` : '';
    policy.textContent = FAIL_POLICY_META[s.failPolicy].label + retryText;
    g.appendChild(policy);

    // 输入口（左）/ 输出口（右）
    const inPort = document.createElementNS(SVG_NS, 'circle');
    inPort.setAttribute('class', 'node-port in');
    inPort.setAttribute('cx', 0); inPort.setAttribute('cy', NODE_H / 2); inPort.setAttribute('r', 5.5);
    inPort.dataset.portIn = s.key;
    g.appendChild(inPort);

    const outPort = document.createElementNS(SVG_NS, 'circle');
    outPort.setAttribute('class', 'node-port out');
    outPort.setAttribute('cx', NODE_W); outPort.setAttribute('cy', NODE_H / 2); outPort.setAttribute('r', 5.5);
    outPort.dataset.portOut = s.key;
    g.appendChild(outPort);

    // 扩大端口命中区域
    const inHit = document.createElementNS(SVG_NS, 'circle');
    inHit.setAttribute('class', 'port-hit');
    inHit.setAttribute('cx', 0); inHit.setAttribute('cy', NODE_H / 2); inHit.setAttribute('r', 13);
    inHit.dataset.portIn = s.key;
    g.appendChild(inHit);
    const outHit = document.createElementNS(SVG_NS, 'circle');
    outHit.setAttribute('class', 'port-hit');
    outHit.setAttribute('cx', NODE_W); outHit.setAttribute('cy', NODE_H / 2); outHit.setAttribute('r', 13);
    outHit.dataset.portOut = s.key;
    g.appendChild(outHit);

    return g;
  }

  // ---------- 事件 ----------
  bindEvents() {
    this.svg.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    window.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    window.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    window.addEventListener('keydown', (ev) => {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.selectedEdgeKey) {
        const tag = (ev.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        this.h.onDeleteEdge && this.h.onDeleteEdge(this.selectedEdgeKey);
      }
    });
  }

  onPointerDown(ev) {
    const outKey = ev.target.dataset && ev.target.dataset.portOut;
    const inKey = ev.target.dataset && ev.target.dataset.portIn;
    const nodeG = ev.target.closest && ev.target.closest('.g-node');

    if (outKey) {
      // 开始拉线
      ev.preventDefault();
      const node = this.nodeByKey(outKey);
      this.drag = {
        kind: 'connect',
        fromKey: outKey,
        start: { x: node.posX + NODE_W, y: node.posY + NODE_H / 2 },
        cur: this.toSvgPoint(ev.clientX, ev.clientY),
        hoverIn: null,
      };
      return;
    }

    if (nodeG && !inKey) {
      // 节点拖动（点输入口不拖节点）
      const key = nodeG.dataset.nodeKey;
      const node = this.nodeByKey(key);
      const p = this.toSvgPoint(ev.clientX, ev.clientY);
      this.drag = {
        kind: 'node',
        key,
        offsetX: p.x - node.posX,
        offsetY: p.y - node.posY,
        moved: false,
      };
      this.selectedNodeKey = key;
      this.selectedEdgeKey = null;
      this.h.onSelectNode && this.h.onSelectNode(key);
      nodeG.classList.add('dragging');
      this.render();
      return;
    }

    if (!ev.target.closest('.edge-path') && !(ev.target.closest && ev.target.closest('g[data-edge-key]'))) {
      // 空白处：取消选择
      if (this.selectedNodeKey || this.selectedEdgeKey) {
        this.selectedNodeKey = null;
        this.selectedEdgeKey = null;
        this.h.onSelectNode && this.h.onSelectNode(null);
        this.h.onSelectEdge && this.h.onSelectEdge(null);
        this.render();
      }
    }
  }

  onPointerMove(ev) {
    if (!this.drag) return;
    const p = this.toSvgPoint(ev.clientX, ev.clientY);

    if (this.drag.kind === 'node') {
      const node = this.nodeByKey(this.drag.key);
      if (!node) return;
      const nx = Math.max(0, Math.round(p.x - this.drag.offsetX));
      const ny = Math.max(0, Math.round(p.y - this.drag.offsetY));
      if (Math.abs(nx - node.posX) + Math.abs(ny - node.posY) > 1) this.drag.moved = true;
      if (!this.drag.moved) return;
      node.posX = nx;
      node.posY = ny;
      this.h.onMove && this.h.onMove(node, false);
      this.render();
      const g = this.nodeLayer.querySelector(`[data-node-key="${CSS.escape(node.key)}"]`);
      if (g) g.classList.add('dragging');
      return;
    }

    if (this.drag.kind === 'connect') {
      this.drag.cur = p;
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      this.drag.hoverIn = target && target.dataset && target.dataset.portIn ? target.dataset.portIn : null;
      this.renderGhost();
    }
  }

  onPointerUp(ev) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.ghostLayer.innerHTML = '';

    if (d.kind === 'node') {
      const node = this.nodeByKey(d.key);
      if (node && d.moved) this.h.onMove && this.h.onMove(node, true);
      return;
    }

    if (d.kind === 'connect') {
      const target = document.elementFromPoint(ev.clientX, ev.clientY);
      const toKey = target && target.dataset && target.dataset.portIn ? target.dataset.portIn : d.hoverIn;
      if (toKey && toKey !== d.fromKey) {
        this.h.onConnect && this.h.onConnect(d.fromKey, toKey);
      }
    }
  }

  renderGhost() {
    this.ghostLayer.innerHTML = '';
    const d = this.drag;
    if (!d || d.kind !== 'connect') return;
    const path = document.createElementNS(SVG_NS, 'path');
    // 终点若悬停在合法输入口上，吸附到该口
    let ex = d.cur.x, ey = d.cur.y;
    if (d.hoverIn && d.hoverIn !== d.fromKey) {
      const n = this.nodeByKey(d.hoverIn);
      if (n) { ex = n.posX; ey = n.posY + NODE_H / 2; }
    }
    path.setAttribute('d', this.edgePath(d.start.x, d.start.y, ex, ey));
    path.setAttribute('class', 'ghost-path');
    this.ghostLayer.appendChild(path);
  }

  /** 按拓扑层级自动排版（levels: key[][]） */
  autoLayout(levels) {
    if (!levels || !levels.length) return;
    const colGap = NODE_W + 96;
    const rowGap = NODE_H + 46;
    levels.forEach((colKeys, ci) => {
      colKeys.forEach((key, ri) => {
        const node = this.nodeByKey(typeof key === 'number' ? this.stages.find((s) => s.id === key)?.key : key);
        if (!node) return;
        node.posX = 60 + ci * colGap;
        node.posY = 60 + ri * rowGap;
      });
    });
    this.render();
  }
}
