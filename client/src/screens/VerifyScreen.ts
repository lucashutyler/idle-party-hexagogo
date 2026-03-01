import type { Screen } from './ScreenManager';

export class VerifyScreen implements Screen {
  private container: HTMLElement;
  private messageEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private backLink!: HTMLAnchorElement;
  private onVerify: (token: string) => void;

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

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Idle Party RPG</h1>
        <p class="verify-message">Verifying your sign-in...</p>
        <div class="login-error"></div>
        <a href="/" class="verify-back-link">Back to sign in</a>
      </div>
    `;

    this.messageEl = this.container.querySelector('.verify-message')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.backLink = this.container.querySelector('.verify-back-link')!;
  }
}
