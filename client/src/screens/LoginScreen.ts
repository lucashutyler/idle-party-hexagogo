import type { Screen } from './ScreenManager';
import { artworkUrl, renderTrackedImg } from '../ui/assets';

const TAGLINE = 'Your party keeps adventuring, even while you are away.';
const SUBMIT_LABEL = 'Email me a sign-in link';
const RESEND_LABEL = 'Send the link again';
const SENDING_LABEL = 'Sending…';

export class LoginScreen implements Screen {
  private container: HTMLElement;
  private form!: HTMLFormElement;
  private fields!: HTMLElement;
  private sent!: HTMLElement;
  private sentAddress!: HTMLElement;
  private sentStatus!: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private resendButton!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private cancelLink!: HTMLAnchorElement;
  private onLoginCallback: (email: string) => void;
  private lastEmail = '';
  private resending = false;

  constructor(containerId: string, onLogin: (email: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onLoginCallback = onLogin;

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

  setLoading(loading: boolean): void {
    this.input.disabled = loading;
    this.button.disabled = loading;
    this.resendButton.disabled = loading;
    this.button.textContent = loading ? SENDING_LABEL : SUBMIT_LABEL;
    this.resendButton.textContent = loading ? SENDING_LABEL : RESEND_LABEL;
  }

  showCheckEmail(onCancel?: () => void): void {
    this.subtitleEl.style.display = 'none';
    this.fields.style.display = 'none';
    this.sent.style.display = '';
    this.sentAddress.textContent = this.lastEmail;
    this.sentStatus.textContent = this.resending ? 'A new link is on its way.' : '';
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
  }

  showExpired(): void {
    this.showFields('Sign-in link expired. Please try again.');
  }

  private reset(): void {
    this.showFields(TAGLINE);
  }

  private showFields(subtitle: string): void {
    this.subtitleEl.textContent = subtitle;
    this.subtitleEl.style.display = '';
    this.fields.style.display = '';
    this.sent.style.display = 'none';
    this.cancelLink.style.display = 'none';
    this.resending = false;
    this.clearError();
    this.setLoading(false);
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
            <p class="login-hint">No password needed. Open the link we send and you are in.</p>
          </div>
          <div class="login-sent" style="display:none">
            <div class="login-sent-title">Check your email</div>
            <p class="login-sent-text">We sent a sign-in link to <strong class="login-sent-address"></strong>. Keep this page open: it signs you in as soon as you open the link.</p>
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
    this.input = this.container.querySelector('.login-input')!;
    this.button = this.container.querySelector('.login-fields .login-button')!;
    this.resendButton = this.container.querySelector('.login-resend')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.subtitleEl = this.container.querySelector('.login-subtitle')!;
    this.cancelLink = this.container.querySelector('.login-cancel-link')!;
  }

  private wireEvents(): void {
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submit();
    });
    this.input.addEventListener('input', () => this.clearError());
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
}
