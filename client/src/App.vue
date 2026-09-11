<template>
  <h1>土壤样品流转工作台 <span class="small">原样 / 混样 / 分样 · 库存与谱系追溯</span></h1>

  <div v-if="message" class="msg" :class="messageType">{{ message }}</div>

  <div class="grid">
    <!-- 样品列表 -->
    <div class="panel">
      <h2>样品库存</h2>
      <table>
        <thead>
          <tr><th>编号</th><th>类型</th><th>可用量 (g)</th><th>容器</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in samples" :key="s.id" :class="{ selected: s.id === selectedId }" @click="select(s.id)">
            <td class="mono">{{ s.code }}</td>
            <td><span class="badge" :class="s.kind">{{ kindLabel(s.kind) }}</span></td>
            <td class="mono">{{ fmt(s.availableMassG) }}</td>
            <td>{{ s.containerCode ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <h2 style="margin-top:14px">原样入库</h2>
      <div class="row">
        <span><label>编号</label><input v-model="intake.code" placeholder="SOIL-001" /></span>
        <span><label>质量</label><input v-model="intake.mass" type="number" step="any" style="width:100px" /></span>
        <span><label>单位</label>
          <select v-model="intake.unit"><option v-for="u in massUnits" :key="u">{{ u }}</option></select></span>
        <span><label>容器</label>
          <select v-model="intake.containerId"><option value="">—</option>
            <option v-for="c in containers" :key="c.id" :value="c.id">{{ c.code }}</option></select></span>
        <button @click="doIntake">入库</button>
      </div>
    </div>

    <!-- 混样 / 分样 -->
    <div class="panel">
      <h2>混样（消耗各原样可用量）</h2>
      <div class="row" v-for="(src, i) in mix.sources" :key="i">
        <select v-model="src.sampleId">
          <option v-for="s in samples" :key="s.id" :value="s.id">{{ s.code }}（余 {{ fmt(s.availableMassG) }} g）</option>
        </select>
        <input v-model="src.mass" type="number" step="any" placeholder="用量" style="width:90px" />
        <select v-model="src.unit" style="width:70px"><option v-for="u in massUnits" :key="u">{{ u }}</option></select>
        <button class="ghost" @click="mix.sources.splice(i, 1)" :disabled="mix.sources.length <= 2">移除</button>
      </div>
      <div class="row">
        <button class="ghost" @click="mix.sources.push({ sampleId: samples[0]?.id, mass: '', unit: 'g' })">+ 来源</button>
        <span><label>混样编号</label><input v-model="mix.code" placeholder="MIX-001" /></span>
        <span><label>容器</label>
          <select v-model="mix.containerId"><option value="">—</option>
            <option v-for="c in containers" :key="c.id" :value="c.id">{{ c.code }}</option></select></span>
        <button @click="doMix">执行混样</button>
      </div>

      <h2 style="margin-top:14px">分样（不能凭空增加物料）</h2>
      <div class="row">
        <span><label>母样</label>
          <select v-model="split.parentId">
            <option v-for="s in samples" :key="s.id" :value="s.id">{{ s.code }}（余 {{ fmt(s.availableMassG) }} g）</option>
          </select></span>
        <span><label>分出质量</label><input v-model="split.mass" type="number" step="any" style="width:90px" /></span>
        <span><label>单位</label>
          <select v-model="split.unit"><option v-for="u in massUnits" :key="u">{{ u }}</option></select></span>
        <span><label>子样编号</label><input v-model="split.code" placeholder="ALQ-001" /></span>
        <button @click="doSplit">执行分样</button>
      </div>
    </div>
  </div>

  <!-- 选中样品：称量 + 检测 -->
  <div class="grid" v-if="selected">
    <div class="panel">
      <h2>称量记录 — {{ selected.code }}</h2>
      <div class="row">
        <span><label>类型</label>
          <select v-model="weigh.kind"><option value="CONSUME">取样消耗</option><option value="INTAKE">补入</option></select></span>
        <span><label>读数</label><input v-model="weigh.value" type="number" step="any" style="width:90px" /></span>
        <span><label>单位</label>
          <select v-model="weigh.unit"><option v-for="u in massUnits" :key="u">{{ u }}</option></select></span>
        <span><label>事由</label><input v-model="weigh.reason" placeholder="消解取样" /></span>
        <button @click="doWeigh">登记（草稿）</button>
      </div>
      <table style="margin-top:8px">
        <thead><tr><th>读数</th><th>净重 (g)</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="w in weighings" :key="w.id">
            <td class="mono">{{ w.inputValue }} {{ w.inputUnit }}（{{ w.kind === 'CONSUME' ? '消耗' : '补入' }}）</td>
            <td class="mono">{{ fmt(w.netG) }}</td>
            <td><span class="badge">{{ statusLabel(w.status) }}</span>
              <span v-if="w.correctsId" class="small"> 更正自 {{ w.correctsId.slice(0, 8) }}</span></td>
            <td>
              <button v-if="w.status === 'DRAFT'" @click="doConfirm(w)">确认</button>
              <template v-if="w.status === 'CONFIRMED'">
                <input v-model="correction[w.id]" type="number" step="any" placeholder="更正读数(g)" style="width:100px" />
                <button class="warn" @click="doCorrect(w)">更正</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="panel">
      <h2>检测记录 — {{ selected.code }}</h2>
      <div class="row">
        <span><label>项目</label><input v-model="test.analyte" placeholder="Pb" style="width:70px" /></span>
        <span><label>原始值</label><input v-model="test.rawValue" type="number" step="any" style="width:90px" /></span>
        <span><label>单位</label>
          <select v-model="test.unit"><option v-for="u in concUnits" :key="u">{{ u }}</option></select></span>
        <span><label>检出限</label><input v-model="test.detectionLimit" type="number" step="any" style="width:80px" /></span>
        <span><label>稀释倍数</label><input v-model="test.dilutionFactor" type="number" step="any" style="width:70px" /></span>
        <button @click="doTest">录入</button>
      </div>
      <table style="margin-top:8px">
        <thead><tr><th>项目</th><th>原始值</th><th>检出限</th><th>稀释</th><th>校正 (mg/kg)</th></tr></thead>
        <tbody>
          <tr v-for="t in tests" :key="t.id" :class="{ 'below-dl': t.belowDl }">
            <td>{{ t.analyte }}</td>
            <td class="mono">{{ t.rawValue }} {{ t.rawUnit }}</td>
            <td class="mono">{{ t.detectionLimit }}</td>
            <td class="mono">×{{ t.dilutionFactor }}</td>
            <td class="mono">{{ t.belowDl ? '<DL（不参与平均）' : t.correctedMgPerKg }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="summary" class="msg ok">
        {{ summary.analyte }} 平均：<b>{{ summary.averageMgPerKg ?? '—' }}</b> mg/kg
        （检出 {{ summary.detectCount }} 条，低于检出限 {{ summary.belowDlCount }} 条已排除，不按 0 计）
      </div>
      <div class="row" style="margin-top:6px">
        <input v-model="summaryAnalyte" placeholder="查询项目，如 Pb" style="width:130px" />
        <button class="ghost" @click="doSummary">计算平均</button>
        <button class="ghost" @click="doReconcile">台账对账</button>
        <span v-if="reconcile" class="small">
          现存 {{ reconcile.availableG }} g = 台账 {{ reconcile.ledgerSumG }} g
          {{ reconcile.consistent ? '✔ 一致' : '✘ 不一致' }}
        </span>
      </div>
    </div>
  </div>

  <!-- 谱系图 -->
  <div class="panel" v-if="lineage">
    <h2>谱系图 — 剩余量 / 容器 / 检测记录</h2>
    <LineageNode v-if="rootNode" :node="rootNode" :nodes="lineage.nodes" :edges="lineage.edges" :rootId="lineage.root" />
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api, idemKey } from './api';
import LineageNode from './components/LineageNode.vue';

const massUnits = ['g', 'kg', 'mg', 'ug'];
const concUnits = ['mg/kg', 'ug/kg', 'g/kg', '%', 'mg/L', 'ug/L', 'g/L', 'ng/mL'];

const samples = ref([]);
const containers = ref([]);
const selectedId = ref(null);
const weighings = ref([]);
const tests = ref([]);
const lineage = ref(null);
const summary = ref(null);
const reconcile = ref(null);
const summaryAnalyte = ref('Pb');
const message = ref('');
const messageType = ref('ok');
const correction = reactive({});

const intake = reactive({ code: '', mass: '', unit: 'kg', containerId: '' });
const mix = reactive({ code: '', containerId: '', sources: [] });
const split = reactive({ parentId: '', code: '', mass: '', unit: 'g' });
const weigh = reactive({ kind: 'CONSUME', value: '', unit: 'g', reason: '' });
const test = reactive({ analyte: 'Pb', rawValue: '', unit: 'mg/L', detectionLimit: '', dilutionFactor: '1' });

const selected = computed(() => samples.value.find((s) => s.id === selectedId.value));
const rootNode = computed(() => {
  if (!lineage.value) return null;
  // 树的根 = 没有入边的节点
  const hasParent = new Set(lineage.value.edges.map((e) => e.to));
  return lineage.value.nodes.find((n) => !hasParent.has(n.id)) ?? lineage.value.nodes[0];
});

const fmt = (v) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
const kindLabel = (k) => ({ ORIGINAL: '原样', MIXTURE: '混样', ALIQUOT: '分样' }[k]);
const statusLabel = (s) => ({ DRAFT: '草稿', CONFIRMED: '已确认', CORRECTED: '已更正' }[s]);

function flash(text, ok = true) {
  message.value = text;
  messageType.value = ok ? 'ok' : 'err';
}
async function run(fn, okText) {
  try { const r = await fn(); if (okText) flash(okText); await refresh(); return r; }
  catch (e) { flash(e.message, false); }
}
async function refresh() {
  samples.value = await api.get('/samples');
  if (selectedId.value) await select(selectedId.value);
}
async function select(id) {
  selectedId.value = id;
  [weighings.value, tests.value, lineage.value] = await Promise.all([
    api.get(`/weighings/sample/${id}`),
    api.get(`/samples/${id}/tests`),
    api.get(`/samples/${id}/lineage`),
  ]);
  summary.value = null; reconcile.value = null;
}

const doIntake = () => run(async () => {
  const body = { ...intake, containerId: intake.containerId || undefined };
  await api.post('/samples/intake', { ...body, idempotencyKey: idemKey('intake', body) });
}, `已入库 ${intake.code}`);

const doMix = () => run(async () => {
  const body = { code: mix.code, containerId: mix.containerId || undefined, sources: mix.sources };
  const r = await api.post('/samples/mix', { ...body, idempotencyKey: idemKey('mix', body) });
  flash(`混样 ${r.sample.code} 产出 ${r.totalMassG} g`);
});

const doSplit = () => run(async () => {
  const body = { parentId: split.parentId, code: split.code, mass: split.mass, unit: split.unit };
  const r = await api.post('/samples/split', { ...body, idempotencyKey: idemKey('split', body) });
  flash(`分样 ${r.sample.code} = ${r.sample.availableMassG} g，母样余 ${r.parent.remainingG} g`);
});

const doWeigh = () => run(async () => {
  const body = { sampleId: selectedId.value, ...weigh };
  const r = await api.post('/weighings', { ...body, idempotencyKey: idemKey('weigh', body) });
  flash(r.replayed ? '重复提交：已返回原记录，未重复登记' : '称量草稿已登记，确认后才扣减库存');
});

const doConfirm = (w) => run(() => api.post(`/weighings/${w.id}/confirm`), '已确认并扣减库存');

const doCorrect = (w) => run(async () => {
  const value = correction[w.id];
  const body = { value, unit: 'g', reason: '前台更正' };
  const r = await api.post(`/weighings/${w.id}/corrections`, { ...body, idempotencyKey: idemKey('corr', { w: w.id, value }) });
  flash(`已生成更正记录，库存调整 ${r.adjustmentG} g`);
});

const doTest = () => run(async () => {
  await api.post(`/samples/${selectedId.value}/tests`, { ...test });
}, '检测值已录入（保留原始单位/检出限/稀释倍数）');

const doSummary = () => run(async () => {
  summary.value = await api.get(`/samples/${selectedId.value}/tests/summary?analyte=${encodeURIComponent(summaryAnalyte.value)}`);
});

const doReconcile = () => run(async () => {
  reconcile.value = await api.get(`/samples/${selectedId.value}/reconcile`);
});

onMounted(async () => {
  containers.value = await api.get('/containers');
  await refresh();
  if (samples.value.length >= 2) {
    mix.sources = [
      { sampleId: samples.value[0].id, mass: '', unit: 'g' },
      { sampleId: samples.value[1].id, mass: '', unit: 'g' },
    ];
  }
  if (samples.value.length) await select(samples.value[0].id);
});
</script>
