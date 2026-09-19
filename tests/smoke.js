'use strict';
/* 对运行中的 8130 服务做端到端 HTTP 冒烟 */
const BASE = 'http://127.0.0.1:8130';

async function req(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
}

let failures = 0;
function check(name, cond, extra) {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

(async () => {
  const health = await req('GET', '/api/health');
  check('健康检查', health.status === 200 && health.data.ok);

  const pipes = await req('GET', '/api/pipelines');
  check('流水线 ≥ 3', pipes.data.length >= 3, `${pipes.data.length} 条`);

  const dash = await req('GET', '/api/dashboard?gateHours=4');
  check('仪表盘 today.total 为数字', typeof dash.data.today.total === 'number', `total=${dash.data.today.total}`);
  check('成功率在 [0,1]', dash.data.today.successRate == null || (dash.data.today.successRate >= 0 && dash.data.today.successRate <= 1),
    `rate=${dash.data.today.successRate}`);
  check('today 各状态数之和=total',
    dash.data.today.success + dash.data.today.failed + dash.data.today.running + (dash.data.today.canceled || 0) <= dash.data.today.total);
  check('近 7 天数组长度 7', dash.data.trend7d.length === 7);
  check('红灯 ≥ 2（种子 5.3h/26.5h）', dash.data.stuckGates.length >= 2, `${dash.data.stuckGates.length} 个`);

  // 阈值调大后红灯应变少
  const dashStrict = await req('GET', '/api/dashboard?gateHours=24');
  check('阈值 24h 只剩 1 个红灯', dashStrict.data.stuckGates.length === 1, `${dashStrict.data.stuckGates.length} 个`);

  // 触发支付线（含人工卡点）→ 挂起 → 审批通过 → 成功
  const trig = await req('POST', '/api/pipelines/1/run', { triggeredBy: '冒烟脚本' });
  check('触发运行返回 runId', trig.status === 201 && trig.data.runId);
  const rid = trig.data.runId;

  let detail = await req('GET', `/api/runs/${rid}`);
  const gate = detail.data.stageRuns.find((s) => s.status === 'waiting_gate');
  check('运行挂起在人工卡点', !!gate, gate ? gate.stage_name : '无');
  check('卡点下游为 pending', detail.data.stageRuns.some((s) => s.status === 'pending'));

  const approved = await req('POST', `/api/runs/${rid}/gate/${gate.stage_id}`, { approved: true, approver: '冒烟脚本' });
  check('审批通过 204', approved.status === 204);
  detail = await req('GET', `/api/runs/${rid}`);
  check('审批后整条运行 success', detail.data.run.status === 'success', detail.data.run.status);
  check('全部阶段 success', detail.data.stageRuns.every((s) => s.status === 'success'),
    detail.data.stageRuns.map((s) => s.status).join(','));

  // 驳回路径
  const trig2 = await req('POST', '/api/pipelines/1/run', {});
  let d2 = await req('GET', `/api/runs/${trig2.data.runId}`);
  const gate2 = d2.data.stageRuns.find((s) => s.status === 'waiting_gate');
  await req('POST', `/api/runs/${trig2.data.runId}/gate/${gate2.stage_id}`, { approved: false, reason: '冒烟驳回' });
  d2 = await req('GET', `/api/runs/${trig2.data.runId}`);
  check('驳回后 run=failed', d2.data.run.status === 'failed');
  check('驳回点下游 skipped', d2.data.stageRuns.some((s) => s.status === 'skipped'));

  // 环拦截：造一条环保存
  const created = await req('POST', '/api/pipelines', { name: '冒烟环线' });
  const pid = created.data.id;
  const cyc = await req('PUT', `/api/pipelines/${pid}/graph`, {
    stages: ['构建', '镜像', '部署'].map((name, i) => ({
      key: `new-${i}`, name, type: i === 2 ? 'deploy' : 'build',
      timeoutSec: 600, failPolicy: 'abort', retryTimes: 0, posX: i * 240, posY: 0,
    })),
    edges: [
      { fromStageId: 'new-0', toStageId: 'new-1' },
      { fromStageId: 'new-1', toStageId: 'new-2' },
      { fromStageId: 'new-2', toStageId: 'new-0' },
    ],
  });
  check('环保存 422', cyc.status === 422 && cyc.data.code === 'CYCLE_DETECTED');
  check('返回那条环', /构建 → 镜像 → 部署 → 构建/.test(cyc.data.error), cyc.data.error);

  // 删掉环中的一条边后可保存
  const ok = await req('PUT', `/api/pipelines/${pid}/graph`, {
    stages: ['构建', '镜像', '部署'].map((name, i) => ({
      key: `new-${i}`, name, type: i === 2 ? 'deploy' : 'build',
      timeoutSec: 600, failPolicy: 'abort', retryTimes: 0, posX: i * 240, posY: 0,
    })),
    edges: [
      { fromStageId: 'new-0', toStageId: 'new-1' },
      { fromStageId: 'new-1', toStageId: 'new-2' },
    ],
  });
  check('断环后保存成功', ok.status === 200 && ok.data.edges.length === 2);

  const runs = await req('GET', '/api/runs?limit=50');
  check('执行记录列表 ≥ 20', Array.isArray(runs.data) && runs.data.length >= 20, `${runs.data?.length} 条`);

  console.log(failures ? `\n${failures} 项失败` : '\n冒烟全部通过 ✓');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
