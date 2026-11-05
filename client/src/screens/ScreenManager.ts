export interface Screen {
  onActivate(): void;
  onDeactivate(): void;
  /** Selects a sub-view, from the `sub` part of a navigation target. */
  setSubTab?(sub: string): void;
  /** Renders the latest state while hidden, so the first visit only has to show it. Must not subscribe or send. */
  prebuild?(): void;
}

interface RegisteredScreen {
  element: HTMLElement;
  screen: Screen;
}

/** Hidden screens skip layout, so `data-prebuilding` lifts that (see shell.css) for one layout pass; nothing paints. */
function layOutWhileHidden(element: HTMLElement): void {
  element.dataset.prebuilding = '';
  void element.offsetHeight;
  delete element.dataset.prebuilding;
}

export class ScreenManager {
  private screens = new Map<string, RegisteredScreen>();
  private activeScreenId: string | null = null;
  private shownIds = new Set<string>();

  register(id: string, element: HTMLElement, screen: Screen): void {
    this.screens.set(id, { element, screen });
    this.shownIds.delete(id);
  }

  get(id: string): Screen | undefined {
    return this.screens.get(id)?.screen;
  }

  /** Steps that build the given screens ahead of their first visit; a screen shown in the meantime is skipped. */
  prebuildSteps(ids: readonly string[]): (() => void)[] {
    return ids.flatMap(id => {
      const registered = this.screens.get(id);
      if (!registered?.screen.prebuild) return [];
      const unlessShown = (step: () => void) => () => {
        if (!this.shownIds.has(id)) step();
      };
      return [
        unlessShown(() => registered.screen.prebuild?.()),
        unlessShown(() => layOutWhileHidden(registered.element)),
      ];
    });
  }

  switchTo(id: string): void {
    if (this.activeScreenId === id) return;
    this.shownIds.add(id);

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
    // Expose the active screen on the body so global CSS can adapt
    // (e.g. mobile chat sheet replaces the combat log instead of stacking).
    document.body.dataset.activeScreen = id;
  }

  getActiveScreenId(): string | null {
    return this.activeScreenId;
  }
}
