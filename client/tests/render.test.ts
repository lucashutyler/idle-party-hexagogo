import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deferWhilePressed, setHtml } from '../src/ui/render';

function press(target: Element, button = 0): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button }));
}

function releaseOn(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
}

describe('setHtml', () => {
  it('writes changed HTML and skips identical HTML, keeping the same nodes', () => {
    const el = document.createElement('div');
    expect(setHtml(el, '<button>A</button>')).toBe(true);
    const button = el.querySelector('button');
    expect(setHtml(el, '<button>A</button>')).toBe(false);
    expect(el.querySelector('button')).toBe(button);
    expect(setHtml(el, '<button>B</button>')).toBe(true);
    expect(el.textContent).toBe('B');
  });

  it('caches per element', () => {
    const a = document.createElement('div');
    const b = document.createElement('div');
    setHtml(a, 'x');
    expect(setHtml(b, 'x')).toBe(true);
  });
});

describe('deferWhilePressed', () => {
  let root: HTMLElement;
  let button: HTMLButtonElement;
  let outside: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="root"><button id="btn">Go</button></div><div id="out"></div>';
    root = document.getElementById('root')!;
    button = document.getElementById('btn') as HTMLButtonElement;
    outside = document.getElementById('out')!;
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('paints immediately when nothing is pressed', () => {
    const paint = vi.fn();
    deferWhilePressed(root, paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('paints immediately when the press is outside the root', () => {
    press(outside);
    const paint = vi.fn();
    deferWhilePressed(root, paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('ignores non-primary buttons', () => {
    press(button, 2);
    const paint = vi.fn();
    deferWhilePressed(root, paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('holds a paint until the click has run on the pressed DOM, then runs only the latest', () => {
    const first = vi.fn();
    const latest = vi.fn(() => { root.innerHTML = '<button>New</button>'; });
    let clickSawOriginal = false;
    button.addEventListener('click', () => { clickSawOriginal = button.isConnected && latest.mock.calls.length === 0; });

    press(button);
    deferWhilePressed(root, first);
    deferWhilePressed(root, latest);
    expect(first).not.toHaveBeenCalled();
    expect(latest).not.toHaveBeenCalled();

    releaseOn(button);
    button.click();
    expect(clickSawOriginal).toBe(true);
    expect(latest).not.toHaveBeenCalled();

    vi.advanceTimersByTime(0);
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });

  it('flushes a press that ends without a click after the grace period', () => {
    const paint = vi.fn();
    press(button);
    deferWhilePressed(root, paint);
    releaseOn(outside);
    vi.advanceTimersByTime(399);
    expect(paint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('flushes at once when the press is cancelled or the window blurs', () => {
    const paint = vi.fn();
    press(button);
    deferWhilePressed(root, paint);
    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(paint).toHaveBeenCalledTimes(1);

    press(button);
    deferWhilePressed(root, paint);
    window.dispatchEvent(new Event('blur'));
    expect(paint).toHaveBeenCalledTimes(2);
  });

  it('never holds longer than the cap when pointerup is lost', () => {
    const paint = vi.fn();
    press(button);
    deferWhilePressed(root, paint);
    vi.advanceTimersByTime(4999);
    expect(paint).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it('paints immediately again once a press has been released', () => {
    press(button);
    releaseOn(button);
    button.click();
    vi.advanceTimersByTime(0);
    const paint = vi.fn();
    deferWhilePressed(root, paint);
    expect(paint).toHaveBeenCalledTimes(1);
  });
});
