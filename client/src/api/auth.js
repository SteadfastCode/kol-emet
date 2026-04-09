import { startRegistration, startAuthentication } from '@simplewebauthn/browser';

const BASE_URL = import.meta.env.VITE_API_URL ?? '';

async function req(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!res.ok) throw Object.assign(new Error(`${res.status}`), { status: res.status });
  return res.json();
}

export const register = (email, password) =>
  req('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) });

export const login = (email, password) =>
  req('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });

export const logout = () =>
  req('/auth/logout', { method: 'POST' });

export const getSession = () =>
  req('/auth/me');

export async function registerPasskey() {
  const options = await req('/auth/webauthn/register/begin', { method: 'POST' });
  const credential = await startRegistration({ optionsJSON: options });
  return req('/auth/webauthn/register/complete', {
    method: 'POST',
    body: JSON.stringify(credential),
  });
}

export async function loginWithPasskey(email) {
  const options = await req('/auth/webauthn/login/begin', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
  const credential = await startAuthentication({ optionsJSON: options });
  return req('/auth/webauthn/login/complete', {
    method: 'POST',
    body: JSON.stringify(credential),
  });
}
