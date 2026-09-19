'use strict';

/**
 * DAG 工具：环检测（返回具体的环）与拓扑分层。
 *
 * 节点输入形如：[{ id, name, ... }]
 * 边输入形如：[{ fromStageId, toStageId }]（to 依赖 from）
 */

/**
 * 深度优先三色遍历找环。
 * 返回 null（无环）或环上节点 id 数组，形如 [a, b, c, a]，
 * 即执行顺序 a → b → c → a，画布可据此高亮那条环。
 */
function findCycle(nodes, edges) {
  const adj = new Map();
  const nameById = new Map();
  for (const n of nodes) {
    adj.set(n.id, []);
    nameById.set(n.id, n.name);
  }
  for (const e of edges) {
    if (adj.has(e.fromStageId) && adj.has(e.toStageId)) {
      adj.get(e.fromStageId).push(e.toStageId);
    }
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map();
  for (const id of adj.keys()) color.set(id, WHITE);
  const stack = [];
  const stackPos = new Map();

  function dfs(u) {
    color.set(u, GRAY);
    stackPos.set(u, stack.length);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (color.get(v) === GRAY) {
        const start = stackPos.get(v);
        const cycleNodes = stack.slice(start).concat(v);
        return cycleNodes;
      }
      if (color.get(v) === WHITE) {
        const found = dfs(v);
        if (found) return found;
      }
    }
    stack.pop();
    stackPos.delete(u);
    color.set(u, BLACK);
    return null;
  }

  for (const id of [...adj.keys()].sort((a, b) => a - b)) {
    if (color.get(id) === WHITE) {
      const found = dfs(id);
      if (found) {
        return found.map((id) => ({ id, name: nameById.get(id) }));
      }
    }
  }
  return null;
}

/**
 * Kahn 拓扑排序；顺带按层分组（同层无依赖关系，可并行）。
 * 假设无环（调用前先过 findCycle）。
 * 返回 { order: id[], levels: id[][] }
 */
function topoLevels(nodes, edges) {
  const indeg = new Map();
  const adj = new Map();
  for (const n of nodes) {
    indeg.set(n.id, 0);
    adj.set(n.id, []);
  }
  for (const e of edges) {
    if (indeg.has(e.fromStageId) && indeg.has(e.toStageId)) {
      adj.get(e.fromStageId).push(e.toStageId);
      indeg.set(e.toStageId, indeg.get(e.toStageId) + 1);
    }
  }

  let frontier = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order = [];
  const levels = [];
  while (frontier.length) {
    levels.push(frontier.slice());
    order.push(...frontier);
    const next = [];
    for (const u of frontier) {
      for (const v of adj.get(u)) {
        indeg.set(v, indeg.get(v) - 1);
        if (indeg.get(v) === 0) next.push(v);
      }
    }
    frontier = next;
  }
  return { order, levels };
}

/** 把环节点数组格式化成人类可读的“那条环”，如 构建 → 镜像 → 构建 */
function formatCycle(cycleNodes) {
  if (!cycleNodes) return null;
  return cycleNodes.map((n) => n.name).join(' → ');
}

module.exports = { findCycle, topoLevels, formatCycle };
