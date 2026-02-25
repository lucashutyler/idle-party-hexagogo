import type { Screen } from './ScreenManager';

export class UsernameScreen implements Screen {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private onSubmitCallback: (username: string) => void;

  constructor(containerId: string, onSubmit: (username: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onSubmitCallback = onSubmit;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.input.disabled = false;
    this.button.disabled = false;
    this.button.textContent = 'Continue';
    this.errorEl.style.display = 'none';
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
    this.button.textContent = loading ? 'Saving...' : 'Continue';
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Choose a Name</h1>
        <p class="login-subtitle">Pick a username for your character.</p>
        <div class="login-form">
          <input type="text" class="login-input" placeholder="Username" maxlength="20" autocomplete="off" spellcheck="false" />
          <button class="login-button">Continue</button>
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
    if (username.length > 20) {
      this.showError('Username must be 1-20 characters');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      this.showError('Letters, numbers, hyphens, underscores only');
      return;
    }
    this.errorEl.style.display = 'none';
    this.onSubmitCallback(username);
  }
}
