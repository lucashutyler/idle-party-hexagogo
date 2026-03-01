import type { Screen } from './ScreenManager';

export interface VerifyDebugInfo {
  verifyResponse: Record<string, unknown>;
  sessionCheck: Record<string, unknown> | null;
  cookiesEnabled: boolean;
  documentCookie: string;
}

export class VerifyScreen implements Screen {
  private container: HTMLElement;
  private messageEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private backLink!: HTMLAnchorElement;
  private detailsEl!: HTMLElement;
  private continueBtn!: HTMLButtonElement;
  private onVerify: (token: string) => void;
  private onContinue: (() => void) | null = null;

  constructor(containerId: string, onVerify: (token: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onVerify = onVerify;

    this.buildDOM();
  }

  onActivate(): void {
    this.messageEl.textContent = 'Verifying your sign-in...';
    this.errorEl.style.display = 'none';
    this.backLink.style.display = 'none';
    this.detailsEl.style.display = 'none';
    this.continueBtn.style.display = 'none';
    this.onContinue = null;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    if (!token) {
      this.showError('No verification token found.');
      return;
    }

    this.onVerify(token);
  }

  onDeactivate(): void {
    // no-op
  }

  showError(message: string): void {
    this.messageEl.textContent = 'Sign-in failed';
    this.errorEl.textContent = message;
    this.errorEl.style.display = 'block';
    this.backLink.style.display = 'inline-block';
  }

  showSuccess(debug: VerifyDebugInfo, onContinue: () => void): void {
    const sessionOk = debug.sessionCheck?.authenticated === true;

    if (sessionOk) {
      this.messageEl.textContent = 'Sign-in successful!';
      this.continueBtn.textContent = 'Continue';
      this.continueBtn.style.display = 'inline-block';
      this.onContinue = onContinue;
    } else {
      this.messageEl.textContent = 'Sign-in issue';
      this.errorEl.textContent = 'Verification succeeded but session was not established. See details below.';
      this.errorEl.style.display = 'block';
      this.backLink.style.display = 'inline-block';
    }

    // Build debug details
    const lines = [
      `Verify response: ${JSON.stringify(debug.verifyResponse, null, 2)}`,
      `Session check:   ${JSON.stringify(debug.sessionCheck, null, 2)}`,
      `Cookies enabled: ${debug.cookiesEnabled}`,
      `document.cookie: ${debug.documentCookie || '(empty)'}`,
    ];

    const pre = this.detailsEl.querySelector('pre')!;
    pre.textContent = lines.join('\n');
    this.detailsEl.style.display = 'block';
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Idle Party RPG</h1>
        <p class="verify-message">Verifying your sign-in...</p>
        <div class="login-error"></div>
        <button class="verify-continue-btn login-button" style="display:none; max-width:280px;">Continue</button>
        <a href="/" class="verify-back-link">Back to sign in</a>
        <details class="verify-details" style="display:none;">
          <summary>Debug details</summary>
          <pre class="verify-debug-pre"></pre>
        </details>
      </div>
    `;

    this.messageEl = this.container.querySelector('.verify-message')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.backLink = this.container.querySelector('.verify-back-link')!;
    this.detailsEl = this.container.querySelector('.verify-details')!;
    this.continueBtn = this.container.querySelector('.verify-continue-btn')!;

    this.continueBtn.addEventListener('click', () => {
      if (this.onContinue) {
        this.continueBtn.disabled = true;
        this.onContinue();
      }
    });
  }
}
