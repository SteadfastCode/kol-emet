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
 *
 * The template picker suite below goes red when submit() stops passing the chosen key to
 * register() (both registration cases fail).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import LoginView from './LoginView.vue';
import { login, register, getTemplates } from '../api/auth.js';

// Nothing here should reach the network or WebAuthn. getTemplates answers an
// empty list unless a test says otherwise, so the picker stays out of the
// suites that are not about it.
vi.mock('../api/auth.js', () => ({
  login: vi.fn(),
  register: vi.fn(),
  getTemplates: vi.fn(async () => []),
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

describe('LoginView template picker', () => {
  // As GET /templates answers: the default first.
  const TEMPLATES = [
    { key: 'worldbuilding', name: 'Worldbuilding', description: 'Characters, worlds, organizations and the relationships between them.' },
    { key: 'software-architecture', name: 'Software Architecture', description: 'Services, data stores, APIs and teams, and what depends on, calls and owns what.' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    getTemplates.mockResolvedValue(TEMPLATES);
    register.mockResolvedValue({ ok: true });
  });

  async function registerMode() {
    const wrapper = mount(LoginView);
    await switchTo(wrapper, 'Create account');
    await flushPromises();
    return wrapper;
  }

  async function fillCredentials(wrapper) {
    await wrapper.get('form input[type="email"]').setValue('new@example.test');
    await wrapper.get('form input[type="password"]').setValue('correct-horse-battery-staple');
  }

  const radios = (wrapper) => wrapper.findAll('.template-picker input[type="radio"]');

  it('create-account mode lists the fetched templates, name and description, under "Start with"', async () => {
    const wrapper = await registerMode();
    const picker = wrapper.get('form .template-picker');

    expect(picker.get('legend').text()).toBe('Start with');
    expect(radios(wrapper).map((r) => r.attributes('value'))).toEqual(['worldbuilding', 'software-architecture']);
    const options = picker.findAll('label');
    TEMPLATES.forEach((t, i) => {
      expect(options[i].text()).toContain(t.name);
      expect(options[i].text()).toContain(t.description);
    });
  });

  it('defaults to worldbuilding, wherever it is listed', async () => {
    getTemplates.mockResolvedValue([...TEMPLATES].reverse());
    const wrapper = await registerMode();

    const checked = radios(wrapper).filter((r) => r.element.checked);
    expect(checked.map((r) => r.attributes('value'))).toEqual(['worldbuilding']);
  });

  it('registers with the chosen template', async () => {
    const wrapper = await registerMode();
    await fillCredentials(wrapper);
    await wrapper.get('.template-picker input[value="software-architecture"]').setValue();
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(register).toHaveBeenCalledWith('new@example.test', 'correct-horse-battery-staple', 'software-architecture');
  });

  it('registers with worldbuilding when the choice is left alone', async () => {
    const wrapper = await registerMode();
    await fillCredentials(wrapper);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(register).toHaveBeenCalledWith('new@example.test', 'correct-horse-battery-staple', 'worldbuilding');
  });

  it('sits in the form, above the disclosure, and leaves the credential inputs alone', async () => {
    const wrapper = await registerMode();

    expect(wrapper.find('form .template-picker').exists()).toBe(true);
    expect(wrapper.get('form + .login-disclosure').exists()).toBe(true);
    expect(autocomplete(wrapper, 'form input[type="email"]')).toBe('email');
    expect(autocomplete(wrapper, 'form input[type="password"]')).toBe('new-password');
  });

  it('sign-in mode neither shows nor fetches it', async () => {
    const wrapper = mount(LoginView);
    await flushPromises();

    expect(wrapper.find('.template-picker').exists()).toBe(false);
    expect(getTemplates).not.toHaveBeenCalled();
  });

  it('when the list cannot be fetched, there is no picker and registration names no template', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    getTemplates.mockRejectedValue(Object.assign(new Error('503'), { status: 503 }));
    const wrapper = await registerMode();

    expect(wrapper.find('.template-picker').exists()).toBe(false);
    await fillCredentials(wrapper);
    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(register).toHaveBeenCalledWith('new@example.test', 'correct-horse-battery-staple', undefined);
  });
});

/**
 * The server throttles failed sign-ins (KOL-035) and answers 429. The generic
 * branch reads "Something went wrong. Please try again." — which is the one
 * piece of advice that is wrong while a throttle is running, and would have a
 * blocked person hammering the form for as long as they have patience.
 *
 * Goes red if the 429 branch is removed from submit() (the message falls back
 * to the generic one).
 */
describe('LoginView throttled sign-in', () => {
  const THROTTLED = 'Too many sign-in attempts. Wait a few minutes and try again.';

  beforeEach(() => {
    vi.clearAllMocks();
    getTemplates.mockResolvedValue([]);
  });

  async function signIn(wrapper) {
    await wrapper.get('form input[type="email"]').setValue('blocked@example.test');
    await wrapper.get('form input[type="password"]').setValue('correct-horse-battery-staple');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
  }

  it('a 429 says to wait rather than to try again', async () => {
    login.mockRejectedValue(Object.assign(new Error('429'), { status: 429 }));
    const wrapper = mount(LoginView);

    await signIn(wrapper);

    expect(wrapper.get('.login-error').text()).toBe(THROTTLED);
  });

  it('a 401 still says the credentials were wrong', async () => {
    login.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }));
    const wrapper = mount(LoginView);

    await signIn(wrapper);

    expect(wrapper.get('.login-error').text()).toBe('Invalid email or password.');
  });
});
