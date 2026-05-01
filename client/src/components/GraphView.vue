<template>
  <div class="graph-view" ref="containerRef">
    <div class="graph-toolbar">
      <span class="graph-title">Relationship Graph</span>
      <span v-if="!loading && !fetchError" class="graph-stats">
        {{ nodeData.length }} nodes · {{ linkData.length }} edges
      </span>
      <button class="graph-close" title="Close graph (Escape)" @click="$emit('close')">✕</button>
    </div>

    <div v-if="loading" class="graph-overlay">Building graph…</div>
    <div v-else-if="fetchError" class="graph-overlay error">{{ fetchError }}</div>
    <div v-else-if="!linkData.length" class="graph-overlay muted">
      No relationships yet — add relationship groups to see them here.
    </div>

    <svg ref="svgRef" class="graph-svg" />

    <div v-if="!loading && !fetchError && linkData.length" class="graph-controls">
      <button class="controls-toggle" :title="controlsOpen ? 'Close settings' : 'Force simulation settings'" @click="controlsOpen = !controlsOpen">
        {{ controlsOpen ? '✕' : '⚙' }}
      </button>
      <transition name="controls-slide">
        <div v-if="controlsOpen" class="controls-panel">
          <div class="control-row">
            <label>Repulsion</label>
            <input type="range" :min="-1500" :max="-50" step="10" v-model.number="simParams.repulsion" />
            <span class="control-val">{{ simParams.repulsion }}</span>
          </div>
          <div class="control-row">
            <label>Link distance</label>
            <input type="range" min="50" max="400" step="10" v-model.number="simParams.linkDist" />
            <span class="control-val">{{ simParams.linkDist }}</span>
          </div>
          <div class="control-row">
            <label>Collision radius</label>
            <input type="range" min="10" max="120" step="5" v-model.number="simParams.collide" />
            <span class="control-val">{{ simParams.collide }}</span>
          </div>
          <button class="controls-reset" @click="resetParams">Reset defaults</button>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as d3 from 'd3';
import { CAT_COLORS } from '../config/categories.js';
import { getEntities } from '../api/entities.js';
import { getAllGroups } from '../api/relationshipGroups.js';

const emit = defineEmits(['close', 'open-entry']);

const containerRef = ref(null);
const svgRef = ref(null);
const loading = ref(true);
const fetchError = ref(null);
const nodeData = ref([]);
const linkData = ref([]);

const STORAGE_KEY = 'kol-emet-graph-params';
const DEFAULTS = { repulsion: -700, linkDist: 180, collide: 60 };

function loadParams() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? { ...DEFAULTS, ...JSON.parse(stored) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

const controlsOpen = ref(false);
const simParams = ref(loadParams());

function applySimParams() {
  if (!simulation) return;
  const { repulsion, linkDist, collide } = simParams.value;
  simulation.force('charge').strength(repulsion);
  simulation.force('link').distance(linkDist);
  simulation.force('collision').radius(collide);
  simulation.alpha(0.4).restart();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(simParams.value));
}

function resetParams() {
  simParams.value = { ...DEFAULTS };
}

watch(simParams, applySimParams, { deep: true });

let simulation = null;
let resizeObserver = null;

function truncate(str, max = 18) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function getNodeColor(category) {
  return CAT_COLORS[category]?.bg ?? '#444';
}

function getNodeStroke(category) {
  return CAT_COLORS[category]?.color ?? '#888';
}

