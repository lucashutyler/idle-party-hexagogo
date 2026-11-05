import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Screen } from '../src/screens/ScreenManager';
import { ScreenManager } from '../src/screens/ScreenManager';
import { bringToFront, release } from '../src/ui/ModalStack';
import {
  initNavigation,
  installBackHandler,
  installEscapeHandler,
  installNavDelegate,
  navigate,
} from '../src/ui/navigate';

function fakeScreen(): Screen & { setSubTab: ReturnType<typeof vi.fn> } {
  return { onActivate: vi.fn(), onDeactivate: vi.fn(), setSubTab: vi.fn() };
}

function setup() {
  document.body.innerHTML = '';
  sessionStorage.clear();
  const manager = new ScreenManager();
  const screens = { combat: fakeScreen(), map: fakeScreen(), items: fakeScreen(), social: fakeScreen() };
  for (const [id, screen] of Object.entries(screens)) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    manager.register(id, el, screen);
  }
  const setActiveTab = vi.fn();
  const closeTransient = vi.fn();
  initNavigation({
    getScreen: id => manager.get(id),
    switchTo: id => manager.switchTo(id),
    getActiveScreenId: () => manager.getActiveScreenId(),
    setActiveTab,
    closeTransient,
  });
  return { manager, screens, setActiveTab, closeTransient };
}

describe('navigate', () => {
  afterEach(() => initNavigation(null));

  it('switches screen, updates the tab, saves the screen and closes transient UI', () => {
    const t = setup();
    navigate('map');
    expect(t.manager.getActiveScreenId()).toBe('map');
    expect(t.setActiveTab).toHaveBeenCalledWith('map');
    expect(sessionStorage.getItem('activeScreen')).toBe('map');
    expect(t.closeTransient).toHaveBeenCalledOnce();
    expect(t.screens.map.onActivate).toHaveBeenCalledOnce();
  });

  it('passes the sub-view to the screen before it activates', () => {
    const t = setup();
    const order: string[] = [];
    t.screens.social.setSubTab.mockImplementation(() => order.push('sub'));
    (t.screens.social.onActivate as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('activate'));
    navigate('social', 'friends');
    expect(t.screens.social.setSubTab).toHaveBeenCalledWith('friends');
    expect(order).toEqual(['sub', 'activate']);
  });

  it('works with screens that have no sub-views', () => {
    const t = setup();
    const plain: Screen = { onActivate: vi.fn(), onDeactivate: vi.fn() };
    t.manager.register('craft', document.createElement('div'), plain);
    navigate('craft', 'anything');
    expect(t.manager.getActiveScreenId()).toBe('craft');
  });

  it('sends unknown screen ids to Battle', () => {
    const t = setup();
    navigate('not-a-screen');
    expect(t.manager.getActiveScreenId()).toBe('combat');
    expect(t.setActiveTab).toHaveBeenCalledWith('combat');
    expect(sessionStorage.getItem('activeScreen')).toBe('combat');
  });

  it('migrates the legacy saved character screen', () => {
    const t = setup();
    navigate('character');
    expect(t.manager.getActiveScreenId()).toBe('items');
  });

  it('does nothing before navigation is set up', () => {
    initNavigation(null);
    expect(() => navigate('map')).not.toThrow();
  });
});

describe('[data-nav] delegate', () => {
  let remove: () => void;
  beforeEach(() => { remove = installNavDelegate(); });
  afterEach(() => {
    remove();
    initNavigation(null);
  });

  it('navigates from an element or its children, with the sub-view', () => {
    const t = setup();
    const link = document.createElement('button');
    link.dataset.nav = 'social:guild';
    link.innerHTML = '<span class="inner">Guild</span>';
    document.body.appendChild(link);

    (link.querySelector('.inner') as HTMLElement).click();

    expect(t.manager.getActiveScreenId()).toBe('social');
    expect(t.screens.social.setSubTab).toHaveBeenCalledWith('guild');
  });

  it('ignores other clicks', () => {
    const t = setup();
    const plain = document.createElement('button');
    document.body.appendChild(plain);
    plain.click();
    expect(t.manager.getActiveScreenId()).toBeNull();
  });

  it('stops after removal', () => {
    const t = setup();
    remove();
    const link = document.createElement('button');
    link.dataset.nav = 'map';
    document.body.appendChild(link);
    link.click();
    expect(t.manager.getActiveScreenId()).toBeNull();
  });
});

