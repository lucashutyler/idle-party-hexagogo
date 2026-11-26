import type { Screen } from './ScreenManager';
import { artworkUrl, renderTrackedImg } from '../ui/assets';

const TAGLINE = 'Your party keeps adventuring, even while you are away.';
const SUBMIT_LABEL = 'Email me a sign-in code';
const RESEND_LABEL = 'Send the email again';
const SENDING_LABEL = 'Sending…';
const CODE_LABEL = 'Sign in';
const CODE_BUSY_LABEL = 'Signing in…';
const CODE_PATTERN = /^\d{6}$/;

export class LoginScreen implements Screen {
  private container: HTMLElement;
  private form!: HTMLFormElement;
  private fields!: HTMLElement;
  private sent!: HTMLElement;
  private sentAddress!: HTMLElement;
  private sentStatus!: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private codeInput!: HTMLInputElement;
  private codeButton!: HTMLButtonElement;
  private resendButton!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private cancelLink!: HTMLAnchorElement;
  private onLoginCallback: (email: string) => void;
  private onCodeCallback: (code: string) => void;
  private lastEmail = '';
  private resending = false;
  private awaitingCode = false;

  constructor(containerId: string, onLogin: (email: string) => void, onCode: (code: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onLoginCallback = onLogin;
    this.onCodeCallback = onCode;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.reset();
    // On a phone this would raise the keyboard over the screen before it has been read.
    if (window.matchMedia?.('(pointer: fine)').matches) this.input.focus();
  }

  onDeactivate(): void {
    // no-op
  }

  showError(message: string): void {
    this.errorEl.style.display = 'block';
    this.errorEl.textContent = message;
  }

  /** A refused or failed code, shown in the alert line under the code field. */
  showCodeError(message: string): void {
    this.setCodeBusy(false);
    this.showError(message);
  }

  setLoading(loading: boolean): void {
    this.input.disabled = loading;
    this.button.disabled = loading;
    this.resendButton.disabled = loading;
    this.button.textContent = loading ? SENDING_LABEL : SUBMIT_LABEL;
    this.resendButton.textContent = loading ? SENDING_LABEL : RESEND_LABEL;
  }

  showCheckEmail(onCancel?: () => void): void {
    const firstShow = !this.awaitingCode;
    this.awaitingCode = true;
    this.subtitleEl.style.display = 'none';
    this.fields.style.display = 'none';
    this.sent.style.display = '';
    this.sentAddress.textContent = this.lastEmail;
    this.sentStatus.textContent = this.resending ? 'A new email is on its way.' : '';
    this.resending = false;
    this.clearError();
    this.setLoading(false);

    if (onCancel) {
      this.cancelLink.style.display = 'block';
      this.cancelLink.onclick = (e) => {
        e.preventDefault();
        onCancel();
      };
    }

    if (firstShow && window.matchMedia?.('(pointer: fine)').matches) this.codeInput.focus();
  }

  showExpired(): void {
    this.showFields('That sign-in expired. Please ask for a new code.');
  }

  private reset(): void {
    this.showFields(TAGLINE);
  }

  private showFields(subtitle: string): void {
    this.awaitingCode = false;
    this.subtitleEl.textContent = subtitle;
    this.subtitleEl.style.display = '';
    this.fields.style.display = '';
    this.sent.style.display = 'none';
    this.cancelLink.style.display = 'none';
    this.codeInput.value = '';
    this.resending = false;
    this.clearError();
    this.setLoading(false);
    this.setCodeBusy(false);
  }

  private setCodeBusy(busy: boolean): void {
    this.codeButton.disabled = busy;
    this.codeButton.textContent = busy ? CODE_BUSY_LABEL : CODE_LABEL;
  }

  private clearError(): void {
    this.errorEl.style.display = 'none';
    this.errorEl.textContent = '';
  }

  private buildDOM(): void {
    const logo = renderTrackedImg(artworkUrl('logo', 'idle-party'), { className: 'login-logo', alt: 'Idle Party RPG' });
    this.container.innerHTML = `
      <div class="login-content">
        <div class="login-brand">
          ${logo}
          <h1 class="login-title">Idle Party RPG</h1>
        </div>
        <p class="login-subtitle">${TAGLINE}</p>
        <form class="login-form" novalidate>
          <div class="login-fields">
            <label class="login-label" for="login-email">Email</label>
            <input id="login-email" type="email" name="email" class="login-input" placeholder="you@example.com"
                   autocomplete="email" autocapitalize="none" spellcheck="false" inputmode="email" enterkeyhint="send" />
            <button type="submit" class="login-button">${SUBMIT_LABEL}</button>
            <p class="login-hint">No password needed. We email you a code to sign in with.</p>
          </div>
          <div class="login-sent" style="display:none">
            <div class="login-sent-title">Check your email</div>
            <p class="login-sent-text">We sent a sign-in email to <strong class="login-sent-address"></strong>. Type the 6-digit code from the email, or open its link in this browser.</p>
            <label class="login-label" for="login-code">Sign-in code</label>
            <input id="login-code" type="text" name="code" class="login-input login-code-input" placeholder="123456"
                   inputmode="numeric" autocomplete="one-time-code" enterkeyhint="go" autocapitalize="none" spellcheck="false" />
            <button type="submit" class="login-button login-code-button">${CODE_LABEL}</button>
            <button type="button" class="login-button login-resend">${RESEND_LABEL}</button>
            <div class="login-sent-status" role="status"></div>
            <a href="#" class="login-cancel-link" style="display:none">Use a different email</a>
          </div>
          <div class="login-error" role="alert"></div>
        </form>
      </div>
    `;

    this.form = this.container.querySelector('.login-form')!;
    this.fields = this.container.querySelector('.login-fields')!;
    this.sent = this.container.querySelector('.login-sent')!;
    this.sentAddress = this.container.querySelector('.login-sent-address')!;
    this.sentStatus = this.container.querySelector('.login-sent-status')!;
    this.input = this.container.querySelector('#login-email')!;
    this.button = this.container.querySelector('.login-fields .login-button')!;
    this.codeInput = this.container.querySelector('#login-code')!;
    this.codeButton = this.container.querySelector('.login-code-button')!;
    this.resendButton = this.container.querySelector('.login-resend')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.subtitleEl = this.container.querySelector('.login-subtitle')!;
    this.cancelLink = this.container.querySelector('.login-cancel-link')!;
  }

  private wireEvents(): void {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.awaitingCode) this.submitCode();
      else this.submit();
    });
    this.input.addEventListener('input', () => this.clearError());
    this.codeInput.addEventListener('input', () => this.clearError());
    this.resendButton.addEventListener('click', () => {
      if (!this.lastEmail) return;
      this.resending = true;
      this.sentStatus.textContent = '';
      this.clearError();
      this.onLoginCallback(this.lastEmail);
    });
  }

  private submit(): void {
    const email = this.input.value.trim();
    if (!email) {
      this.showError('Enter your email');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.showError('Enter a valid email address');
      return;
    }
    this.clearError();
    this.lastEmail = email;
    this.onLoginCallback(email);
  }

  private submitCode(): void {
    if (this.codeButton.disabled) return;
    const code = this.codeInput.value.replace(/\s+/g, '');
    if (!CODE_PATTERN.test(code)) {
      this.showCodeError('Enter the 6-digit code from the email');
      return;
    }
    this.clearError();
    this.setCodeBusy(true);
    this.onCodeCallback(code);
  }
}