function initGraph() {
  const container = containerRef.value;
  if (!container) return;

  const { width, height } = container.getBoundingClientRect();
  // Subtract toolbar height (~42px)
  const svgH = height - 42;

  const svg = d3.select(svgRef.value)
    .attr('width', width)
    .attr('height', svgH);

  svg.selectAll('*').remove();

  // Arrow marker for directed edges (optional — currently undirected but keep for future)
  svg.append('defs').append('marker')
    .attr('id', 'arrowhead')
    .attr('viewBox', '-0 -5 10 10')
    .attr('refX', 28)
    .attr('refY', 0)
    .attr('orient', 'auto')
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .append('path')
    .attr('d', 'M 0,-5 L 10,0 L 0,5')
    .attr('fill', '#444');

  const g = svg.append('g').attr('class', 'graph-g');

  // Zoom & pan
  const zoom = d3.zoom()
    .scaleExtent([0.05, 8])
    .on('zoom', (event) => g.attr('transform', event.transform));
  svg.call(zoom);

  // Deep-copy node/link data so D3 can mutate x/y on them
  const nodes = nodeData.value.map(n => ({ ...n }));
  const links = linkData.value.map(l => ({ ...l }));

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Build adjacency for hover highlighting
  function getNeighbors(nodeId) {
    const s = new Set();
    links.forEach(l => {
      const src = typeof l.source === 'object' ? l.source.id : l.source;
      const tgt = typeof l.target === 'object' ? l.target.id : l.target;
      if (src === nodeId) s.add(tgt);
      if (tgt === nodeId) s.add(src);
    });
    return s;
  }

  function isConnected(l, nodeId) {
    const src = typeof l.source === 'object' ? l.source.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target.id : l.target;
    return src === nodeId || tgt === nodeId;
  }

  // ── Simulation ──────────────────────────────────────────────────────────
  const { repulsion, linkDist, collide } = simParams.value;
  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(linkDist).strength(0.5))
    .force('charge', d3.forceManyBody().strength(repulsion))
    .force('center', d3.forceCenter(width / 2, svgH / 2))
    .force('collision', d3.forceCollide().radius(collide));

  // ── Links ────────────────────────────────────────────────────────────────
  const linkGroup = g.append('g').attr('class', 'links');

  const link = linkGroup.selectAll('line')
    .data(links)
    .join('line')
    .style('stroke', '#2a2a2a')
    .style('stroke-width', 1.5)
    .style('stroke-opacity', 0.8)
    .style('transition', 'stroke-opacity 150ms ease, stroke 150ms ease, stroke-width 150ms ease');

  const linkLabel = linkGroup.selectAll('text')
    .data(links.filter(l => l.label))
    .join('text')
    .text(d => d.label)
    .attr('font-size', 9)
    .style('fill', '#555')
    .attr('text-anchor', 'middle')
    .style('pointer-events', 'none')
    .style('user-select', 'none')
    .style('transition', 'opacity 150ms ease, fill 150ms ease');

  // Wider invisible lines so edges are easy to hover
  const linkHitArea = linkGroup.selectAll('.link-hit')
    .data(links)
    .join('line')
    .attr('class', 'link-hit')
    .attr('stroke', 'transparent')
    .attr('stroke-width', 12)
    .style('cursor', 'pointer');

  // ── Nodes ────────────────────────────────────────────────────────────────
  const nodeGroup = g.append('g').attr('class', 'nodes');

  const node = nodeGroup.selectAll('g')
    .data(nodes)
    .join('g')
    .attr('class', 'node')
    .style('cursor', 'pointer')
    .style('transition', 'opacity 150ms ease')
    .call(
      d3.drag()
        .on('start', (event, d) => {
          if (!event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on('drag', (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
        })
        .on('end', (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null;
          d.fy = null;
        })
    );

  node.append('circle')
    .attr('r', 20)
    .attr('fill', d => getNodeColor(d.category))
    .attr('stroke', d => getNodeStroke(d.category))
    .attr('stroke-width', 2);

  node.append('text')
    .text(d => truncate(d.title))
    .attr('font-size', 10)
    .attr('fill', '#ddd')
    .attr('text-anchor', 'middle')
    .attr('dy', 38)
    .style('pointer-events', 'none')
    .style('user-select', 'none');

  // ── Interactions ─────────────────────────────────────────────────────────
  node
    .on('mouseover', function (event, d) {
      const neighbors = getNeighbors(d.id);
      node.style('opacity', n => (n.id === d.id || neighbors.has(n.id)) ? 1 : 0.12);
      link.style('stroke-opacity', l => isConnected(l, d.id) ? 1 : 0.05)
          .style('stroke', l => isConnected(l, d.id) ? '#666' : '#2a2a2a');
      linkLabel.style('opacity', l => isConnected(l, d.id) ? 1 : 0);
    })
    .on('mouseout', function () {
      node.style('opacity', 1);
      link.style('stroke-opacity', 0.8).style('stroke', '#2a2a2a');
      linkLabel.style('opacity', 1);
    })
    .on('click', function (event, d) {
      event.stopPropagation();
      emit('open-entry', d.id, d.title);
    });

  // ── Edge hover ───────────────────────────────────────────────────────────
  function linkEndpoints(l) {
    return [
      typeof l.source === 'object' ? l.source.id : l.source,
      typeof l.target === 'object' ? l.target.id : l.target,
    ];
  }

  linkHitArea
    .on('mouseover', function (event, d) {
      const [srcId, tgtId] = linkEndpoints(d);
      link.style('stroke-opacity', l => l === d ? 1 : 0.05)
          .style('stroke', l => l === d ? '#888' : '#2a2a2a')
          .style('stroke-width', l => l === d ? 2.5 : 1.5);
      linkLabel.style('opacity', l => l === d ? 1 : 0)
               .style('fill', l => l === d ? '#aaa' : '#555');
      node.style('opacity', n => (n.id === srcId || n.id === tgtId) ? 1 : 0.12);
    })
    .on('mouseout', function () {
      link.style('stroke-opacity', 0.8).style('stroke', '#2a2a2a').style('stroke-width', 1.5);
      linkLabel.style('opacity', 1).style('fill', '#555');
      node.style('opacity', 1);
    });

  // ── Tick ─────────────────────────────────────────────────────────────────
  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    linkHitArea
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);

    linkLabel
      .attr('x', d => (d.source.x + d.target.x) / 2)
      .attr('y', d => (d.source.y + d.target.y) / 2 - 4);

    node.attr('transform', d => `translate(${d.x},${d.y})`);
  });

  // ── Keyboard close ───────────────────────────────────────────────────────
  function onKey(e) {
    if (e.key === 'Escape') emit('close');
  }
  window.addEventListener('keydown', onKey);
  // store cleanup ref on container so onBeforeUnmount can remove it
  containerRef.value._keyListener = onKey;

  // ── Resize ───────────────────────────────────────────────────────────────
  resizeObserver = new ResizeObserver(() => {
    if (!containerRef.value) return;
    const { width: w, height: h } = containerRef.value.getBoundingClientRect();
    const sh = h - 42;
    d3.select(svgRef.value).attr('width', w).attr('height', sh);
    simulation
      .force('center', d3.forceCenter(w / 2, sh / 2))
      .alpha(0.3).restart();
  });
  resizeObserver.observe(container);
}

