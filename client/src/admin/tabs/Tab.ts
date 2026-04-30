import type { AdminContext } from '../AdminContext';

/**
 * Each admin tab is a long-lived class instance owned by AdminApp.
 * It renders into the provided container and wires its own events.
 */
export interface Tab {
  /** Render the tab's HTML into the container, then wire events. */
  render(container: HTMLElement, ctx: AdminContext): void;
  /** Optional cleanup when leaving the tab (e.g. tear down canvases). */
  cleanup?(): void;
}
