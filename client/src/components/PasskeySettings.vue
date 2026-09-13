<template>
  <div class="passkey-settings">
    <p class="passkey-note">
      A passkey stays on the device or password manager that made it. Add one on each device you
      sign in from.
    </p>

    <p v-if="loading" class="passkey-note">Loading…</p>
    <p v-else-if="loadError" class="passkey-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!passkeys.length" class="passkey-note">No passkeys yet.</p>
    <ul v-else class="passkey-list">
      <li v-for="pk in passkeys" :key="pk.credentialID" class="passkey-item">
        <div class="passkey-info">
          <span class="passkey-kind">{{ kindOf(pk) }}</span>
          <span class="passkey-dates">
            Added {{ formatDate(pk.createdAt) }} ·
            {{ pk.lastUsedAt ? `last used ${formatDate(pk.lastUsedAt)}` : 'no sign-in recorded' }}
          </span>
        </div>
        <div v-if="confirmingId === pk.credentialID" class="passkey-actions">
          <button type="button" class="mini danger" :disabled="!!busy" @click="remove(pk)">
            {{ busy === pk.credentialID ? 'Removing…' : 'Remove' }}
          </button>
          <button type="button" class="mini" :disabled="!!busy" @click="confirmingId = null">Keep</button>
        </div>
        <button
          v-else
          type="button"
          class="mini"
          :disabled="!!busy || !canRemove"
          :title="canRemove ? '' : 'Your only way to sign in'"
          @click="confirmingId = pk.credentialID"
        >Remove</button>
      </li>
    </ul>

    <p v-if="error" class="passkey-error" role="alert">{{ error }}</p>

    <button type="button" class="row" :disabled="!!busy || !supported" @click="add">
      {{ busy === 'add' ? 'Waiting for your device…' : 'Add a passkey on this device' }}
    </button>
    <p v-if="!supported" class="passkey-note">This browser can't make passkeys.</p>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { listPasskeys, registerPasskey, removePasskey, passkeysSupported } from '../api/auth.js';

// Tiered debug logging, for the phone a passkey misbehaves on. Set
// localStorage.PASSKEY_LOG_LEVEL to off | light | normal | verbose (default
// light). The server logs the same events on its own PASSKEY_LOG_LEVEL.
//   light   — every passkey added or removed from here, and every failure,
//             naming the action that did it
//   normal  — light, plus each list shown and where it came from
//   verbose — normal, plus the first characters of the credential ids
const LEVELS = { off: 0, light: 1, normal: 2, verbose: 3 };

function log(level, msg) {
  let setting = null;
  try { setting = localStorage.getItem('PASSKEY_LOG_LEVEL'); } catch { /* storage blocked */ }
  if ((LEVELS[setting] ?? LEVELS.light) >= LEVELS[level]) console.log(`[settings/passkeys:${level}] ${msg}`);
}

const passkeys     = ref([]);
const hasPassword  = ref(true);
const loading      = ref(true);
const loadError    = ref('');
const error        = ref('');
const busy         = ref(null);   // null | 'add' | the credentialID being removed
const confirmingId = ref(null);
const supported    = passkeysSupported();

// The server refuses to remove an account's last way to sign in; this only
// spares the round trip.
const canRemove = computed(() => hasPassword.value || passkeys.value.length > 1);

const SESSION_EXPIRED = 'Your session has expired. Sign in again to manage passkeys.';

function kindOf(pk) {
  if (pk.backedUp || pk.deviceType === 'multiDevice') return 'Synced passkey';
  if (pk.deviceType === 'singleDevice') return 'This device only';
  return 'Passkey'; // added before sync status was recorded; its next sign-in fills it in
}

function formatDate(value) {
  return value
    ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';
}

function show(list, source) {
  passkeys.value = list.passkeys;
  hasPassword.value = list.hasPassword;
  log('normal', `${list.passkeys.length} passkey(s), ${list.hasPassword ? 'with' : 'no'} password (source: ${source})`);
  log('verbose', `ids: ${list.passkeys.map(pk => `${pk.credentialID.slice(0, 8)}…`).join(', ') || 'none'}`);
}

async function load() {
  try {
    show(await listPasskeys(), 'GET /auth/webauthn/passkeys');
    loadError.value = '';
  } catch (err) {
    log('light', `loading passkeys failed: ${err.status ?? err.message} (source: GET /auth/webauthn/passkeys)`);
    loadError.value = err.status === 401 ? SESSION_EXPIRED : 'Could not load your passkeys.';
  } finally {
    loading.value = false;
  }
}

function addErrorFor(err) {
  if (err.name === 'NotAllowedError') return ''; // the prompt was dismissed
  if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'This device already has a passkey for your account.';
  if (err.status === 401) return SESSION_EXPIRED;
  return 'Could not add a passkey. Please try again.';
}

async function add() {
  error.value = '';
  busy.value = 'add';
  try {
    await registerPasskey();
    log('light', 'passkey added (source: Settings → Add a passkey on this device)');
    await load();
  } catch (err) {
    log('light', `adding a passkey failed: ${err.name} ${err.code ?? err.status ?? err.message} (source: Settings → Add a passkey on this device)`);
    error.value = addErrorFor(err);
  } finally {
    busy.value = null;
  }
}

async function remove(pk) {
  error.value = '';
  busy.value = pk.credentialID;
  try {
    show(await removePasskey(pk.credentialID), 'DELETE /auth/webauthn/passkeys/:credentialID');
    log('light', `passkey removed, ${kindOf(pk)} (source: Settings → Remove)`);
    confirmingId.value = null;
  } catch (err) {
    log('light', `removing a passkey failed: ${err.status ?? err.message} (source: Settings → Remove)`);
    // 409 is the account's last way in and 404 one already gone, both in the server's words.
    error.value = err.status === 401 ? SESSION_EXPIRED
      : err.status === 409 || err.status === 404 ? err.message
      : 'Could not remove the passkey. Please try again.';
    if (err.status === 404) await load();
  } finally {
    busy.value = null;
  }
}

onMounted(load);
</script>

<style scoped>
.passkey-settings { display: flex; flex-direction: column; gap: 8px; }

.passkey-note { font-size: 12px; color: #777; line-height: 1.5; margin: 0; }
.passkey-error { font-size: 12px; color: #e07070; margin: 0; }

.passkey-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

.passkey-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
}

.passkey-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.passkey-kind { font-size: 14px; color: #ccc; }
.passkey-dates { font-size: 12px; color: #777; }

.passkey-actions { display: flex; gap: 6px; }

.mini {
  flex-shrink: 0;
  padding: 6px 10px;
  background: none;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #aaa;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.mini:hover:not(:disabled) { background: #1a1a1a; }
.mini:disabled { opacity: 0.4; cursor: default; }
.mini.danger { color: #e07070; border-color: #3a1a1a; }

.row {
  display: flex;
  align-items: center;
  width: 100%;
  padding: 12px 16px;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
  color: #ccc;
  font-size: 14px;
  font-family: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.1s;
}
.row:hover:not(:disabled) { background: #1a1a1a; }
.row:disabled { opacity: 0.5; cursor: default; }
</style>
