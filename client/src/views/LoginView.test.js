/**
 * The CLAUDE.md rule "login and registration forms must be compatible with password managers",
 * made executable. Credential managers decide what to offer from these attributes — fill a saved
 * password on `current-password`, generate and save one on `new-password` — so a refactor that
 * drops or swaps one breaks autofill with no visible change on the page.
 *
 * Checked against these mutations of LoginView.vue, each of which turns this suite red:
 *   - form autocomplete="on" → "off", and removed
 *   - email autocomplete="email" → "username", and removed
 *   - password autocomplete ternary branches swapped
 *   - password autocomplete pinned to 'current-password' (register mode never switches)
 */
import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import LoginView from './LoginView.vue';

// Markup only: nothing here should reach the network or WebAuthn.
vi.mock('../api/auth.js', () => ({
  login: vi.fn(),
  register: vi.fn(),
  loginWithPasskey: vi.fn(),
  registerPasskey: vi.fn(),
}));

async function switchTo(wrapper, label) {
  const tab = wrapper.findAll('.tab-row button').find((b) => b.text() === label);
  if (!tab) throw new Error(`no "${label}" tab in LoginView`);
  await tab.trigger('click');
}

const autocomplete = (wrapper, selector) => wrapper.get(selector).attributes('autocomplete');

describe('LoginView credential-manager attributes', () => {
  it('sign-in mode: autocomplete on, email, current-password', () => {
    const wrapper = mount(LoginView);

    expect(autocomplete(wrapper, 'form')).toBe('on');
    expect(autocomplete(wrapper, 'form input[type="email"]')).toBe('email');
    expect(autocomplete(wrapper, 'form input[type="password"]')).toBe('current-password');
  });

  it('create-account mode: autocomplete on, email, new-password', async () => {
    const wrapper = mount(LoginView);
    await switchTo(wrapper, 'Create account');

    expect(autocomplete(wrapper, 'form')).toBe('on');
    expect(autocomplete(wrapper, 'form input[type="email"]')).toBe('email');
    expect(autocomplete(wrapper, 'form input[type="password"]')).toBe('new-password');
  });

  it('switching back to sign-in restores current-password', async () => {
    const wrapper = mount(LoginView);
    await switchTo(wrapper, 'Create account');
    await switchTo(wrapper, 'Sign in');

    expect(autocomplete(wrapper, 'form input[type="password"]')).toBe('current-password');
  });
});

describe('LoginView signup disclosure', () => {
  const DISCLOSURE = 'You can delete your account and all of its data at any time from Settings.';

  it('create-account mode carries it, directly under the form', async () => {
    const wrapper = mount(LoginView);
    await switchTo(wrapper, 'Create account');

    expect(wrapper.get('form + .login-disclosure').text()).toBe(DISCLOSURE);
  });

  it('sign-in mode does not', () => {
    expect(mount(LoginView).find('.login-disclosure').exists()).toBe(false);
  });
});

describe('LoginView notice', () => {
  it('shows the notice it is given: the signed-out landing after an account is deleted', () => {
    const notice = 'Your account and all of its data have been deleted.';
    const wrapper = mount(LoginView, { props: { notice } });

    expect(wrapper.get('[role="status"]').text()).toBe(notice);
  });

  it('shows none by default', () => {
    expect(mount(LoginView).find('[role="status"]').exists()).toBe(false);
  });
});
