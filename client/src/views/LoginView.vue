<template>
  <div class="login-wrap">
    <div class="login-box">
      <h1>Kol Emet</h1>

      <!-- Passkey prompt after registration -->
      <template v-if="step === 'passkey-prompt'">
        <p class="login-sub">Account created! Add a passkey for faster sign-in next time?</p>
        <button class="btn-sm primary full" @click="doRegisterPasskey" :disabled="loading">
          {{ loading ? 'Setting up…' : 'Add passkey' }}
        </button>
        <button class="btn-sm full" style="margin-top:8px" @click="emit('login-success')">
          Skip for now
        </button>
        <p v-if="error" class="login-error">{{ error }}</p>
      </template>

      <!-- Login / Register form -->
      <template v-else>
        <div class="tab-row">
          <button
            class="tab" :class="{ active: mode === 'login' }"
            @click="switchMode('login')"
          >Sign in</button>
          <button
            class="tab" :class="{ active: mode === 'register' }"
            @click="switchMode('register')"
          >Create account</button>
        </div>

        <form @submit.prevent="submit" autocomplete="on">
          <input
            v-model="email"
            type="email"
            name="email"
            autocomplete="email"
            placeholder="Email"
            :disabled="loading"
            required
          />
          <input
            v-model="password"
            type="password"
            :name="mode === 'login' ? 'password' : 'new-password'"
            :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
            placeholder="Password"
            :disabled="loading"
            required
          />

          <p v-if="error" class="login-error">{{ error }}</p>

          <button type="submit" class="btn-sm primary full" :disabled="loading || !email || !password">
            {{ loading ? '…' : mode === 'login' ? 'Sign in' : 'Create account' }}
          </button>
        </form>

        <template v-if="mode === 'login'">
          <div class="divider"><span>or</span></div>
          <button class="btn-sm full passkey-btn" @click="doPasskeyLogin" :disabled="loading">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="7" r="4"/><path d="M12 11v4"/><path d="M9 18h6"/><path d="M6 21v-1a6 6 0 0 1 12 0v1"/>
            </svg>
            Sign in with passkey
          </button>
        </template>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { login, register, loginWithPasskey, registerPasskey } from '../api/auth.js';

const emit = defineEmits(['login-success']);

const mode  = ref('login');
const step  = ref('form');   // 'form' | 'passkey-prompt'
const email    = ref('');
const password = ref('');
const error    = ref('');
const loading  = ref(false);

function switchMode(m) {
  mode.value = m;
  error.value = '';
}

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (mode.value === 'login') {
      await login(email.value, password.value);
      emit('login-success');
    } else {
      await register(email.value, password.value);
      step.value = 'passkey-prompt';
    }
  } catch (err) {
    error.value = err.status === 409
      ? 'An account with that email already exists.'
      : err.status === 401
      ? 'Invalid email or password.'
      : 'Something went wrong. Please try again.';
  } finally {
    loading.value = false;
  }
}

async function doPasskeyLogin() {
  error.value = '';
  loading.value = true;
  try {
    await loginWithPasskey(email.value);
    emit('login-success');
  } catch (err) {
    if (err.message?.includes('cancelled') || err.name === 'NotAllowedError') {
      error.value = '';
    } else {
      error.value = 'Passkey sign-in failed. Try your password instead.';
    }
  } finally {
    loading.value = false;
  }
}

async function doRegisterPasskey() {
  error.value = '';
  loading.value = true;
  try {
    await registerPasskey();
    emit('login-success');
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      emit('login-success');
    } else {
      error.value = 'Could not set up passkey. You can add one later in settings.';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}

.login-box {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 1.75rem;
  width: 100%;
  max-width: 340px;
}

h1 {
  font-size: 1.25rem;
  font-weight: 500;
  color: #e0e0e0;
  margin-bottom: 1.25rem;
}

.login-sub {
  font-size: 13px;
  color: #888;
  margin-bottom: 1rem;
  line-height: 1.5;
}

.tab-row {
  display: flex;
  gap: 4px;
  margin-bottom: 1rem;
  border-bottom: 1px solid #2a2a2a;
}

.tab {
  flex: 1;
  background: none;
  border: none;
  padding: 6px 0 10px;
  font-size: 13px;
  color: #555;
  cursor: pointer;
  position: relative;
  transition: color 0.1s;
}

.tab:hover { color: #aaa; }

.tab.active {
  color: #e0e0e0;
}

.tab.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 0; right: 0;
  height: 1px;
  background: #e0e0e0;
}

form { display: flex; flex-direction: column; gap: 8px; }

input {
  width: 100%;
  padding: 8px 12px;
  font-size: 14px;
  border-radius: 8px;
  border: 1px solid #333;
  background: #121212;
  color: #e0e0e0;
  font-family: inherit;
}

input:focus { outline: none; border-color: #555; }
input:disabled { opacity: 0.5; }

.full { width: 100%; }

.divider {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  color: #444;
  font-size: 11px;
}

.divider::before, .divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #2a2a2a;
}

.passkey-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
}

.login-error {
  font-size: 12px;
  color: #e07070;
  margin: 0;
}
</style>
