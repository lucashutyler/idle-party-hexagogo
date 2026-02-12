import type { Screen } from './ScreenManager';

export class OfflineScreen implements Screen {
  private container: HTMLElement;
  private retryButton!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private onRetry: () => void;

  constructor(containerId: string, onRetry: () => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.onRetry = onRetry;

    this.buildDOM();
    this.wireEvents();
  }

  onActivate(): void {
    this.setRetrying(false);
  }

  onDeactivate(): void {
    // no-op
  }

  setRetrying(retrying: boolean): void {
    this.retryButton.disabled = retrying;
    this.retryButton.textContent = retrying ? 'Connecting...' : 'Retry';
    this.statusEl.textContent = retrying
      ? 'Attempting to connect...'
      : 'The server is currently unavailable. This could be due to maintenance, updates, or connectivity issues.';
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="offline-content">
        <div class="offline-icon">!</div>
        <h2 class="offline-title">Server Unavailable</h2>
        <p class="offline-status">The server is currently unavailable. This could be due to maintenance, updates, or connectivity issues.</p>
        <button class="offline-retry">Retry</button>
      </div>
    `;

    this.retryButton = this.container.querySelector('.offline-retry')!;
    this.statusEl = this.container.querySelector('.offline-status')!;
  }

  private wireEvents(): void {
    this.retryButton.addEventListener('click', () => {
      this.setRetrying(true);
      this.onRetry();
    });
  }
}
