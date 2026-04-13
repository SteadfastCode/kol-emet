<template>
  <div class="block gallery-block">
    <div class="block-toolbar">
      <span class="block-type-label">Gallery</span>
    </div>
    <div class="gallery-placeholder">Image hosting coming soon.</div>
  </div>
</template>

<script setup>
defineProps({ block: Object, canEdit: Boolean });
</script>

<style scoped>
.gallery-placeholder {
  font-size: 13px; color: #444; padding: 12px 0;
  border: 1px dashed #2a2a2a; border-radius: 7px; text-align: center;
}
</style>
