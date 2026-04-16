import { ref } from 'vue';

const toasts = ref([]);
let nextId = 1;

export function useToasts() {
  function addToast({ message, actorLabel, actorType, entityId, entityTitle, snapshot, changeType }) {
    const id = nextId++;
    toasts.value.push({ id, message, actorLabel, actorType, entityId, entityTitle, snapshot, changeType });
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id);
    }, 6000);
  }

  function dismissToast(id) {
    toasts.value = toasts.value.filter(t => t.id !== id);
  }

  return { toasts, addToast, dismissToast };
}
