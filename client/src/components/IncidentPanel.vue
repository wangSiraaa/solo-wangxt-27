<template>
  <div class="panel">
    <h2>污染事件与复测</h2>

    <div class="row">
      <span><label>新工具编号</label><input v-model="toolCode" placeholder="PIP-1" style="width:90px" /></span>
      <button class="ghost" @click="addTool">登记工具</button>
      <span><label>接触登记：工具</label>
        <select v-model="contact.toolId"><option v-for="t in tools" :key="t.id" :value="t.id">{{ t.code }}</option></select></span>
      <span><label>样品</label>
        <select v-model="contact.sampleId"><option v-for="s in samples" :key="s.id" :value="s.id">{{ s.code }}</option></select></span>
      <span><label>接触时间</label><input v-model="contact.contactAt" type="datetime-local" /></span>
      <button class="ghost" @click="addContact">登记接触</button>
    </div>

    <div class="row">
      <span><label>事件编号</label><input v-model="incident.code" placeholder="INC-01" style="width:90px" /></span>
      <span><label>窗口起</label><input v-model="incident.windowStart" type="datetime-local" /></span>
      <span><label>窗口止</label><input v-model="incident.windowEnd" type="datetime-local" /></span>
      <span><label>事由</label><input v-model="incident.reason" placeholder="清洗失误" /></span>
      <button @click="createIncident">创建事件</button>
    </div>

    <div class="row" v-if="incidents.length">
      <span><label>事件</label>
        <select v-model="selectedIncidentId" @change="loadIncident">
          <option v-for="i in incidents" :key="i.id" :value="i.id">{{ i.code }}（{{ i.toolCode }}）</option>
        </select></span>
      <template v-if="detail">
        <span class="small">窗口 {{ fmtT(detail.windowStart) }} ~ {{ fmtT(detail.windowEnd) }}</span>
        <span><label>修订窗口</label><input v-model="revise.windowStart" type="datetime-local" /></span>
        <input v-model="revise.windowEnd" type="datetime-local" />
        <input v-model="revise.reason" placeholder="修订依据（如查证重新清洗时间）" style="width:220px" />
        <button class="warn" @click="reviseWindow">修订窗口</button>
        <button @click="generatePlan">生成复测方案</button>
      </template>
    </div>

    <table v-if="detail && detail.impacts.length" style="margin-top:8px">
      <thead><tr><th>样品</th><th>类型</th><th>影响状态</th><th>依据</th><th>有效报告</th><th>裁定</th></tr></thead>
      <tbody>
        <tr v-for="i in detail.impacts" :key="i.sampleId">
          <td class="mono">{{ i.sampleCode }}</td>
          <td>{{ kindLabel(i.kind) }}</td>
          <td><span class="badge" :class="i.status">{{ statusLabel(i.status) }}</span>
            <span v-if="i.manual" class="small">（人工）</span></td>
          <td class="small">{{ i.basis }}</td>
          <td>{{ i.activeReports }}</td>
          <td>
            <input v-model="basis[i.sampleId]" placeholder="依据（必填）" style="width:150px" />
            <button class="warn" @click="confirmImpact(i)">确认污染</button>
            <button class="ghost" @click="clearImpact(i)">排除</button>
          </td>
        </tr>
      </tbody>
    </table>

    <div v-for="p in plans" :key="p.id" style="margin-top:10px">
      <h2>{{ p.code }} <span class="badge" :class="p.status">{{ planLabel(p.status) }}</span></h2>
      <div v-if="p.notes && p.notes.length" class="msg err" style="background:#fff7ed;color:#9a3412">
        <div v-for="(n, i) in p.notes" :key="i">⚠ {{ n }}</div>
      </div>
      <table>
        <thead><tr><th>原样</th><th>项目</th><th>需量 (g)</th><th>可行性</th><th>状态</th><th>录入复测结果</th></tr></thead>
        <tbody>
          <tr v-for="it in p.items" :key="it.id">
            <td class="mono">{{ it.sampleCode }}</td>
            <td>{{ it.analyte }}</td>
            <td class="mono">{{ it.requiredMassG }}</td>
            <td><span v-if="it.feasible">可行</span><span v-else class="below-dl">不可判定：{{ it.reason }}</span></td>
            <td><span class="badge">{{ itemLabel(it.status) }}</span></td>
            <td v-if="it.status === 'RESERVED'">
              <input v-model="result[it.id].rawValue" type="number" step="any" placeholder="值" style="width:70px" />
              <input v-model="result[it.id].detectionLimit" type="number" step="any" placeholder="检出限" style="width:70px" />
              <input v-model="result[it.id].amendsId" placeholder="修订旧报告ID(可空)" style="width:130px" />
              <button @click="enterResult(p, it)">提交</button>
            </td>
            <td v-else-if="it.testRecordId" class="small">已出结果 {{ it.testRecordId.slice(0, 8) }}</td>
            <td v-else>—</td>
          </tr>
        </tbody>
      </table>
      <div class="row" style="margin-top:4px">
        <button v-if="p.status === 'DRAFT'" @click="confirmPlan(p)">确认方案（预占原样）</button>
        <button v-if="p.status !== 'CANCELLED'" class="ghost" @click="cancelPlan(p)">取消并释放预占</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { api } from '../api';

