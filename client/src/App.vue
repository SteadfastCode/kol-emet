<template>
  <LoginView v-if="!isAuthenticated" @login-success="onLoginSuccess" />
  <WikiLayout v-else @logout="isAuthenticated = false" />
</template>

<script setup>
import { ref, onMounted } from 'vue';
import LoginView from './views/LoginView.vue';
import WikiLayout from './components/WikiLayout.vue';
import { getSession } from './api/auth.js';

const isAuthenticated = ref(false);

onMounted(async () => {
  try {
    await getSession();
    isAuthenticated.value = true;
  } catch {
    isAuthenticated.value = false;
  }
});

function onLoginSuccess() {
  isAuthenticated.value = true;
}
</script>
