<template>
  <div class="tree">
    <div class="node" :class="{ root: isRoot }">
      <span class="badge" :class="node.kind">{{ kindLabel }}</span>
      <strong> {{ node.code }}</strong>
      <div>剩余 <span class="mass">{{ fmt(node.availableMassG) }} g</span>
        <span class="small"> · 容器 {{ node.containerCode ?? '—' }}</span>
      </div>
      <div class="tests" v-if="node.tests && node.tests.length">
        <span v-for="(t, i) in node.tests" :key="i" :class="{ 'below-dl': t.belowDl }">
          {{ t.analyte }} {{ t.belowDl ? '<' + t.detectionLimit : t.correctedMgPerKg }} mg/kg
        </span>
      </div>
    </div>
    <ul v-if="children.length">
      <li v-for="c in children" :key="c.node.id">
        <span class="edge-label">↓ 消耗 {{ fmt(c.massUsedG) }} g</span>
        <LineageNode :node="c.node" :edges="edges" :nodes="nodes" :rootId="rootId" />
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  node: Object,      // 当前节点
  nodes: Array,      // 全部节点
  edges: Array,      // 全部边 {from,to,massUsedG}
  rootId: String,
});
const isRoot = computed(() => props.node.id === props.rootId);
const children = computed(() =>
  props.edges
    .filter((e) => e.from === props.node.id)
    .map((e) => ({ massUsedG: e.massUsedG, node: props.nodes.find((n) => n.id === e.to) }))
    .filter((c) => c.node),
);
const kindLabel = computed(() => ({ ORIGINAL: '原样', MIXTURE: '混样', ALIQUOT: '分样' }[props.node.kind]));
const fmt = (v) => Number(v).toLocaleString('zh-CN', { maximumFractionDigits: 6 });
</script>

<script>
export default { name: 'LineageNode' };
</script>
