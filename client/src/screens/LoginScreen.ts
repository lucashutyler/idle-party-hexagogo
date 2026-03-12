import type { Screen } from './ScreenManager';

export class LoginScreen implements Screen {
  private container: HTMLElement;
  private input!: HTMLInputElement;
  private button!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private cancelLink!: HTMLAnchorElement;
  private onLoginCallback: (email: string) => void;

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
    this.button.textContent = loading ? 'Verifying...' : 'Verify';
  }

  showCheckEmail(onCancel?: () => void): void {
    this.subtitleEl.textContent = 'Check your email for a sign-in link!';
    this.subtitleEl.style.display = 'block';
    this.input.style.display = 'none';
    this.button.style.display = 'none';
    this.errorEl.style.display = 'none';

    if (onCancel) {
      this.cancelLink.style.display = 'block';
      this.cancelLink.onclick = (e) => {
        e.preventDefault();
        onCancel();
      };
    }
  }

  showExpired(): void {
    this.subtitleEl.textContent = 'Sign-in link expired. Please try again.';
    this.subtitleEl.style.display = 'block';
    this.input.style.display = '';
    this.button.style.display = '';
    this.cancelLink.style.display = 'none';
    this.errorEl.style.display = 'none';
    this.setLoading(false);
  }

  private reset(): void {
    this.input.style.display = '';
    this.button.style.display = '';
    this.subtitleEl.style.display = 'none';
    this.errorEl.style.display = 'none';
    this.cancelLink.style.display = 'none';
    this.setLoading(false);
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="login-content">
        <h1 class="login-title">Idle Party RPG</h1>
        <p class="login-subtitle" style="display:none"></p>
        <div class="login-form">
          <input type="email" class="login-input" placeholder="Email" autocomplete="email" spellcheck="false" />
          <button class="login-button">Verify</button>
          <div class="login-error"></div>
        </div>
        <a href="#" class="login-cancel-link" style="display:none">Try a different email</a>
      </div>
    `;

    this.input = this.container.querySelector('.login-input')!;
    this.button = this.container.querySelector('.login-button')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.subtitleEl = this.container.querySelector('.login-subtitle')!;
    this.cancelLink = this.container.querySelector('.login-cancel-link')!;
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
    const email = this.input.value.trim();
    if (!email) {
      this.showError('Enter your email');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.showError('Enter a valid email address');
      return;
    }
    this.errorEl.style.display = 'none';
    this.onLoginCallback(email);
  }
}
