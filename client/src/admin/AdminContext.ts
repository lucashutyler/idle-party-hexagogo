import type { AccountData, ContentData, ContentVersion, OverviewData } from './types';

/**
 * Shared state and actions exposed to tabs. The AdminApp owns the data;
 * tabs read from this context and call its methods to mutate or refresh.
 */
export interface AdminContext {
  // ---- Read state ----
  readonly overview: OverviewData | null;
  readonly accounts: AccountData[];
  readonly versions: ContentVersion[];
  readonly activeVersionId: string | null;
  readonly selectedVersionId: string | null;
  readonly versionContent: ContentData | null;

  /** Always returns the currently displayed snapshot (or null if not loaded). */
  getDisplayContent(): ContentData | null;
  /** True when the displayed version is published or active (not editable). */
  isReadOnly(): boolean;
  /** Returns "?versionId=..." for editable drafts, "" otherwise. */
  versionQueryParam(): string;

  // ---- Actions ----
  /** Refresh server-side data (overview + accounts) and re-render the active tab. */
  refresh(): Promise<void>;
  /** Refresh only the versions list. */
  refreshVersions(): Promise<void>;
  /** Switch to a different version (loads its content snapshot). */
  selectVersion(id: string): Promise<void>;
  /** Re-render the active tab without re-fetching anything. */
  rerenderTab(): void;
  /** Update the displayed content snapshot in-place (used after PUT/DELETE). */
  patchVersionContent(patch: Partial<ContentData>): void;
  /** Re-render the always-visible status bar (e.g. when a version's status changes). */
  refreshStatusBar(): void;
}
