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

    const current = this.activeScreenId ? this.screens.get(this.activeScreenId) : undefined;
    if (current) {
      current.element.classList.remove('active');
      current.screen.onDeactivate();
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
