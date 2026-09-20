'use strict';

/**
 * 序流 API 冒烟 / 回归测试（零依赖，Node ≥ 18 内置 fetch）。
 * 用法：先启动服务（默认 8130），再执行 `node tests/api-smoke.js`。
 * 注意：用例会创建/删除临时流水线，并触发/审批临时执行，不会改动种子流水线；
 *      但会新增少量执行记录，需要完全干净的数据可重跑 `node server/seed.js --force`。
 */
const BASE = process.env.BASE_URL || 'http://localhost:8130';
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✅', msg); } else { fail++; console.log('  ❌', msg); } };

async function req(urlPath, opts = {}) {
  const res = await fetch(BASE + urlPath, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log('— 元数据与初始数据 —');
  let r = await req('/api/meta');
  ok(r.status === 200 && r.json.stageTypes.length === 5, '5 种阶段类型');
  r = await req('/api/pipelines');
  ok(r.status === 200 && r.json.items.length >= 3, `流水线 ≥ 3（实际 ${r.json.items.length}）`);
  r = await req('/api/runs?limit=200');
  ok(r.json.items.length >= 20, `执行记录 ≥ 20（实际 ${r.json.items.length}）`);

  console.log('— 仪表盘 —');
  r = await req('/api/stats/overview?gateHours=4');
  ok(r.json.today.total >= 1, '今日运行次数 > 0');
  ok(r.json.today.successRate >= 0 && r.json.today.successRate <= 100, '成功率在 0–100');
  ok(Array.isArray(r.json.trend) && r.json.trend.length === 7, '近 7 天趋势');
  ok(Array.isArray(r.json.gateAlerts.items), '卡点红灯列表');
  ok(r.json.gateAlerts.items.every((g) => g.over === (g.waitHours >= 4)), '红灯判定与阈值一致');

  console.log('— 环形依赖拦截 —');
  r = await req('/api/pipelines', { method: 'POST', body: { name: '__smoke_cycle__', stages: [
    { id: 'a', name: 'A', type: 'build', timeoutMin: 5, failurePolicy: 'abort', deps: ['c'] },
    { id: 'b', name: 'B', type: 'test', timeoutMin: 5, failurePolicy: 'abort', deps: ['a'] },
    { id: 'c', name: 'C', type: 'image', timeoutMin: 5, failurePolicy: 'abort', deps: ['b'] },
  ] } });
  ok(r.status === 400 && r.json.details?.code === 'CYCLE', '环被拦截');
  ok(JSON.stringify(r.json.details.cycle) === JSON.stringify(['a', 'b', 'c', 'a']), '返回那条环');

  r = await req('/api/pipelines', { method: 'POST', body: { name: '__smoke_self__', stages: [
    { id: 'x', name: 'X', type: 'build', timeoutMin: 5, failurePolicy: 'abort', deps: ['x'] }] } });
  ok(r.status === 400, '自环被拦截');
  r = await req('/api/pipelines', { method: 'POST', body: { name: '__smoke_ref__', stages: [
    { id: 'a', name: 'A', type: 'build', timeoutMin: 5, failurePolicy: 'abort', deps: ['ghost'] }] } });
  ok(r.status === 400, '悬空依赖被拦截');

  console.log('— 正常编排 / 触发 / 审批 —');
  r = await req('/api/pipelines', { method: 'POST', body: { name: '__smoke_ok__', stages: [
    { id: 'b', name: '构建', type: 'build', timeoutMin: 10, failurePolicy: 'abort', deps: [], x: 0, y: 0 },
    { id: 'g', name: '审批', type: 'gate', timeoutMin: 60, failurePolicy: 'abort', deps: ['b'], x: 0, y: 0 },
    { id: 'd', name: '部署', type: 'deploy', timeoutMin: 10, failurePolicy: 'abort', deps: ['g'], x: 0, y: 0 },
  ] } });
  ok(r.status === 201, '合法流水线创建成功');
  const pid = r.json.id;

  r = await req(`/api/pipelines/${pid}/trigger`, { method: 'POST', body: {} });
  ok(r.json.status === 'waiting' && r.json.waitingGate?.stageId === 'g', '触发后停在卡点');
  const runId = r.json.id;
  r = await req(`/api/runs/${runId}/approve`, { method: 'POST', body: { decision: 'approve', operator: 'smoke' } });
  ok(r.json.status === 'success' && r.json.stages.every((s) => s.status === 'success'), '审批通过后整条成功');

  r = await req(`/api/pipelines/${pid}/trigger`, { method: 'POST', body: {} });
  r = await req(`/api/runs/${r.json.id}/approve`, { method: 'POST', body: { decision: 'reject', comment: 'smoke' } });
  ok(r.json.status === 'failed' && r.json.stages.find((s) => s.id === 'd').status === 'skipped', '驳回后中止、下游跳过');

  r = await req(`/api/pipelines/${pid}`, { method: 'DELETE' });
  ok(r.status === 200, '清理临时流水线');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
