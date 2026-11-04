import type { Screen } from '../screens/ScreenManager';
import { dismissTop } from './ModalStack';

export const DEFAULT_SCREEN = 'combat';
export const ACTIVE_SCREEN_KEY = 'activeScreen';

const LEGACY_SCREEN_IDS: Readonly<Record<string, string>> = { character: 'items' };
const BACK_SENTINEL = 'idle-party-back';

export interface NavigationHost {
  getScreen(id: string): Screen | undefined;
  switchTo(id: string): void;
  getActiveScreenId(): string | null;
  setActiveTab(id: string): void;
  closeTransient(): void;
}

let host: NavigationHost | null = null;

export function initNavigation(next: NavigationHost | null): void {
  host = next;
}

/** The one way to change game screen. Unknown ids go to Battle; `sub` selects a sub-view on screens that have them. */
export function navigate(screenId: string, sub?: string): void {
  if (!host) return;
  const legacy = LEGACY_SCREEN_IDS[screenId] ?? screenId;
  const id = host.getScreen(legacy) ? legacy : DEFAULT_SCREEN;
  host.closeTransient();
  if (sub) host.getScreen(id)?.setSubTab?.(sub);
  host.switchTo(id);
  host.setActiveTab(id);
  sessionStorage.setItem(ACTIVE_SCREEN_KEY, id);
}

/** Makes any `[data-nav="screen:sub"]` element navigate on click, so screens can cross-link without touching App. */
export function installNavDelegate(): () => void {
  const onClick = (e: MouseEvent): void => {
    const el = (e.target as Element | null)?.closest?.('[data-nav]');
    const value = el?.getAttribute('data-nav');
    if (!value) return;
    const [screenId, sub] = value.split(':');
    navigate(screenId, sub);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}

function goToDefaultScreen(): boolean {
  if (!host || host.getActiveScreenId() === DEFAULT_SCREEN) return false;
  navigate(DEFAULT_SCREEN);
  return true;
}

/**
 * Keeps one history entry above the page so Back steps through the game first:
 * top overlay, then phone chat (`closeChat` returns whether it closed), then Battle, then out of the app.
 * With no earlier entry the app is still here after that, so the next press restores the entry.
 */
export function installBackHandler(closeChat: () => boolean): () => void {
  const isSentinel = (): boolean => (history.state as { marker?: string } | null)?.marker === BACK_SENTINEL;
  const pushSentinel = (): void => history.pushState({ marker: BACK_SENTINEL }, '');
  if (!isSentinel()) pushSentinel();

  const onPopState = (): void => {
    if (isSentinel()) return;
    if (dismissTop() || closeChat() || goToDefaultScreen()) pushSentinel();
    else history.back();
  };
  // Primary only: a mouse's Back button also fires pointerdown, just before the browser goes back.
  const onPress = (e: PointerEvent): void => {
    if (e.button === 0 && !isSentinel()) pushSentinel();
  };
  window.addEventListener('popstate', onPopState);
  document.addEventListener('pointerdown', onPress, true);
  return () => {
    window.removeEventListener('popstate', onPopState);
    document.removeEventListener('pointerdown', onPress, true);
  };
}

/** Escape closes the top overlay unless a handler that owns the key already acted and called `preventDefault`. */
export function installEscapeHandler(): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !e.defaultPrevented) dismissTop();
  };
  window.addEventListener('keydown', onKeyDown);
  return () => window.removeEventListener('keydown', onKeyDown);
}
