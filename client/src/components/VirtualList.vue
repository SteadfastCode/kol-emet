<template>
  <div ref="scrollEl" class="virtual-scroll">
    <div :style="{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }">
      <div
        v-for="vRow in virtualizer.getVirtualItems()"
        :key="vRow.key"
        :style="{
          position: 'absolute',
          top: 0, left: 0,
          width: '100%',
          transform: `translateY(${vRow.start}px)`,
          height: `${vRow.size}px`,
        }"
      >
        <slot :item="items[vRow.index]" :index="vRow.index" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useVirtualizer } from '@tanstack/vue-virtual';

const props = defineProps({
  items: Array,
  itemHeight: { type: Number, default: 64 },
  overscan: { type: Number, default: 5 },
});

const scrollEl = ref(null);

// Options must be a computed ref so the watcher inside useVirtualizer
// calls setOptions() with the new count when items change.
const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.items?.length ?? 0,
    getScrollElement: () => scrollEl.value,
    estimateSize: () => props.itemHeight,
    overscan: props.overscan,
  }))
);
</script>

<style scoped>
.virtual-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
</style>
