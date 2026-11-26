import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginScreen } from '../src/screens/LoginScreen';

function mount() {
  document.body.innerHTML = '<div id="screen-login"></div>';
  const onLogin = vi.fn();
  const onCode = vi.fn();
  const screen = new LoginScreen('screen-login', onLogin, onCode);
  screen.onActivate();
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
  const submit = (email: string) => {
    q<HTMLInputElement>('.login-input').value = email;
    q<HTMLFormElement>('.login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };
  const submitCode = (code: string) => {
    q<HTMLInputElement>('.login-code-input').value = code;
    q<HTMLFormElement>('.login-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  };
  return { screen, onLogin, onCode, q, submit, submitCode };
}

describe('LoginScreen', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is a real labelled form that asks for a sign-in code', () => {
    const t = mount();
    const label = t.q<HTMLLabelElement>('.login-label');
    expect(label.getAttribute('for')).toBe(t.q('.login-input').id);
    expect(t.q('.login-fields .login-button').textContent).toBe('Email me a sign-in code');
    expect(t.q('.login-error').getAttribute('role')).toBe('alert');
    expect(t.q('.login-title').textContent).toBe('Idle Party RPG');
  });

  it('submits a trimmed address without leaving the page', () => {
    const t = mount();
    const submit = new Event('submit', { bubbles: true, cancelable: true });
    t.q<HTMLInputElement>('.login-input').value = '  me@example.com ';
    t.q('.login-form').dispatchEvent(submit);
    expect(submit.defaultPrevented).toBe(true);
    expect(t.onLogin).toHaveBeenCalledWith('me@example.com');
  });

  it('explains a missing or malformed address and clears the message on typing', () => {
    const t = mount();
    t.submit('');
    expect(t.q('.login-error').textContent).toBe('Enter your email');
    t.submit('nope');
    expect(t.q('.login-error').textContent).toBe('Enter a valid email address');
    expect(t.onLogin).not.toHaveBeenCalled();

    t.q('.login-input').dispatchEvent(new Event('input'));
    expect(t.q('.login-error').style.display).toBe('none');
    expect(t.q('.login-error').textContent).toBe('');
  });

  it('shows the address on the check-email panel and hides the fields', () => {
    const t = mount();
    t.submit('me@example.com');
    t.screen.setLoading(true);
    expect(t.q<HTMLButtonElement>('.login-fields .login-button').disabled).toBe(true);

    t.screen.showCheckEmail();
    expect(t.q('.login-fields').style.display).toBe('none');
    expect(t.q('.login-sent').style.display).toBe('');
    expect(t.q('.login-sent-address').textContent).toBe('me@example.com');
    expect(t.q<HTMLButtonElement>('.login-resend').disabled).toBe(false);
  });

  it('resends to the same address and confirms it went', () => {
    const t = mount();
    t.submit('me@example.com');
    t.screen.showCheckEmail();
    expect(t.q('.login-sent-status').textContent).toBe('');

    t.q('.login-resend').click();
    expect(t.onLogin).toHaveBeenCalledTimes(2);
    expect(t.onLogin).toHaveBeenLastCalledWith('me@example.com');

    t.screen.setLoading(true);
    expect(t.q('.login-resend').textContent).toBe('Sending…');
    t.screen.showCheckEmail();
    expect(t.q('.login-sent-status').textContent).toBe('A new email is on its way.');
    expect(t.q('.login-resend').textContent).toBe('Send the email again');
  });

  it('shows a failed resend on the check-email panel', () => {
    const t = mount();
    t.submit('me@example.com');
    t.screen.showCheckEmail();
    t.q('.login-resend').click();
    t.screen.showError('Could not connect to server');
    t.screen.setLoading(false);
    expect(t.q('.login-sent').style.display).toBe('');
    expect(t.q('.login-error').style.display).toBe('block');
    expect(t.q('.login-error').textContent).toBe('Could not connect to server');
  });

  it('lets the player cancel and fix the address they typed', () => {
    const t = mount();
    t.submit('me@example.com');
    t.screen.showCheckEmail(() => t.screen.onActivate());
    t.q('.login-cancel-link').click();
    expect(t.q('.login-fields').style.display).toBe('');
    expect(t.q('.login-sent').style.display).toBe('none');
    expect(t.q<HTMLInputElement>('.login-input').value).toBe('me@example.com');
  });

  it('brings the form back when the sign-in expires', () => {
    const t = mount();
    t.submit('me@example.com');
    t.screen.showCheckEmail();
    t.screen.showExpired();
    expect(t.q('.login-fields').style.display).toBe('');
    expect(t.q('.login-sent').style.display).toBe('none');
    expect(t.q('.login-subtitle').textContent).toContain('expired');
  });

  describe('sign-in code', () => {
    it('shows a labelled one-time-code field on the check-email panel', () => {
      const t = mount();
      t.submit('me@example.com');
      t.screen.showCheckEmail();

      const input = t.q<HTMLInputElement>('.login-sent .login-code-input');
      expect(t.q(`.login-sent label[for="${input.id}"]`).textContent).toBe('Sign-in code');
      expect(input.getAttribute('inputmode')).toBe('numeric');
      expect(input.getAttribute('autocomplete')).toBe('one-time-code');
      expect(input.getAttribute('enterkeyhint')).toBe('go');
      expect(t.q('.login-sent .login-code-button').textContent).toBe('Sign in');
      expect(t.q('.login-sent-text').textContent)
        .toContain('Type the 6-digit code from the email, or open its link in this browser');
    });

    it('passes the digits without spaces to onCode instead of sending another email', () => {
      const t = mount();
      t.submit('me@example.com');
      t.screen.showCheckEmail();

      t.submitCode(' 123 456 ');

      expect(t.onCode).toHaveBeenCalledWith('123456');
      expect(t.onLogin).toHaveBeenCalledTimes(1);
      expect(t.q<HTMLButtonElement>('.login-code-button').disabled).toBe(true);
    });

    it('asks for six digits before sending anything', () => {
      const t = mount();
      t.submit('me@example.com');
      t.screen.showCheckEmail();

      t.submitCode('12345');
      t.submitCode('12a456');

      expect(t.onCode).not.toHaveBeenCalled();
      expect(t.q('.login-error').textContent).toBe('Enter the 6-digit code from the email');
    });

    it('shows a refused code in the alert line and lets the player try again', () => {
      const t = mount();
      t.submit('me@example.com');
      t.screen.showCheckEmail();
      t.submitCode('123456');

      t.screen.showCodeError('That code doesn\'t match the newest sign-in email.');

      const alert = t.q('[role="alert"]');
      expect(alert.style.display).toBe('block');
      expect(alert.textContent).toBe('That code doesn\'t match the newest sign-in email.');
      expect(t.q<HTMLButtonElement>('.login-code-button').disabled).toBe(false);

      t.q('.login-code-input').dispatchEvent(new Event('input'));
      expect(alert.textContent).toBe('');
    });

    it('keeps a typed code across a resend and clears it when the form comes back', () => {
      const t = mount();
      t.submit('me@example.com');
      t.screen.showCheckEmail(() => t.screen.onActivate());
      t.q<HTMLInputElement>('.login-code-input').value = '12';

      t.q('.login-resend').click();
      t.screen.showCheckEmail();
      expect(t.q<HTMLInputElement>('.login-code-input').value).toBe('12');

      t.screen.showExpired();
      expect(t.q<HTMLInputElement>('.login-code-input').value).toBe('');
    });
  });
});
