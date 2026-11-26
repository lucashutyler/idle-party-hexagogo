import type { CodexKind, CodexRef } from '@idle-party-rpg/shared';
import { codexRefKey, isCodexKind, parseCodexRefKey } from '@idle-party-rpg/shared';
import { escapeHtml } from './ItemIcon';

/** What a `data-codex` link opens. See docs/architecture/codex.md → Client. */
export type CodexTarget = CodexRef | { kind: 'home' } | { kind: 'list'; list: CodexKind };

export const CODEX_UNAVAILABLE_TEXT = "The Codex isn't available right now.";
export const CODEX_LOAD_FAILED_TEXT = "The Codex couldn't be loaded. Check your connection and try again.";

const LIST_PREFIX = 'list:';

/** `home`, `list:monster`, `monster:<id>` … */
export function codexTargetKey(target: CodexTarget): string {
  if (target.kind === 'home') return 'home';
  if (target.kind === 'list') return `${LIST_PREFIX}${target.list}`;
  return codexRefKey(target);
}

export function codexTargetAttr(target: CodexTarget): string {
  return escapeHtml(codexTargetKey(target));
}

export function parseCodexTarget(value: string | null | undefined): CodexTarget | null {
  if (!value) return null;
  if (value === 'home') return { kind: 'home' };
  if (value.startsWith(LIST_PREFIX)) {
    const list = value.slice(LIST_PREFIX.length);
    return isCodexKind(list) ? { kind: 'list', list } : null;
  }
  return parseCodexRefKey(value);
}

/** An inline button that opens `ref`'s entry; `label` is plain text. */
export function codexLinkHtml(ref: CodexRef, label: string, className = ''): string {
  const classes = className ? `codex-link ${className}` : 'codex-link';
  return `<button type="button" class="${classes}" data-codex="${codexTargetAttr(ref)}">${escapeHtml(label)}</button>`;
}

export interface CodexOpenerDeps {
  /** The state carries the Codex marker, so the server can answer. */
  available(): boolean;
  /** Loads the window on first use. */
  load(): Promise<{ open(target: CodexTarget): void }>;
  toast(message: string): void;
}

/** Opens the Codex at a target, loading its window the first time; taps while it loads do nothing. */
export function createCodexOpener(deps: CodexOpenerDeps): (target: CodexTarget) => Promise<void> {
  let modal: { open(target: CodexTarget): void } | null = null;
  let loading = false;
  return async (target) => {
    if (!deps.available()) {
      deps.toast(CODEX_UNAVAILABLE_TEXT);
      return;
    }
    if (modal) {
      modal.open(target);
      return;
    }
    if (loading) return;
    loading = true;
    modal = await deps.load().catch(() => null);
    loading = false;
    if (modal) modal.open(target);
    else deps.toast(CODEX_LOAD_FAILED_TEXT);
  };
}

/** Any `[data-codex]` element opens its target. Capture phase, so panels that stop clicks still pass it on. */
export function installCodexDelegate(open: (target: CodexTarget) => void): () => void {
  const onClick = (e: MouseEvent): void => {
    const el = (e.target as Element | null)?.closest?.('[data-codex]');
    const target = parseCodexTarget(el?.getAttribute('data-codex'));
    if (target) open(target);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
