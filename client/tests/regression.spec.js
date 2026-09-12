/**
 * 页面回归：检测结果留存
 *  - 点击“计算平均”后页面保留平均 27.5 mg/kg（与 API 返回一致）
 *  - 点击“台账对账”后页面保留现存量/台账量/一致状态
 *  - 两个动作都会触发 run()→refresh() 刷新样品列表，结果不得被清掉
 *  - 主动切换样品时才清空结果
 */
import { mount, flushPromises } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.vue';

const samples = [
  { id: 's1', code: 'ALQ-01', kind: 'ALIQUOT', availableMassG: '48.000000', containerCode: '聚乙烯袋-02' },
  { id: 's2', code: 'ALQ-02', kind: 'ALIQUOT', availableMassG: '60.000000', containerCode: null },
];
const lineageOf = (s) => ({
  root: s.id,
  nodes: [{ id: s.id, code: s.code, kind: s.kind, availableMassG: s.availableMassG, containerCode: s.containerCode, tests: [] }],
  edges: [],
});
const SUMMARY = { sampleId: 's1', analyte: 'Pb', averageMgPerKg: '27.5', detectCount: 2, belowDlCount: 1, note: '低于检出限的记录不参与平均（不按 0 计）' };
const RECONCILE = { sampleId: 's1', availableG: '48', ledgerSumG: '48', consistent: true };

function mockFetch() {
  return vi.fn(async (url) => {
    const u = String(url);
    let body;
    if (u === '/api/containers') body = [];
    else if (u === '/api/tools') body = [];
    else if (u === '/api/incidents') body = [];
    else if (u === '/api/samples') body = samples;
    else if (u.includes('/tests/summary')) body = SUMMARY;
    else if (u.endsWith('/reconcile')) body = RECONCILE;
    else if (u.includes('/weighings/sample/')) body = [];
    else if (u.endsWith('/tests')) body = [];
    else if (u.endsWith('/lineage')) body = lineageOf(samples.find((s) => u.includes(s.id)));
    else throw new Error('未 mock 的请求: ' + u);
    return { ok: true, status: 200, json: async () => body };
  });
}

const clickByText = async (wrapper, text) => {
  const btn = wrapper.findAll('button').find((b) => b.text() === text);
  expect(btn, `按钮「${text}」应存在`).toBeTruthy();
  await btn.trigger('click');
  await flushPromises();
};

describe('工作台检测结果留存', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch());
  });

  it('计算平均后页面保留 27.5 mg/kg，再对账后两个结果都保留', async () => {
    const wrapper = mount(App);
    await flushPromises(); // onMounted: containers + samples + select(s1)

    // 初始已选中 ALQ-01，直接计算平均
    await clickByText(wrapper, '计算平均');
    expect(wrapper.text()).toContain('27.5');
    expect(wrapper.text()).toContain('检出 2 条');
    expect(wrapper.text()).toContain('低于检出限 1 条已排除');

    // 台账对账（会再次触发 refresh 刷新样品列表）
    await clickByText(wrapper, '台账对账');
    expect(wrapper.text()).toContain('现存 48 g = 台账 48 g');
    expect(wrapper.text()).toContain('✔ 一致');

    // 回归核心：刷新样品列表后，之前的平均结果仍在
    expect(wrapper.text()).toContain('27.5');
    expect(wrapper.text()).toContain('平均');
  });

  it('连续触发刷新（如对账后再算平均）结果不清零，且与 API 返回一致', async () => {
    const wrapper = mount(App);
    await flushPromises();

    await clickByText(wrapper, '台账对账');
    expect(wrapper.text()).toContain('✔ 一致');

    await clickByText(wrapper, '计算平均');
    expect(wrapper.text()).toContain('27.5');
    // 对账结果在后续刷新后仍保留
    expect(wrapper.text()).toContain('现存 48 g = 台账 48 g');

    // 页面展示值与 API 返回值逐项一致
    expect(wrapper.text()).toContain(`平均：${SUMMARY.averageMgPerKg}`);
    expect(wrapper.text()).toContain(`现存 ${RECONCILE.availableG} g = 台账 ${RECONCILE.ledgerSumG} g`);
  });

  it('主动切换样品时才清空结果', async () => {
    const wrapper = mount(App);
    await flushPromises();

    await clickByText(wrapper, '计算平均');
    expect(wrapper.text()).toContain('27.5');

    // 点击另一样品行 → select() 清空上一样品的结果
    const rows = wrapper.findAll('tbody tr');
    await rows[1].trigger('click');
    await flushPromises();
    expect(wrapper.text()).not.toContain('27.5');
    expect(wrapper.text()).not.toContain('✔ 一致');
  });
});