describe('Back', () => {
  let remove: (() => void) | undefined;
  let closeChat: ReturnType<typeof vi.fn<() => boolean>>;
  let pushState: ReturnType<typeof vi.spyOn>;
  let back: ReturnType<typeof vi.spyOn>;

  const pressBack = (): void => {
    history.replaceState(null, '');
    window.dispatchEvent(new PopStateEvent('popstate'));
  };

  beforeEach(() => {
    history.replaceState(null, '');
    closeChat = vi.fn<() => boolean>(() => false);
    pushState = vi.spyOn(history, 'pushState');
    back = vi.spyOn(history, 'back').mockImplementation(() => {});
  });
  afterEach(() => {
    remove?.();
    remove = undefined;
    vi.restoreAllMocks();
    initNavigation(null);
  });

  it('adds one history entry, and no second one after a reload', () => {
    remove = installBackHandler(closeChat);
    expect(pushState).toHaveBeenCalledOnce();
    expect(pushState.mock.calls[0][2]).toBeUndefined();
    remove();

    history.replaceState(pushState.mock.calls[0][0], '');
    remove = installBackHandler(closeChat);
    expect(pushState).toHaveBeenCalledOnce();
  });

  it('closes the top overlay first and stays in the app', () => {
    const t = setup();
    t.manager.switchTo('map');
    remove = installBackHandler(closeChat);
    pushState.mockClear();

    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const dismiss = vi.fn(() => release(overlay));
    bringToFront(overlay, dismiss);

    pressBack();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(closeChat).not.toHaveBeenCalled();
    expect(t.manager.getActiveScreenId()).toBe('map');
    expect(pushState).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
  });

  it('closes phone chat before changing screen', () => {
    const t = setup();
    t.manager.switchTo('map');
    remove = installBackHandler(closeChat);
    closeChat.mockReturnValueOnce(true);

    pressBack();
    expect(closeChat).toHaveBeenCalledOnce();
    expect(t.manager.getActiveScreenId()).toBe('map');
    expect(back).not.toHaveBeenCalled();
  });

  it('then goes to Battle', () => {
    const t = setup();
    t.manager.switchTo('map');
    remove = installBackHandler(closeChat);

    pressBack();
    expect(t.manager.getActiveScreenId()).toBe('combat');
    expect(back).not.toHaveBeenCalled();
  });

  it('lets the browser leave from Battle with nothing open', () => {
    const t = setup();
    t.manager.switchTo('combat');
    remove = installBackHandler(closeChat);
    pushState.mockClear();

    pressBack();
    expect(back).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('restores its entry on the next press when the browser had nowhere to go', () => {
    const t = setup();
    t.manager.switchTo('combat');
    remove = installBackHandler(closeChat);

    pressBack();
    expect(back).toHaveBeenCalledOnce();

    pushState.mockClear();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(pushState).toHaveBeenCalledOnce();

    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const dismiss = vi.fn(() => release(overlay));
    bringToFront(overlay, dismiss);

    pressBack();
    expect(dismiss).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
  });

  it('adds nothing on a press while its entry is in place', () => {
    remove = installBackHandler(closeChat);
    pushState.mockClear();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    expect(pushState).not.toHaveBeenCalled();
  });

  it('does not restore its entry on a mouse Back button press', () => {
    remove = installBackHandler(closeChat);
    history.replaceState(null, '');
    pushState.mockClear();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 3 }));
    expect(pushState).not.toHaveBeenCalled();
  });

  it('is inert once the shell is torn down', () => {
    const t = setup();
    t.manager.switchTo('map');
    remove = installBackHandler(closeChat);
    remove();
    initNavigation(null);
    pushState.mockClear();

    pressBack();
    document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    navigate('combat');

    expect(t.manager.getActiveScreenId()).toBe('map');
    expect(pushState).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
  });

  it('ignores Forward landing back on its own entry', () => {
    const t = setup();
    t.manager.switchTo('map');
    remove = installBackHandler(closeChat);

    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(t.manager.getActiveScreenId()).toBe('map');
    expect(back).not.toHaveBeenCalled();
  });
});

describe('Escape', () => {
  let remove: () => void;
  beforeEach(() => { remove = installEscapeHandler(); });
  afterEach(() => remove());

  function openOverlay(): ReturnType<typeof vi.fn> {
    const overlay = document.createElement('div');
    document.body.appendChild(overlay);
    const dismiss = vi.fn(() => release(overlay));
    bringToFront(overlay, dismiss);
    return dismiss;
  }

  it('dismisses the top overlay', () => {
    const dismiss = openOverlay();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('leaves it alone when a pinned handler already acted', () => {
    const dismiss = openOverlay();
    const owner = (e: KeyboardEvent): void => e.preventDefault();
    document.addEventListener('keydown', owner);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    document.removeEventListener('keydown', owner);
    expect(dismiss).not.toHaveBeenCalled();
    release(document.body.lastElementChild as HTMLElement);
  });

  it('ignores other keys', () => {
    const dismiss = openOverlay();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(dismiss).not.toHaveBeenCalled();
    release(document.body.lastElementChild as HTMLElement);
  });
});
