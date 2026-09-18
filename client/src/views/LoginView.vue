<template>
  <div class="login-wrap">
    <div class="login-box">
      <h1>Kol Emet</h1>
      <p v-if="notice" class="login-notice" role="status">{{ notice }}</p>

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

          <fieldset v-if="mode === 'register' && templates.length" class="template-picker" :disabled="loading">
            <legend>Start with</legend>
            <label v-for="t in templates" :key="t.key" class="template-option">
              <input v-model="template" type="radio" name="template" :value="t.key" />
              <span class="template-text">
                <span class="template-name">{{ t.name }}</span>
                <span class="template-desc">{{ t.description }}</span>
              </span>
            </label>
          </fieldset>

          <p v-if="error" class="login-error">{{ error }}</p>

          <button type="submit" class="btn-sm primary full" :disabled="loading || !email || !password">
            {{ loading ? '…' : mode === 'login' ? 'Sign in' : 'Create account' }}
          </button>
        </form>

        <p v-if="mode === 'register'" class="login-disclosure">
          You can delete your account and all of its data at any time from Settings.
        </p>

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
import { login, register, getTemplates, loginWithPasskey, registerPasskey } from '../api/auth.js';

// Shown above the form; App passes one after an account is deleted.
defineProps({ notice: { type: String, default: '' } });

const emit = defineEmits(['login-success']);

const mode  = ref('login');
const step  = ref('form');   // 'form' | 'passkey-prompt'
const email    = ref('');
const password = ref('');
const error    = ref('');
const loading  = ref(false);

// The "Start with" picker. Fetched the first time the form enters register
// mode (sign-in never needs it), and fetched again on a later visit if that
// failed. With no list there is no picker, and registration names no template,
// so the server seeds its default — a signup never waits on this.
const DEFAULT_TEMPLATE = 'worldbuilding';
const templates = ref([]);   // [{ key, name, description }] from GET /templates
const template  = ref(DEFAULT_TEMPLATE);
let templatesLoading = false;

async function loadTemplates() {
  if (templates.value.length || templatesLoading) return;
  templatesLoading = true;
  try {
    const list = await getTemplates();
    templates.value = Array.isArray(list) ? list : [];
    if (templates.value.length && !templates.value.some((t) => t.key === template.value)) {
      template.value = templates.value[0].key;
    }
  } catch (err) {
    console.warn('[LoginView] GET /templates failed; signing up without a picker (server default template):', err.message);
  } finally {
    templatesLoading = false;
  }
}

function switchMode(m) {
  mode.value = m;
  error.value = '';
  if (m === 'register') loadTemplates();
}

async function submit() {
  error.value = '';
  loading.value = true;
  try {
    if (mode.value === 'login') {
      await login(email.value, password.value);
      emit('login-success');
    } else {
      await register(email.value, password.value, templates.value.length ? template.value : undefined);
      step.value = 'passkey-prompt';
    }
  } catch (err) {
    error.value = err.status === 409
      ? 'An account with that email already exists.'
      : err.status === 401
      ? 'Invalid email or password.'
      // The server throttles failed sign-ins (KOL-035). "Try again" is exactly
      // the wrong advice here, so say what to do instead.
      : err.status === 429
      ? 'Too many sign-in attempts. Wait a few minutes and try again.'
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
    } else if (err.status === 429) {
      // Throttled by address, so the password would be refused too — do not
      // send them to a door that is also shut.
      error.value = 'Too many sign-in attempts. Wait a few minutes and try again.';
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

.login-notice {
  font-size: 13px;
  color: #9fd4a8;
  background: #0f1d14;
  border: 1px solid #1f3a28;
  border-radius: 8px;
  padding: 8px 12px;
  margin: 0 0 1rem;
  line-height: 1.5;
}

.template-picker {
  border: none;
  margin: 4px 0 0;
  padding: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.template-picker:disabled { opacity: 0.5; }

.template-picker legend {
  font-size: 12px;
  color: #888;
  padding: 0;
  margin-bottom: 6px;
}

.template-option {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #2a2a2a;
  border-radius: 8px;
  cursor: pointer;
}

.template-option:has(input:checked) {
  border-color: #555;
  background: #121212;
}

/* Undo the text-input styling above for the radios. */
.template-picker input[type="radio"] {
  width: auto;
  margin: 2px 0 0;
  padding: 0;
  border: none;
  background: none;
  accent-color: #e0e0e0;
  flex-shrink: 0;
}

.template-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.template-name {
  font-size: 13px;
  color: #e0e0e0;
}

.template-desc {
  font-size: 12px;
  color: #777;
  line-height: 1.4;
}

.login-disclosure {
  font-size: 12px;
  color: #777;
  margin: 10px 0 0;
  line-height: 1.5;
}
</style>
