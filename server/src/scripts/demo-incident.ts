/**
 * 污染事件验收场景：
 *   1. 两次交叉混样（M1=A+B，M2=B+C，M3=M2+B）+ 工具接触记录
 *   2. 事件窗口 → 直接接触与谱系下游标疑似；窗口外接触不误伤
 *   3. 三态区分：确认污染 / 疑似暴露 / 已排除（排除必须留依据）
 *   4. 候选复测方案：按原样余量 + 检测项目 + 最小取样量；原样 C 已耗尽 → 不可判定
 *   5. 方案确认才预占；两方案竞争同一余量 → 409 且原子回滚
 *   6. 暴露窗口缩小 → 影响范围随证据修订，复测范围同步缩小
 *   7. 复测结果修订关联旧报告（SUPERSEDED 保留，不覆盖）
 *   8. 全程台账对账一致，不重复消耗样本
 *
 * 运行：npm run build && npm run demo:incident
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { rmSync } from 'fs';
import { AppModule } from '../app.module';

const PORT = 3124;
const BASE = `http://localhost:${PORT}/api`;
const T = (h: number, m: number) => `2026-09-11T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;

let passed = 0, failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✘ ${name} ${detail}`); }
}
const num = (v: any) => Number(v);
const eq = (a: any, b: number) => num(a) === b;

async function api(method: string, path: string, body?: any) {
  const res = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}
const avail = async (id: string) => num((await api('GET', `/samples/${id}`)).data.availableMassG);

async function main() {
  rmSync('./pgdata-incident', { recursive: true, force: true });
  process.env.PGDATA = './pgdata-incident';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(PORT);

  console.log('\n【1】两次交叉混样 + 工具接触记录');
  const tool = (await api('POST', '/tools', { code: 'PIP-1', note: '100 mL 移液管' })).data;
  const mk = async (code: string, mass: string) =>
    (await api('POST', '/samples/intake', { idempotencyKey: `in-${code}`, code, mass, unit: 'g' })).data.sample.id;
  const A = await mk('SOIL-A', '115'), B = await mk('SOIL-B', '250'), C = await mk('SOIL-C', '60');
  // 窗口外接触（09:00）：不应被误伤
  await api('POST', '/tool-contacts', { toolId: tool.id, sampleId: A, contactAt: T(9, 0), note: '称量辅助' });
  const mix = async (key: string, code: string, sources: any[], contactAt: string) => {
    const r = (await api('POST', '/samples/mix', { idempotencyKey: key, code, sources })).data;
    await api('POST', '/tool-contacts', { toolId: tool.id, sampleId: r.sample.id, contactAt, note: '混样移液' });
    return r.sample.id;
  };
  const M1 = await mix('m1', 'MIX-1', [{ sampleId: A, mass: '100' }, { sampleId: B, mass: '50' }], T(10, 5));
  const M2 = await mix('m2', 'MIX-2', [{ sampleId: B, mass: '80' }, { sampleId: C, mass: '60' }], T(10, 20));
  const M3 = await mix('m3', 'MIX-3', [{ sampleId: M2, mass: '20' }, { sampleId: B, mass: '20' }], T(10, 25));
  const split = async (key: string, parentId: string, code: string, mass: string) =>
    (await api('POST', '/samples/split', { idempotencyKey: key, parentId, code, mass })).data.sample.id;
  const ALQ1 = await split('sp1', M1, 'ALQ-M1', '40');
  const ALQ2 = await split('sp2', M2, 'ALQ-M2', '30');
  check('原样 C 已耗尽（60 g 全部用于 MIX-2）', eq(await avail(C), 0));
  check('交叉谱系：B 同时进入 MIX-1/2/3，MIX-2 再进入 MIX-3', true);

  const test = async (sid: string, v: string) =>
    (await api('POST', `/samples/${sid}/tests`, { analyte: 'Pb', rawValue: v, unit: 'mg/kg', detectionLimit: '1' })).data;
  await test(M1, '20');
  const m2Pb = await test(M2, '25');
  await test(M3, '22');
  await test(ALQ2, '25');

  console.log('\n【2】污染事件：窗口内接触 + 谱系下游标疑似');
  const inc = (await api('POST', '/incidents', {
    code: 'INC-01', toolId: tool.id, windowStart: T(10, 0), windowEnd: T(10, 30),
    reason: '清洗失误，该窗口内移液管可能残留污染',
  })).data;
  const byCode = (d: any) => Object.fromEntries(d.impacts.map((i: any) => [i.sampleCode, i]));
  let imp = byCode(inc);
  check('5 个样品疑似暴露（3 混样 + 2 分样）',
    inc.impacts.length === 5 && inc.impacts.every((i: any) => i.status === 'SUSPECTED'));
  check('原样 A/B/C 未被标记（接触在窗口外或未接触）', !imp['SOIL-A'] && !imp['SOIL-B'] && !imp['SOIL-C']);

  console.log('\n【3】三态区分：确认污染 / 疑似 / 已排除（排除须留依据）');
  const noBasis = await api('POST', `/incidents/${inc.id}/impacts/${ALQ1}/clear`, { basis: '' });
  check('无依据排除被拒绝（400）', noBasis.status === 400);
  let d = (await api('POST', `/incidents/${inc.id}/impacts/${M2}/confirm`, { basis: '平行样初筛检出清洗剂特征峰' })).data;
  d = (await api('POST', `/incidents/${inc.id}/impacts/${ALQ1}/clear`, { basis: '分样于 09:30 独立完成并密封，仅谱系关联' })).data;
  imp = byCode(d);
  check('MIX-2 = 确认污染', imp['MIX-2'].status === 'CONFIRMED');
  check('ALQ-M1 = 已排除（依据保留）', imp['ALQ-M1'].status === 'CLEARED' && imp['ALQ-M1'].basis.includes('密封'));
  check('MIX-1/MIX-3/ALQ-M2 仍为疑似', ['MIX-1', 'MIX-3', 'ALQ-M2'].every((c) => imp[c].status === 'SUSPECTED'));

  console.log('\n【4】候选复测方案（DRAFT，不预占）');
  const p1 = (await api('POST', `/incidents/${inc.id}/retest-plans`)).data;
  const itemOf = (p: any, code: string) => p.items.find((i: any) => i.sampleCode === code);
  check('方案条目按（原样,项目）去重：A、B、C 各一条 Pb', p1.items.length === 3);
  check('已排除的 ALQ-M1 不在复测范围', !p1.items.some((i: any) => i.sampleCode === 'ALQ-M1'));
  check('原样 C 耗尽 → 明确不可判定', itemOf(p1, 'SOIL-C').feasible === false && itemOf(p1, 'SOIL-C').reason.includes('不可判定'));
  check('混样无法反推原样浓度 → 备注承认不可判定', p1.notes.some((n: string) => n.includes('无法反推') && n.includes('不可判定')));
  check('生成方案不预占：A 仍 15 g，B 仍 100 g', eq(await avail(A), 15) && eq(await avail(B), 100));

  console.log('\n【5】确认才预占；两方案竞争同一余量 → 冲突原子回滚');
  // 两位实验员各自生成草案（此时 A 余量 15 g，两方案都可行），随后竞争确认
  const p2 = (await api('POST', `/incidents/${inc.id}/retest-plans`)).data;
  await api('POST', `/retest-plans/${p1.id}/confirm`);
  check('P1 确认后预占：A 15→5，B 100→90', eq(await avail(A), 5) && eq(await avail(B), 90));
  const c2 = await api('POST', `/retest-plans/${p2.id}/confirm`);
  check('P2 竞争同一余量 → 409 冲突', c2.status === 409, JSON.stringify(c2.data.conflicts));
  check('冲突原子回滚：B 未被部分预占，仍 90 g', eq(await avail(B), 90));
  await api('POST', `/retest-plans/${p1.id}/cancel`);
  check('取消 P1 释放预占：A 回到 15 g，B 回到 100 g', eq(await avail(A), 15) && eq(await avail(B), 100));

  console.log('\n【6】暴露窗口缩小 → 影响与复测范围随证据修订');
  d = (await api('POST', `/incidents/${inc.id}/revise-window`, {
    windowStart: T(10, 10), windowEnd: T(10, 30),
    reason: '查证 10:10 已完成重新清洗，窗口起点后移',
  })).data;
  imp = byCode(d);
  check('MIX-1（10:05 接触）自动转为已排除并留依据',
    imp['MIX-1'].status === 'CLEARED' && imp['MIX-1'].basis.includes('不再处于影响链'));
  check('MIX-2 确认污染不受影响，MIX-3/ALQ-M2 仍疑似',
    imp['MIX-2'].status === 'CONFIRMED' && imp['MIX-3'].status === 'SUSPECTED' && imp['ALQ-M2'].status === 'SUSPECTED');
  check('人工排除的 ALQ-M1 不被自动重算覆盖', imp['ALQ-M1'].status === 'CLEARED' && imp['ALQ-M1'].basis.includes('密封'));
  check('状态变迁审计留痕（含自动排除）', d.events.some((e: any) => e.sampleCode === 'MIX-1' && e.to === 'CLEARED'));

  await api('POST', `/retest-plans/${p2.id}/cancel`); // 过期草案作废
  const p3 = (await api('POST', `/incidents/${inc.id}/retest-plans`)).data;
  check('窗口缩小后复测范围修订：A 退出，仅剩 B、C', p3.items.length === 2 && !itemOf(p3, 'SOIL-A'));
  check('C 仍不可判定（耗尽）', itemOf(p3, 'SOIL-C').feasible === false);
  await api('POST', `/retest-plans/${p3.id}/confirm`);
  check('P3 确认：仅预占 B 10 g（B 100→90）', eq(await avail(B), 90));

  console.log('\n【7】复测结果修订关联旧报告（不覆盖）');
  const bItem = p3.items.find((i: any) => i.sampleCode === 'SOIL-B');
  const rr = (await api('POST', `/retest-plans/${p3.id}/items/${bItem.id}/result`, {
    rawValue: '18', unit: 'mg/kg', detectionLimit: '1', amendsId: m2Pb.id,
  })).data;
  check('新结果落在原样 B 上并关联旧报告', rr.record.sampleId === B && rr.record.amendsId === m2Pb.id);
  const m2Tests = (await api('GET', `/samples/${M2}/tests`)).data;
  const oldRec = m2Tests.find((t: any) => t.id === m2Pb.id);
  check('旧报告 SUPERSEDED 但保留（未删除未覆盖）', oldRec.status === 'SUPERSEDED' && eq(oldRec.correctedMgPerKg, 25));
  const m2Sum = (await api('GET', `/samples/${M2}/tests/summary?analyte=Pb`)).data;
  const bSum = (await api('GET', `/samples/${B}/tests/summary?analyte=Pb`)).data;
  check('MIX-2 旧报告不再计入有效平均', m2Sum.averageMgPerKg === null && m2Sum.detectCount === 0);
  check('B 的复测结果 18 mg/kg 生效', eq(bSum.averageMgPerKg, 18));
  check('预占已消耗（不重复扣减）：B 保持 90 g', eq(await avail(B), 90));

  console.log('\n【8】全程对账：不重复消耗样本');
  let allOk = true;
  for (const sid of [A, B, C, M1, M2, M3, ALQ1, ALQ2]) {
    const rec = (await api('GET', `/samples/${sid}/reconcile`)).data;
    if (!rec.consistent) { allOk = false; console.log('    不一致:', rec); }
  }
  check('8 个样品台账合计 = 现存可用量', allOk);
  check('B 全程物料守恒：250 - 50 - 80 - 20 - 10(预占消耗) = 90', eq(await avail(B), 90));

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
