import { describe, it, expect, beforeEach } from 'vitest';
import { ScreenManager, type Screen } from '../src/screens/ScreenManager';

/** Records activate/deactivate order so tests can assert on lifecycle, not just classes. */
class FakeScreen implements Screen {
  activations: unknown[] = [];
  deactivations = 0;

  onActivate(params?: unknown): void {
    this.activations.push(params);
  }

  onDeactivate(): void {
    this.deactivations += 1;
  }
}

function setupDom(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="screen-container">
        <div id="screen-a" class="screen"></div>
        <div id="screen-b" class="screen"></div>
        <div id="screen-c" class="screen"></div>
      </div>
    </div>
  `;
  delete document.body.dataset.activeScreen;
  delete document.body.dataset.navDepth;
}

function build(): { mgr: ScreenManager; a: FakeScreen; b: FakeScreen; c: FakeScreen } {
  const mgr = new ScreenManager();
  const a = new FakeScreen();
  const b = new FakeScreen();
  const c = new FakeScreen();
  mgr.register('a', document.getElementById('screen-a')!, a);
  mgr.register('b', document.getElementById('screen-b')!, b, 'Screen B');
  mgr.register('c', document.getElementById('screen-c')!, c, 'Screen C');
  return { mgr, a, b, c };
}

const header = () => document.getElementById('screen-header')!;
const headerTitle = () => header().querySelector('.screen-header-title')!;

describe('ScreenManager', () => {
  beforeEach(() => {
    setupDom();
    history.replaceState(null, '');
  });

  describe('roots', () => {
    it('activates the screen it switches to', () => {
      const { mgr, a } = build();
      mgr.switchTo('a');
      expect(a.activations).toHaveLength(1);
      expect(document.getElementById('screen-a')!.classList.contains('active')).toBe(true);
      expect(document.body.dataset.activeScreen).toBe('a');
    });

    it('deactivates the previous root when switching', () => {
      const { mgr, a, b } = build();
      mgr.switchTo('a');
      mgr.switchTo('b');
      expect(a.deactivations).toBe(1);
      expect(document.getElementById('screen-a')!.classList.contains('active')).toBe(false);
      expect(b.activations).toHaveLength(1);
    });

    it('is a no-op when switching to the already-active root', () => {
      const { mgr, a } = build();
      mgr.switchTo('a');
      mgr.switchTo('a');
      expect(a.activations).toHaveLength(1);
      expect(a.deactivations).toBe(0);
    });

    it('starts at depth 1 with no back available', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      expect(mgr.canGoBack()).toBe(false);
      expect(document.body.dataset.navDepth).toBe('1');
    });
  });

  describe('push and pop', () => {
    it('pushing keeps the root as the reported root', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      expect(mgr.getRootScreenId()).toBe('a');
      expect(mgr.getActiveScreenId()).toBe('b');
      expect(mgr.canGoBack()).toBe(true);
      expect(document.body.dataset.navDepth).toBe('2');
    });

    it('passes params through to onActivate', () => {
      const { mgr, b } = build();
      mgr.switchTo('a');
      mgr.push('b', { slot: 'chest' });
      expect(b.activations).toEqual([{ slot: 'chest' }]);
    });

    it('pops back to the screen underneath and reactivates it', () => {
      const { mgr, a, b } = build();
      mgr.switchTo('a');
      mgr.push('b');
      expect(mgr.pop()).toBe(true);
      expect(mgr.getActiveScreenId()).toBe('a');
      expect(a.activations).toHaveLength(2);
      expect(b.deactivations).toBe(1);
    });

    it('refuses to pop at the root', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      expect(mgr.pop()).toBe(false);
      expect(mgr.getActiveScreenId()).toBe('a');
    });

    it('stacks more than one level deep', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      mgr.push('c');
      expect(document.body.dataset.navDepth).toBe('3');
      mgr.pop();
      expect(mgr.getActiveScreenId()).toBe('b');
      mgr.pop();
      expect(mgr.getActiveScreenId()).toBe('a');
      expect(mgr.canGoBack()).toBe(false);
    });

    it('discards the drill-down when a new root is selected', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      mgr.push('c');
      mgr.switchTo('a');
      expect(mgr.canGoBack()).toBe(false);
      expect(mgr.getActiveScreenId()).toBe('a');
      expect(document.body.dataset.navDepth).toBe('1');
    });

    it('ignores a push to an unregistered screen', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('nope');
      expect(mgr.getActiveScreenId()).toBe('a');
      expect(mgr.canGoBack()).toBe(false);
    });
  });

  describe('header', () => {
    it('stays hidden at the root', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      expect(header().hidden).toBe(true);
    });

    it('appears with the pushed screen title', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      expect(header().hidden).toBe(false);
      expect(headerTitle().textContent).toBe('Screen B');
    });

    it('hides again after popping back to the root', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      mgr.pop();
      expect(header().hidden).toBe(true);
      expect(headerTitle().textContent).toBe('');
    });

    it('sets the title as text, never as markup', () => {
      const { mgr } = build();
      mgr.register('x', document.getElementById('screen-c')!, new FakeScreen(), '<img src=x onerror=alert(1)>');
      mgr.switchTo('a');
      mgr.push('x');
      expect(headerTitle().querySelector('img')).toBeNull();
      expect(headerTitle().textContent).toBe('<img src=x onerror=alert(1)>');
    });

    it('has an accessible back control', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      const back = header().querySelector('.screen-header-back')!;
      expect(back.getAttribute('aria-label')).toBe('Go back');
    });

    it('pops when the back control is clicked', () => {
      const { mgr } = build();
      mgr.switchTo('a');
      mgr.push('b');
      (header().querySelector('.screen-header-back') as HTMLElement).click();
      expect(mgr.getActiveScreenId()).toBe('a');
    });
  });

  describe('stack listeners', () => {
    it('reports each depth change and stops after unsubscribe', () => {
      const { mgr } = build();
      const depths: number[] = [];
      const off = mgr.onStackChange((d) => depths.push(d));
      mgr.switchTo('a');
      mgr.push('b');
      mgr.pop();
      off();
      mgr.push('c');
      expect(depths).toEqual([1, 2, 1]);
    });
  });
});
