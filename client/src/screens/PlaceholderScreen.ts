import type { Screen } from './ScreenManager';

export class PlaceholderScreen implements Screen {
  private container: HTMLElement;

  constructor(containerId: string, title: string, icon: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;

    this.container.innerHTML = `
      <div class="placeholder-content">
        <div class="placeholder-icon">${icon}</div>
        <h2 class="placeholder-title">${title}</h2>
        <p class="placeholder-text">Coming soon</p>
      </div>
    `;
  }

  onActivate(): void {
    // no-op
  }

  onDeactivate(): void {
    // no-op
  }
}
