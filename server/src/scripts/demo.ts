/**
 * 可运行的数据证明脚本：
 *   1. 单位换算（kg/mg 入库 → 克）
 *   2. 混样扣减与产出守恒
 *   3. 重复提交（同一幂等键）不重复扣减
 *   4. 分样不能凭空增加物料（余量不足 → 409）
 *   5. 两人同时取样：并发请求下库存不超发、总量守恒
 *   6. 已确认称量只能更正，更正按差额调整库存
 *   7. 检测值稀释校正 + 低于检出限不按 0 参与平均
 *   8. 台账与现存对账一致
 *
 * 运行：npm run build && npm run demo
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { rmSync } from 'fs';
import { AppModule } from '../app.module';

const PORT = 3123;
const BASE = `http://localhost:${PORT}/api`;

const num = (v: any) => Number(v);
const eq = (a: any, b: number) => num(a) === b;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}${detail ? ' — ' + detail : ''}`); }
  else { failed++; console.log(`  ✘ ${name} ${detail}`); }
}

async function api(method: string, path: string, body?: any) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

async function main() {
  rmSync('./pgdata-demo', { recursive: true, force: true });
  process.env.PGDATA = './pgdata-demo';
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api');
  await app.listen(PORT);

  const containers = (await api('GET', '/containers')).data;
  const [c1, c2, c3, c4] = containers.map((c: any) => c.id);

  console.log('\n【1】单位换算：0.5 kg 与 250000 mg 入库');
  const a = await api('POST', '/samples/intake', { idempotencyKey: 'in-a', code: 'SOIL-A', mass: '0.5', unit: 'kg', containerId: c1 });
  const b = await api('POST', '/samples/intake', { idempotencyKey: 'in-b', code: 'SOIL-B', mass: '250000', unit: 'mg', containerId: c2 });
  check('SOIL-A 0.5 kg → 500 g', eq(a.data.sample.availableMassG, 500));
  check('SOIL-B 250000 mg → 250 g', eq(b.data.sample.availableMassG, 250));
  const A = a.data.sample.id, B = b.data.sample.id;

  console.log('\n【2】混样：A 取 120 g + B 取 50 g → MIX-01');
  const mix = await api('POST', '/samples/mix', {
    idempotencyKey: 'mix-1', code: 'MIX-01', containerId: c3,
    sources: [{ sampleId: A, mass: '120' }, { sampleId: B, mass: '0.05', unit: 'kg' }],
  });
  check('MIX-01 产出 170 g', eq(mix.data.sample.availableMassG, 170));
  check('A 剩余 380 g', eq(mix.data.sources[0].remainingG, 380));
  check('B 剩余 200 g', eq(mix.data.sources[1].remainingG, 200));
  const MIX = mix.data.sample.id;

  console.log('\n【3】重复提交同一混样请求（幂等键相同）');
  const mix2 = await api('POST', '/samples/mix', {
    idempotencyKey: 'mix-1', code: 'MIX-01', containerId: c3,
    sources: [{ sampleId: A, mass: '120' }, { sampleId: B, mass: '0.05', unit: 'kg' }],
  });
  const aAfter = (await api('GET', `/samples/${A}`)).data;
  check('返回首次结果（replayed）', mix2.data.replayed === true && mix2.data.sample.id === MIX);
  check('A 未被重复扣减，仍为 380 g', eq(aAfter.availableMassG, 380));

  console.log('\n【4】分样：MIX-01 分出两份 60 g');
  const s1 = await api('POST', '/samples/split', { idempotencyKey: 'sp-1', parentId: MIX, code: 'ALQ-01', mass: '60', containerId: c4 });
  const s2 = await api('POST', '/samples/split', { idempotencyKey: 'sp-2', parentId: MIX, code: 'ALQ-02', mass: '60' });
  check('ALQ-01 = 60 g，MIX-01 剩 110 g', eq(s1.data.sample.availableMassG, 60) && eq(s1.data.parent.remainingG, 110));
  check('ALQ-02 = 60 g，MIX-01 剩 50 g', eq(s2.data.parent.remainingG, 50));
  const ALQ1 = s1.data.sample.id;

  console.log('\n【5】余量不足：MIX-01 只剩 50 g，尝试分 80 g');
  const over = await api('POST', '/samples/split', { idempotencyKey: 'sp-3', parentId: MIX, code: 'ALQ-03', mass: '80' });
  const mixAfterOver = (await api('GET', `/samples/${MIX}`)).data;
  check('返回 409 余量不足', over.status === 409, JSON.stringify(over.data.message ?? over.data));
  check('库存未被扣减，仍为 50 g', eq(mixAfterOver.availableMassG, 50));

  console.log('\n【6】两人同时取样：并发各取 30 g（库存 50 g，只够一人）');
  const [r1, r2] = await Promise.all([
    api('POST', '/samples/split', { idempotencyKey: 'sp-4', parentId: MIX, code: 'ALQ-04', mass: '30' }),
    api('POST', '/samples/split', { idempotencyKey: 'sp-5', parentId: MIX, code: 'ALQ-05', mass: '30' }),
  ]);
  const statuses = [r1.status, r2.status].sort().join(',');
  const mixFinal = (await api('GET', `/samples/${MIX}`)).data;
  check('恰好一人成功一人 409', statuses === '201,409', `实际 ${statuses}`);
  check('MIX-01 最终剩 20 g（不超发）', eq(mixFinal.availableMassG, 20));

  console.log('\n【7】称量：ALQ-01 取样 10 g，确认后更正为 12 g');
  const w = await api('POST', '/weighings', { idempotencyKey: 'w-1', sampleId: ALQ1, kind: 'CONSUME', value: '10', unit: 'g', reason: '消解取样' });
  const wDup = await api('POST', '/weighings', { idempotencyKey: 'w-1', sampleId: ALQ1, kind: 'CONSUME', value: '10', unit: 'g' });
  check('重复提交称量返回同一记录', wDup.data.replayed === true && wDup.data.weighing.id === w.data.weighing.id);
  await api('POST', `/weighings/${w.data.weighing.id}/confirm`);
  const alqAfterConfirm = (await api('GET', `/samples/${ALQ1}`)).data;
  check('确认后 ALQ-01 = 50 g', eq(alqAfterConfirm.availableMassG, 50));
  const reconfirm = await api('POST', `/weighings/${w.data.weighing.id}/confirm`);
  check('重复确认被拒绝（409）', reconfirm.status === 409);
  const corr = await api('POST', `/weighings/${w.data.weighing.id}/corrections`, { idempotencyKey: 'w-1-corr', value: '12', unit: 'g', reason: '复称发现读数偏小' });
  const alqAfterCorr = (await api('GET', `/samples/${ALQ1}`)).data;
  check('更正为 12 g 后 ALQ-01 = 48 g', eq(alqAfterCorr.availableMassG, 48), `差额 ${corr.data.adjustmentG} g`);
  const oldW = (await api('GET', `/weighings/sample/${ALQ1}`)).data.find((x: any) => x.id === w.data.weighing.id);
  check('原记录标记为 CORRECTED（历史保留）', oldW.status === 'CORRECTED');

  console.log('\n【8】检测：稀释校正 + 低于检出限不参与平均');
  await api('POST', `/samples/${ALQ1}/tests`, { analyte: 'Pb', rawValue: '2.5', unit: 'mg/L', detectionLimit: '0.1', dilutionFactor: '10', method: 'ICP-MS' });
  await api('POST', `/samples/${ALQ1}/tests`, { analyte: 'Pb', rawValue: '0.05', unit: 'mg/L', detectionLimit: '0.1', dilutionFactor: '10', method: 'ICP-MS' });
  await api('POST', `/samples/${ALQ1}/tests`, { analyte: 'Pb', rawValue: '30', unit: 'mg/kg', detectionLimit: '1', dilutionFactor: '1' });
  const tests = (await api('GET', `/samples/${ALQ1}/tests`)).data;
  check('2.5 mg/L × 稀释 10 → 25 mg/kg', eq(tests[0].correctedMgPerKg, 25));
  check('0.05 < 检出限 0.1 → 自动标记 below_dl', tests[1].belowDl === true);
  const sum = (await api('GET', `/samples/${ALQ1}/tests/summary?analyte=Pb`)).data;
  check('平均 = (25+30)/2 = 27.5 mg/kg（<DL 不按 0 计入）', eq(sum.averageMgPerKg, 27.5), `belowDl=${sum.belowDlCount} 条被排除`);

  console.log('\n【9】谱系与对账');
  const lineage = (await api('GET', `/samples/${A}/lineage`)).data;
  check('SOIL-A 谱系含 MIX-01 及下游分样', lineage.nodes.length >= 5 && lineage.edges.length >= 4,
    `节点 ${lineage.nodes.length}，边 ${lineage.edges.length}`);
  let allConsistent = true;
  for (const n of lineage.nodes) {
    const rec = (await api('GET', `/samples/${n.id}/reconcile`)).data;
    if (!rec.consistent) allConsistent = false;
  }
  check('谱系内所有样品：台账合计 = 现存可用量', allConsistent);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await app.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
