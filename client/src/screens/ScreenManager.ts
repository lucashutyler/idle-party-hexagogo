/**
 * Screen navigation.
 *
 * Two axes, deliberately separate:
 *
 * - **Roots** are the top-level destinations owned by the bottom nav. Switching
 *   root (`switchTo`) discards any drill-down and starts a fresh stack. There is
 *   always exactly one root.
 * - **Pushes** are drill-downs on top of the current root (`push`). They stack,
 *   they get a back header, and they are popped by the back button — the app's
 *   own, the browser's, and Android's hardware key, which are all the same
 *   thing via `popstate`.
 *
 * This is the iOS/Android tab-bar-plus-stack model. It exists so the game reads
 * as a mobile app rather than a set of long scrolling pages: content that used
 * to be stacked into one tall screen becomes a push instead.
 */

export interface Screen {
  /**
   * Called when the screen becomes visible. `params` carries whatever `push`
   * was given — screens that take no parameters can keep declaring
   * `onActivate(): void`, which stays assignable.
   */
  onActivate(params?: unknown): void;
  onDeactivate(): void;
}

interface RegisteredScreen {
  element: HTMLElement;
  screen: Screen;
  /** Header title used when this screen is pushed. Roots never show a header. */
  title?: string;
}

interface StackEntry {
  id: string;
  params?: unknown;
}

/** Marks our own history entries so we ignore states pushed by anything else. */
interface NavHistoryState {
  ipDepth: number;
}

function isNavState(value: unknown): value is NavHistoryState {
  return typeof value === 'object' && value !== null && typeof (value as NavHistoryState).ipDepth === 'number';
}

export class ScreenManager {
  private screens = new Map<string, RegisteredScreen>();
  private stack: StackEntry[] = [];
  private headerEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private stackListeners = new Set<(depth: number) => void>();
  /** Set while we drive history ourselves, so our own popstate is a no-op. */
  private suppressPopstate = false;

  constructor() {
    this.mountHeader();
    window.addEventListener('popstate', (e) => this.handlePopstate(e));
  }

  register(id: string, element: HTMLElement, screen: Screen, title?: string): void {
    this.screens.set(id, { element, screen, title });
  }

  /**
   * Switch to a top-level destination, discarding any drill-down. This is what
   * a bottom-nav tab does. Re-selecting the current root while deep in a stack
   * pops back to it — matching how tab bars behave everywhere else.
   */
  switchTo(id: string): void {
    if (this.stack.length === 1 && this.stack[0].id === id) return;
    this.stack = [{ id }];
    this.replaceHistory();
    this.applyTop();
  }

  /** Drill down. The current screen stays mounted underneath, deactivated. */
  push(id: string, params?: unknown): void {
    if (!this.screens.has(id)) return;
    this.stack.push({ id, params });
    this.suppressPopstate = true;
    history.pushState({ ipDepth: this.stack.length } satisfies NavHistoryState, '');
    this.suppressPopstate = false;
    this.applyTop();
  }

  /**
   * Go back one level. Returns false at the root, so callers can fall through
   * to whatever "back" means there (usually nothing).
   */
  pop(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.suppressPopstate = true;
    history.back();
    this.suppressPopstate = false;
    this.applyTop();
    return true;
  }

  canGoBack(): boolean {
    return this.stack.length > 1;
  }

  /** Id of the visible screen, whether it is a root or a pushed one. */
  getActiveScreenId(): string | null {
    return this.stack.length ? this.stack[this.stack.length - 1].id : null;
  }

  /** Id of the current root — what the bottom nav should show as selected. */
  getRootScreenId(): string | null {
    return this.stack.length ? this.stack[0].id : null;
  }

  /** Notified on every depth change, so the nav can hide itself in a drill-down. */
  onStackChange(cb: (depth: number) => void): () => void {
    this.stackListeners.add(cb);
    return () => this.stackListeners.delete(cb);
  }

  // ── internals ─────────────────────────────────────────────

  /**
   * One shared header rather than one per screen: a back affordance that is
   * implemented twelve times is a back affordance that behaves twelve ways.
   * It only appears at depth > 1 — roots are already identified by the nav
   * tab, and a redundant title bar costs vertical space the screens need.
   */
  private mountHeader(): void {
    const container = document.getElementById('screen-container');
    if (!container || !container.parentElement) return;

    const header = document.createElement('header');
    header.id = 'screen-header';
    header.hidden = true;

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'screen-header-back';
    back.setAttribute('aria-label', 'Go back');
    back.innerHTML = '<span aria-hidden="true">‹</span>';
    back.addEventListener('click', () => this.pop());

    const title = document.createElement('h1');
    title.className = 'screen-header-title';

    header.append(back, title);
    container.parentElement.insertBefore(header, container);

    this.headerEl = header;
    this.titleEl = title;
  }

  private handlePopstate(e: PopStateEvent): void {
    if (this.suppressPopstate) return;
    // Ignore history entries we did not create.
    if (!isNavState(e.state) && this.stack.length <= 1) return;

    const targetDepth = isNavState(e.state) ? e.state.ipDepth : 1;
    if (targetDepth >= this.stack.length) return;

    this.stack.length = Math.max(1, targetDepth);
    this.applyTop();
  }

  private replaceHistory(): void {
    this.suppressPopstate = true;
    history.replaceState({ ipDepth: 1 } satisfies NavHistoryState, '');
    this.suppressPopstate = false;
  }

  /** Render whatever is on top of the stack and deactivate everything else. */
  private applyTop(): void {
    const top = this.stack[this.stack.length - 1];
    if (!top) return;

    for (const [screenId, registered] of this.screens) {
      if (screenId === top.id) continue;
      if (registered.element.classList.contains('active')) {
        registered.element.classList.remove('active');
        registered.screen.onDeactivate();
      } else {
        // Clears stale `active` set in the HTML before any switch happened.
        registered.element.classList.remove('active');
      }
    }

    const next = this.screens.get(top.id);
    if (next) {
      next.element.classList.add('active');
      next.screen.onActivate(top.params);
    }

    this.updateHeader(next?.title);
    document.body.dataset.activeScreen = top.id;
    document.body.dataset.navDepth = String(this.stack.length);

    for (const cb of this.stackListeners) cb(this.stack.length);
  }

  private updateHeader(title?: string): void {
    if (!this.headerEl || !this.titleEl) return;
    const deep = this.stack.length > 1;
    this.headerEl.hidden = !deep;
    // textContent, not innerHTML — titles can carry player-supplied text.
    this.titleEl.textContent = deep ? (title ?? '') : '';
  }
}