onMounted(async () => {
  try {
    const [entities, groups] = await Promise.all([getEntities(), getAllGroups()]);

    nodeData.value = entities.map(e => ({
      id: String(e._id),
      title: e.title,
      category: e.category,
    }));

    const entityIds = new Set(nodeData.value.map(n => n.id));
    const edgeMap = new Map();

    // Build group → direct entity members map so sub-group references can be resolved
    const groupEntityMap = new Map();
    for (const group of groups) {
      const entityMembers = group.members
        .filter(m => m.refModel === 'Entity' && entityIds.has(String(m.refId)))
        .map(m => String(m.refId));
      groupEntityMap.set(String(group._id), entityMembers);
    }

    function resolveMembers(group) {
      const resolved = [];
      for (const m of group.members) {
        if (m.refModel === 'Entity' && entityIds.has(String(m.refId))) {
          resolved.push(String(m.refId));
        } else if (m.refModel === 'RelationshipGroup') {
          const subMembers = groupEntityMap.get(String(m.refId)) ?? [];
          resolved.push(...subMembers);
        }
      }
      return [...new Set(resolved)];
    }

    for (const group of groups) {
      const members = resolveMembers(group);

      if (members.length < 2) continue;

      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const key = [members[i], members[j]].sort().join(' ');
          if (!edgeMap.has(key)) {
            edgeMap.set(key, {
              source: members[i],
              target: members[j],
              label: group.label ?? '',
            });
          } else if (group.label) {
            const e = edgeMap.get(key);
            if (!e.label.split(', ').includes(group.label)) {
              e.label = e.label ? `${e.label}, ${group.label}` : group.label;
            }
          }
        }
      }
    }

    linkData.value = Array.from(edgeMap.values());
    loading.value = false;

    await nextTick();
    initGraph();
  } catch (err) {
    fetchError.value = err.message;
    loading.value = false;
  }
});

