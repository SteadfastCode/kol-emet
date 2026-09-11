/**
 * The account-deletion confirmation in settings. The server enforces every rule on its own; this
 * pins the client half: nothing is sent until the email is typed and a credential given, the
 * password stays fillable by credential managers, a refusal is shown rather than swallowed, and
 * only a finished deletion reaches the signed-out landing (the `deleted` event).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import AccountDeletion from './AccountDeletion.vue';
import { deleteAccount, deleteAccountWithPasskey } from '../api/auth.js';

vi.mock('../api/auth.js', () => ({
  deleteAccount: vi.fn(),
  deleteAccountWithPasskey: vi.fn(),
}));

beforeEach(() => { vi.clearAllMocks(); });

async function openConfirmation() {
  const wrapper = mount(AccountDeletion);
  await wrapper.get('button').trigger('click');
  return wrapper;
}

async function fill(wrapper, { email = 'me@example.test', password = 'correct-horse' } = {}) {
  await wrapper.get('#delete-account-email').setValue(email);
  await wrapper.get('#delete-account-password').setValue(password);
}

const submitButton = (wrapper) => wrapper.get('button[type="submit"]');

describe('AccountDeletion', () => {
  it('shows only the action until it is chosen, then the confirmation', async () => {
    const wrapper = mount(AccountDeletion);
    expect(wrapper.find('form').exists()).toBe(false);

    await wrapper.get('button').trigger('click');
    expect(wrapper.find('form').exists()).toBe(true);
  });

  it('keeps the delete button disabled until the email is typed and the password given', async () => {
    const wrapper = await openConfirmation();
    expect(submitButton(wrapper).element.disabled).toBe(true);

    await wrapper.get('#delete-account-email').setValue('me@example.test');
    expect(submitButton(wrapper).element.disabled).toBe(true);

    await wrapper.get('#delete-account-password').setValue('correct-horse');
    expect(submitButton(wrapper).element.disabled).toBe(false);
  });

  it('lets credential managers fill the password, not the typed confirmation', async () => {
    const wrapper = await openConfirmation();

    expect(wrapper.get('form').attributes('autocomplete')).toBe('on');
    expect(wrapper.get('#delete-account-password').attributes('autocomplete')).toBe('current-password');
    expect(wrapper.get('#delete-account-email').attributes('autocomplete')).toBe('off');
  });

  it('sends the typed email and the password, and emits deleted when the server confirms', async () => {
    deleteAccount.mockResolvedValue(null);
    const wrapper = await openConfirmation();
    await fill(wrapper);

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(deleteAccount).toHaveBeenCalledWith({ email: 'me@example.test', password: 'correct-horse' });
    expect(wrapper.emitted('deleted')).toHaveLength(1);
  });

  it('on a 409 lists the workspaces that blocked it and does not sign out', async () => {
    deleteAccount.mockRejectedValue(Object.assign(new Error('refused'), {
      status: 409,
      memberships: [{ workspaceId: 'w1', name: "Bob's world", role: 'editor' }],
    }));
    const wrapper = await openConfirmation();
    await fill(wrapper);

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.emitted('deleted')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('Nothing was deleted');
    expect(wrapper.get('.delete-memberships').text()).toContain("Bob's world (editor)");
  });

  it("shows the server's reason for a wrong password and does not sign out", async () => {
    deleteAccount.mockRejectedValue(Object.assign(new Error('Incorrect password'), { status: 403 }));
    const wrapper = await openConfirmation();
    await fill(wrapper, { password: 'wrong' });

    await wrapper.get('form').trigger('submit');
    await flushPromises();

    expect(wrapper.emitted('deleted')).toBeUndefined();
    expect(wrapper.get('[role="alert"]').text()).toBe('Incorrect password');
  });

  it('confirms with a passkey instead, and a dismissed prompt is not an error', async () => {
    deleteAccountWithPasskey.mockRejectedValueOnce(Object.assign(new Error('dismissed'), { name: 'NotAllowedError' }));
    const wrapper = await openConfirmation();
    await wrapper.get('#delete-account-email').setValue('me@example.test');
    const passkeyButton = wrapper.findAll('button').find((b) => b.text().includes('passkey'));

    await passkeyButton.trigger('click');
    await flushPromises();
    expect(deleteAccountWithPasskey).toHaveBeenCalledWith('me@example.test');
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    expect(wrapper.emitted('deleted')).toBeUndefined();

    deleteAccountWithPasskey.mockResolvedValueOnce(null);
    await passkeyButton.trigger('click');
    await flushPromises();
    expect(wrapper.emitted('deleted')).toHaveLength(1);
  });
});
