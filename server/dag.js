'use strict';

/**
 * DAG 校验工具：
 * - 依赖引用完整性
 * - 自环 / 环形依赖检测（DFS 三色标记），并还原出那条环
 * - 拓扑排序与层级计算（用于并行分支展示）
 *
 * stage 结构：{ id, name, type, timeoutMin, failurePolicy, deps: string[], x, y }
 * 约定：deps 表示“本阶段依赖哪些前置阶段”，边的方向是 dep -> stage。
 */

const STAGE_TYPES = ['build', 'test', 'image', 'deploy', 'gate'];
const FAILURE_POLICIES = ['abort', 'continue'];

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
    this.details = details || {};
  }
}

function validateStages(rawStages) {
  if (!Array.isArray(rawStages) || rawStages.length === 0) {
    throw new ValidationError('流水线至少要包含一个阶段');
  }

  const stages = rawStages.map((s, i) => {
    const id = String(s.id || '').trim();
    const name = String(s.name || '').trim();
    if (!id) throw new ValidationError(`第 ${i + 1} 个阶段缺少 id`);
    if (!name) throw new ValidationError(`阶段 ${id} 缺少名称`);
    const type = String(s.type || '');
    if (!STAGE_TYPES.includes(type)) {
      throw new ValidationError(`阶段「${name}」的类型非法：${s.type}（允许：${STAGE_TYPES.join(' / ')}）`);
    }
    const timeoutMin = Number(s.timeoutMin);
    if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
      throw new ValidationError(`阶段「${name}」的超时时间必须是正数（分钟）`);
    }
    const failurePolicy = s.failurePolicy || 'abort';
    if (!FAILURE_POLICIES.includes(failurePolicy)) {
      throw new ValidationError(`阶段「${name}」的失败策略非法：${failurePolicy}`);
    }
    return {
      id,
      name,
      type,
      timeoutMin,
      failurePolicy,
      deps: Array.isArray(s.deps) ? [...new Set(s.deps.map(String))] : [],
      x: Number.isFinite(Number(s.x)) ? Number(s.x) : 80 + (i % 4) * 60,
      y: Number.isFinite(Number(s.y)) ? Number(s.y) : 80 + i * 120,
    };
  });

  const byId = new Map(stages.map((s) => [s.id, s]));

  for (const s of stages) {
    if (s.deps.includes(s.id)) {
      throw new ValidationError(`阶段「${s.name}」不能依赖自身（自环）`, {
        code: 'CYCLE',
        cycle: [s.id, s.id],
        cycleNames: [s.name, s.name],
      });
    }
    for (const dep of s.deps) {
      if (!byId.has(dep)) {
        throw new ValidationError(`阶段「${s.name}」依赖了不存在的阶段：${dep}`, {
          code: 'BROKEN_REF',
          from: s.id,
          missing: dep,
        });
      }
    }
  }

  const cycle = findCycle(stages);
  if (cycle) {
    const cycleNames = cycle.map((id) => byId.get(id)?.name || id);
    throw new ValidationError(
      `检测到环形依赖，已被拦截：${cycleNames.join(' → ')}。请删除环上的任意一条连线后再保存。`,
      { code: 'CYCLE', cycle, cycleNames }
    );
  }

  return { stages, byId, levels: computeLevels(stages, byId) };
}

/**
 * 三色 DFS：white 未访问 / gray 在当前递归栈 / black 已完成
 * 遇到 gray 节点即回边，沿栈还原环（含首尾重复节点，便于画成闭合环）。
 */
function findCycle(stages) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(stages.map((s) => [s.id, WHITE]));
  const stack = [];
  const stackPos = new Map();

  function dfs(u) {
    color.set(u, GRAY);
    stackPos.set(u, stack.length);
    stack.push(u);

    const node = stages.find((s) => s.id === u);
    // 顺着“u -> 下游”走：下游即 deps 里包含 u 的阶段
    for (const v of stages.filter((s) => s.deps.includes(u)).map((s) => s.id)) {
      if (color.get(v) === GRAY) {
        const start = stackPos.get(v);
        return [...stack.slice(start), v];
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

  for (const s of stages) {
    if (color.get(s.id) === WHITE) {
      const found = dfs(s.id);
      if (found) return found;
    }
  }
  return null;
}

/** Kahn 拓扑排序；返回 null 表示有环（正常调用前已校验，此处兜底）。 */
function topoSort(stages) {
  const indeg = new Map(stages.map((s) => [s.id, s.deps.length]));
  const queue = stages.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const s of stages) {
      if (s.deps.includes(id)) {
        indeg.set(s.id, indeg.get(s.id) - 1);
        if (indeg.get(s.id) === 0) queue.push(s.id);
      }
    }
  }
  return order.length === stages.length ? order : null;
}

/** 计算每个阶段的层级（最深依赖链长度），同层即可并行。 */
function computeLevels(stages, byId) {
  const level = new Map();
  const visit = (id) => {
    if (level.has(id)) return level.get(id);
    const node = byId.get(id);
    let lvl = 0;
    for (const dep of node.deps) lvl = Math.max(lvl, visit(dep) + 1);
    level.set(id, lvl);
    return lvl;
  };
  stages.forEach((s) => visit(s.id));
  return level;
}

module.exports = {
  STAGE_TYPES,
  FAILURE_POLICIES,
  ValidationError,
  validateStages,
  findCycle,
  topoSort,
  computeLevels,
};
