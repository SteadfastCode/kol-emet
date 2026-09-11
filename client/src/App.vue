<template>
  <LoginView v-if="!isAuthenticated" :notice="notice" @login-success="onLoginSuccess" />
  <WikiLayout v-else @logout="isAuthenticated = false" @account-deleted="onAccountDeleted" />
</template>

<script setup>
import { ref, onMounted } from 'vue';
import LoginView from './views/LoginView.vue';
import WikiLayout from './components/WikiLayout.vue';
import { getSession } from './api/auth.js';

const isAuthenticated = ref(false);
const notice = ref('');

onMounted(async () => {
  try {
    await getSession();
    isAuthenticated.value = true;
  } catch {
    isAuthenticated.value = false;
  }
});

function onLoginSuccess() {
  notice.value = '';
  isAuthenticated.value = true;
}

// The server has already ended the session; this is the signed-out landing.
function onAccountDeleted() {
  notice.value = 'Your account and all of its data have been deleted.';
  isAuthenticated.value = false;
}
</script>
