import type { Screen } from './ScreenManager';
import { approveLogin } from '../network/AuthClient';

export class ApproveScreen implements Screen {
  private container: HTMLElement;
  private messageEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private backLink!: HTMLAnchorElement;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.buildDOM();
  }

  onActivate(): void {
    this.messageEl.textContent = 'Approving sign-in...';
    this.errorEl.style.display = 'none';
    this.hintEl.style.display = 'none';
    this.backLink.style.display = 'none';

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');

    // Clean URL so token doesn't linger
    history.replaceState(null, '', '/');

    if (!token) {
      this.showError('No verification token found.');
      return;
    }

    this.approve(token);
  }

  onDeactivate(): void {
    // no-op
  }

  private async approve(token: string): Promise<void> {
    try {
      const result = await approveLogin(token);
      if (result.success) {
        this.messageEl.textContent = 'Sign in approved!';
        this.hintEl.textContent = 'You can close this tab and return to your other device.';
        this.hintEl.style.display = 'block';
      } else {
        this.showError(result.error ?? 'Approval failed. The link may have expired.');
      }
    } catch {
      this.showError('Could not connect to server.');
    }
  }

  private showError(message: string): void {
    this.messageEl.textContent = 'Sign-in failed';
    this.errorEl.textContent = message;
    this.errorEl.style.display = 'block';
    this.backLink.style.display = 'inline-block';
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Idle Party RPG</h1>
        <p class="verify-message">Approving sign-in...</p>
        <div class="login-error"></div>
        <p class="approve-close-hint" style="display:none"></p>
        <a href="/" class="verify-back-link" style="display:none">Back to sign in</a>
      </div>
    `;

    this.messageEl = this.container.querySelector('.verify-message')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.hintEl = this.container.querySelector('.approve-close-hint')!;
    this.backLink = this.container.querySelector('.verify-back-link')!;
  }
}
