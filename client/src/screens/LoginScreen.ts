import type { Screen } from './ScreenManager';

export class LoginScreen implements Screen {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private onLoginCallback: (username: string) => void;

  constructor(containerId: string, onLogin: (username: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onLoginCallback = onLogin;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.input.focus();
  }

  onDeactivate(): void {
    // no-op
  }

  showError(message: string): void {
    this.errorEl.textContent = message;
    this.errorEl.style.display = 'block';
  }

  setLoading(loading: boolean): void {
    this.input.disabled = loading;
    this.button.disabled = loading;
    this.button.textContent = loading ? 'Connecting...' : 'Play';
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Idle Party RPG</h1>
        <div class="login-form">
          <input type="text" class="login-input" placeholder="Username" maxlength="20" autocomplete="off" spellcheck="false" />
          <button class="login-button">Play</button>
          <div class="login-error"></div>
        </div>
      </div>
    `;

    this.input = this.container.querySelector('.login-input')!;
    this.button = this.container.querySelector('.login-button')!;
    this.errorEl = this.container.querySelector('.login-error')!;
  }

  private wireEvents(): void {
    this.button.addEventListener('click', () => this.submit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
    });

    // Clear error on input
    this.input.addEventListener('input', () => {
      this.errorEl.style.display = 'none';
    });
  }

  private submit(): void {
    const username = this.input.value.trim();
    if (!username) {
      this.showError('Enter a username');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      this.showError('Letters, numbers, hyphens, underscores only');
      return;
    }
    this.errorEl.style.display = 'none';
    this.onLoginCallback(username);
  }
}