onBeforeUnmount(() => {
  if (simulation) simulation.stop();
  if (resizeObserver) resizeObserver.disconnect();
  if (containerRef.value?._keyListener) {
    window.removeEventListener('keydown', containerRef.value._keyListener);
  }
});
</script>

<style scoped>
.graph-view {
  position: absolute;
  inset: 0;
  z-index: 500;
  display: flex;
  flex-direction: column;
  background: #0a0a0a;
}

.graph-toolbar {
  flex-shrink: 0;
  height: 42px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: #0f0f0f;
  border-bottom: 1px solid #1e1e1e;
}

.graph-title {
  font-size: 13px;
  font-weight: 600;
  color: #ccc;
  letter-spacing: 0.01em;
}

.graph-stats {
  font-size: 11px;
  color: #555;
  flex: 1;
}

.graph-close {
  background: none;
  border: none;
  color: #444;
  cursor: pointer;
  font-size: 14px;
  padding: 4px 8px;
  border-radius: 4px;
  transition: color 0.1s, background 0.1s;
  margin-left: auto;
}
.graph-close:hover { color: #ccc; background: #1a1a1a; }

.graph-overlay {
  position: absolute;
  inset: 42px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  color: #555;
  pointer-events: none;
}
.graph-overlay.error { color: #e07070; }
.graph-overlay.muted { color: #444; }

.graph-svg {
  display: block;
  flex: 1;
  width: 100%;
}

/* ── Controls panel ─────────────────────────────────────────────────────── */
.graph-controls {
  position: absolute;
  bottom: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  z-index: 10;
}

.controls-toggle {
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: #161616;
  border: 1px solid #2a2a2a;
  color: #888;
  font-size: 14px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.1s, background 0.1s, border-color 0.1s;
}
.controls-toggle:hover { color: #ccc; background: #1f1f1f; border-color: #3a3a3a; }

.controls-panel {
  background: #111;
  border: 1px solid #242424;
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 220px;
}

.control-row {
  display: grid;
  grid-template-columns: 100px 1fr 40px;
  align-items: center;
  gap: 8px;
}

.control-row label {
  font-size: 11px;
  color: #777;
  white-space: nowrap;
}

.control-row input[type="range"] {
  width: 100%;
  accent-color: #4a7fa5;
  cursor: pointer;
}

.control-val {
  font-size: 11px;
  color: #555;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.controls-reset {
  margin-top: 2px;
  align-self: flex-end;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  color: #555;
  font-size: 11px;
  padding: 3px 8px;
  cursor: pointer;
  transition: color 0.1s, border-color 0.1s;
}
.controls-reset:hover { color: #aaa; border-color: #444; }

.controls-slide-enter-active,
.controls-slide-leave-active {
  transition: opacity 0.15s, transform 0.15s;
}
.controls-slide-enter-from,
.controls-slide-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
