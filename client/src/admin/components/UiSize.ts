import type { UiSize } from '../types';

const STORAGE_KEY = 'adminUiSize';

export function getUiSize(): UiSize {
  const v = (localStorage.getItem(STORAGE_KEY) ?? 'medium') as UiSize;
  if (v === 'small' || v === 'medium' || v === 'large' || v === 'xlarge') return v;
  return 'medium';
}

export function setUiSize(size: UiSize): void {
  localStorage.setItem(STORAGE_KEY, size);
  applyUiSize(size);
}

export function applyUiSize(size: UiSize = getUiSize()): void {
  document.documentElement.dataset.adminSize = size;
}