const props = defineProps({ samples: Array });
const emit = defineEmits(['changed']);

const tools = ref([]);
const incidents = ref([]);
const selectedIncidentId = ref('');
const detail = ref(null);
const plans = ref([]);
const toolCode = ref('');
const contact = reactive({ toolId: '', sampleId: '', contactAt: '' });
const incident = reactive({ code: '', windowStart: '', windowEnd: '', reason: '' });
const revise = reactive({ windowStart: '', windowEnd: '', reason: '' });
const basis = reactive({});
const result = reactive({});

const kindLabel = (k) => ({ ORIGINAL: '原样', MIXTURE: '混样', ALIQUOT: '分样' }[k]);
const statusLabel = (s) => ({ CONFIRMED: '确认污染', SUSPECTED: '疑似暴露', CLEARED: '已排除' }[s]);
const planLabel = (s) => ({ DRAFT: '草案', CONFIRMED: '已确认', CANCELLED: '已取消' }[s]);
const itemLabel = (s) => ({ PENDING: '待预占', RESERVED: '已预占', DONE: '已完成', RELEASED: '已释放', INFEASIBLE: '不可判定' }[s]);
const fmtT = (t) => new Date(t).toLocaleString('zh-CN');
const iso = (v) => (v ? new Date(v).toISOString() : '');

async function run(fn) {
  try { await fn(); } catch (e) { alert(e.message); }
  await loadIncident();
  emit('changed');
}
async function loadIncident() {
  incidents.value = await api.get('/incidents');
  if (!selectedIncidentId.value && incidents.value.length) {
    selectedIncidentId.value = incidents.value[0].id;
  }
  if (!selectedIncidentId.value) return;
  detail.value = await api.get(`/incidents/${selectedIncidentId.value}`);
  const list = await api.get(`/incidents/${selectedIncidentId.value}/retest-plans`);
  plans.value = await Promise.all(list.map((p) => api.get(`/retest-plans/${p.id}`)));
  for (const p of plans.value) {
    for (const it of p.items) {
      if (!result[it.id]) result[it.id] = { rawValue: '', detectionLimit: '1', amendsId: '' };
    }
  }
}

const addTool = () => run(async () => {
  await api.post('/tools', { code: toolCode.value });
  tools.value = await api.get('/tools');
});
const addContact = () => run(async () => {
  await api.post('/tool-contacts', { ...contact, contactAt: iso(contact.contactAt) });
});
const createIncident = () => run(async () => {
  const d = await api.post('/incidents', {
    ...incident, toolId: contact.toolId || tools.value[0]?.id,
    windowStart: iso(incident.windowStart), windowEnd: iso(incident.windowEnd),
  });
  selectedIncidentId.value = d.id;
});
const reviseWindow = () => run(async () => {
  await api.post(`/incidents/${selectedIncidentId.value}/revise-window`, {
    windowStart: iso(revise.windowStart), windowEnd: iso(revise.windowEnd), reason: revise.reason,
  });
});
const confirmImpact = (i) => run(() => api.post(`/incidents/${detail.value.id}/impacts/${i.sampleId}/confirm`, { basis: basis[i.sampleId] }));
const clearImpact = (i) => run(() => api.post(`/incidents/${detail.value.id}/impacts/${i.sampleId}/clear`, { basis: basis[i.sampleId] }));
const generatePlan = () => run(() => api.post(`/incidents/${selectedIncidentId.value}/retest-plans`));
const confirmPlan = (p) => run(() => api.post(`/retest-plans/${p.id}/confirm`));
const cancelPlan = (p) => run(() => api.post(`/retest-plans/${p.id}/cancel`));
const enterResult = (p, it) => run(async () => {
  const r = result[it.id];
  await api.post(`/retest-plans/${p.id}/items/${it.id}/result`, {
    rawValue: r.rawValue, unit: 'mg/kg', detectionLimit: r.detectionLimit,
    amendsId: r.amendsId || undefined,
  });
});

onMounted(async () => {
  tools.value = await api.get('/tools');
  await loadIncident();
});
</script>

<style scoped>
.badge.CONFIRMED { background: #fde8e8; color: #c53030; }
.badge.SUSPECTED { background: #fff7ed; color: #c05621; }
.badge.CLEARED { background: #e6f4ea; color: #276749; }
.badge.DRAFT { background: #edf2f7; color: #4a5568; }
.badge.CANCELLED { background: #edf2f7; color: #a0aec0; }
</style>
