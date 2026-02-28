export interface Screen {
  onActivate(): void;
  onDeactivate(): void;
}

interface RegisteredScreen {
  element: HTMLElement;
  screen: Screen;
}

export class ScreenManager {
  private screens = new Map<string, RegisteredScreen>();
  private activeScreenId: string | null = null;

  register(id: string, element: HTMLElement, screen: Screen): void {
    this.screens.set(id, { element, screen });
  }

  switchTo(id: string): void {
    if (this.activeScreenId === id) return;

    // Deactivate the tracked active screen
    const current = this.activeScreenId ? this.screens.get(this.activeScreenId) : undefined;
    if (current) {
      current.element.classList.remove('active');
      current.screen.onDeactivate();
    }

    // Remove stale active classes from all other screens (e.g. HTML-defined defaults)
    for (const [screenId, registered] of this.screens) {
      if (screenId !== id) {
        registered.element.classList.remove('active');
      }
    }

    const next = this.screens.get(id);
    if (next) {
      next.element.classList.add('active');
      next.screen.onActivate();
    }

    this.activeScreenId = id;
  }

  getActiveScreenId(): string | null {
    return this.activeScreenId;
  }
}
