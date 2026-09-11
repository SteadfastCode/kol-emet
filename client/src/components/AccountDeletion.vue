<template>
  <div class="account-deletion">
    <button v-if="!confirming" type="button" class="row danger" @click="confirming = true">
      Delete account
    </button>

    <!--
      A form of its own, so credential managers see a sign-in-shaped form and
      offer the saved password (current-password). The email is a typed
      confirmation rather than a credential, so it opts out of autofill:
      filling it in for the user would defeat the point of asking.
    -->
    <form v-else class="delete-form" autocomplete="on" @submit.prevent="confirmWithPassword">
      <p class="delete-warning">
        This permanently deletes your account, your workspace and everything in it: entities,
        relationships, open questions, drafts, chats and history. It can't be undone.
      </p>

      <label class="delete-label" for="delete-account-email">Type your account email to confirm</label>
      <input
        id="delete-account-email"
        v-model="email"
        type="text"
        inputmode="email"
        name="confirm-email"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :disabled="loading"
      />

      <label class="delete-label" for="delete-account-password">Password</label>
      <input
        id="delete-account-password"
        v-model="password"
        type="password"
        name="password"
        autocomplete="current-password"
        :disabled="loading"
      />

      <p v-if="error" class="delete-error" role="alert">{{ error }}</p>
      <ul v-if="memberships.length" class="delete-memberships">
        <li v-for="m in memberships" :key="m.workspaceId">{{ m.name }} ({{ m.role }})</li>
      </ul>

      <button type="submit" class="row danger" :disabled="loading || !email.trim() || !password">
        {{ loading ? 'Deleting…' : 'Delete my account permanently' }}
      </button>
      <button type="button" class="row" :disabled="loading || !email.trim()" @click="confirmWithPasskey">
        Confirm with a passkey instead
      </button>
      <button type="button" class="row" :disabled="loading" @click="cancel">Cancel</button>
    </form>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { deleteAccount, deleteAccountWithPasskey } from '../api/auth.js';

const emit = defineEmits(['deleted']);

const confirming  = ref(false);
const email       = ref('');
const password    = ref('');
const error       = ref('');
const memberships = ref([]);
const loading     = ref(false);

function cancel() {
  confirming.value = false;
  email.value = '';
  password.value = '';
  error.value = '';
  memberships.value = [];
}

function messageFor(err) {
  if (err.status === 409) {
    return "Nothing was deleted. This account also belongs to workspaces it doesn't solely own, "
      + 'and deleting it would leave them pointing at no one:';
  }
  if (err.status === 401) return 'Your session has expired. Sign in again to delete your account.';
  // The server's own wording: wrong password, email mismatch, no passkey.
  if (err.status === 400 || err.status === 403) return err.message;
  return 'Something went wrong. Please try again.';
}

async function run(attempt) {
  error.value = '';
  memberships.value = [];
  loading.value = true;
  try {
    await attempt();
    emit('deleted');
  } catch (err) {
    if (err.name === 'NotAllowedError') return; // the passkey prompt was dismissed
    error.value = messageFor(err);
    memberships.value = err.memberships ?? [];
  } finally {
    loading.value = false;
  }
}

const confirmWithPassword = () =>
  run(() => deleteAccount({ email: email.value, password: password.value }));

const confirmWithPasskey = () =>
  run(() => deleteAccountWithPasskey(email.value));
</script>

<style scoped>
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
.row.danger { color: #e07070; }
.row.danger:hover:not(:disabled) { background: #1a0a0a; }

.delete-form { display: flex; flex-direction: column; gap: 8px; }

.delete-warning {
  font-size: 13px;
  color: #aaa;
  line-height: 1.5;
  margin: 0 0 4px;
}

.delete-label { font-size: 12px; color: #888; }

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

.delete-error { font-size: 12px; color: #e07070; margin: 0; }

.delete-memberships {
  font-size: 12px;
  color: #aaa;
  margin: 0;
  padding-left: 18px;
}
</style>
