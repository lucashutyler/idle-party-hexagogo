import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderSegments, wireSegments } from '../src/ui/Segments';

const ITEMS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta', badge: 3 },
  { id: 'c', label: 'Gamma', badge: true },
  { id: 'd', label: 'Delta', badge: 0 },
];

describe('Segments', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root')!;
    root.innerHTML = renderSegments(ITEMS, 'b');
  });

  it('renders a tablist with one selected tab', () => {
    expect(root.querySelector('.ui-segments')?.getAttribute('role')).toBe('tablist');
    const selected = root.querySelectorAll('[role="tab"][aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect((selected[0] as HTMLElement).dataset.seg).toBe('b');
  });

  it('shows counts and dots, and nothing for an empty badge', () => {
    const badge = (id: string) => root.querySelector(`[data-seg="${id}"] .ui-segment-badge`);
    expect(badge('a')).toBeNull();
    expect(badge('b')?.textContent).toBe('3');
    expect(badge('c')?.textContent).toBe('');
    expect(badge('d')).toBeNull();
  });

  it('escapes labels', () => {
    root.innerHTML = renderSegments([{ id: 'x', label: '<b>' }], 'x');
    expect(root.querySelector('.ui-segment-label')?.textContent).toBe('<b>');
  });

  it('reports clicks through repaints', () => {
    const onSelect = vi.fn();
    wireSegments(root, onSelect);
    root.innerHTML = renderSegments(ITEMS, 'a');
    (root.querySelector('[data-seg="c"] .ui-segment-label') as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('moves with the arrow keys and wraps', () => {
    const onSelect = vi.fn();
    wireSegments(root, onSelect);
    root.querySelector('[data-seg="a"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(onSelect).toHaveBeenCalledWith('d');
  });
});
