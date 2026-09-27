import type { CombatLogBuffer, CombatLogLine } from './CombatLogBuffer';
import type { CombatLogFormatter } from './CombatLogFormatter';

export const TICKER_LINES = 3;
export const TICKER_MIN_INTERVAL_MS = 250;

/** Three-line live ticker plus the expandable full log, both fed by the shared CombatLogBuffer. */
export class CombatLogView {
  private readonly wrapper: HTMLElement;
  private readonly ticker: HTMLElement;
  private readonly full: HTMLElement;
  private readonly resumeBtn: HTMLElement;
  private readonly fullscreenBtn: HTMLElement;
  private readonly buffer: CombatLogBuffer;
  private readonly formatter: CombatLogFormatter;
  private active = false;
  private open = false;
  private paused = false;
  private dirty = true;
  private lastTickerAt = -Infinity;
  private lastTickerKey = '';
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private renderedSeqs: number[] = [];
  private renderedGen = -1;
  private renderedFormatter = -1;
  private onOpenChange?: (open: boolean) => void;

  constructor(wrapper: HTMLElement, buffer: CombatLogBuffer, formatter: CombatLogFormatter) {
    this.wrapper = wrapper;
    this.buffer = buffer;
    this.formatter = formatter;
    wrapper.innerHTML = `
      <div class="combat-log-controls">
        <span class="combat-log-title">Battle log</span>
        <button type="button" class="log-fullscreen-btn" title="Expand log" aria-label="Expand log">⛶</button>
      </div>
      <div class="combat-log-ticker" role="log" aria-live="off"></div>
      <div class="combat-log"></div>
      <button type="button" class="log-resume-btn" style="display:none">▼ Resume Live</button>
    `;
    this.ticker = wrapper.querySelector('.combat-log-ticker')!;
    this.full = wrapper.querySelector('.combat-log')!;
    this.resumeBtn = wrapper.querySelector('.log-resume-btn')!;
    this.fullscreenBtn = wrapper.querySelector('.log-fullscreen-btn')!;

    buffer.subscribe(() => this.markDirty());
    this.fullscreenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setOpen(!this.open);
    });
    this.ticker.addEventListener('click', () => this.setOpen(true));
    this.full.addEventListener('scroll', () => {
      if (this.paused || !this.open) return;
      const { scrollTop, scrollHeight, clientHeight } = this.full;
      if (scrollTop + clientHeight < scrollHeight - 20) this.setPaused(true);
    });
    this.resumeBtn.addEventListener('click', () => {
      this.setPaused(false);
      this.renderFull(true);
    });
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOnOpenChange(cb: (open: boolean) => void): void {
    this.onOpenChange = cb;
  }

  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.lastTickerKey = '';
      this.renderedGen = -1;
      this.markDirty();
    } else {
      if (this.frame) cancelAnimationFrame(this.frame);
      if (this.timer) clearTimeout(this.timer);
      this.frame = 0;
      this.timer = undefined;
    }
  }

  setOpen(open: boolean): void {
    if (open === this.open) return;
    this.open = open;
    this.wrapper.classList.toggle('fullscreen', open);
    this.fullscreenBtn.textContent = open ? '✖' : '⛶';
    this.fullscreenBtn.title = open ? 'Close log' : 'Expand log';
    this.fullscreenBtn.setAttribute('aria-label', this.fullscreenBtn.title);
    if (open) {
      this.setPaused(false);
      this.renderFull(true);
    } else {
      this.full.replaceChildren();
      this.renderedSeqs = [];
    }
    this.onOpenChange?.(open);
  }

  /** Roster colours changed: re-render with the new names. */
  refresh(): void {
    this.lastTickerKey = '';
    this.renderedFormatter = -1;
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.active || this.frame || this.timer) return;
    const wait = TICKER_MIN_INTERVAL_MS - (performance.now() - this.lastTickerAt);
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.schedule();
      }, wait);
      return;
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame || !this.active) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastTickerAt = performance.now();
    this.renderTicker();
    if (this.open && !this.paused) this.renderFull(false);
  }

  private renderTicker(): void {
    const entries = this.buffer.entries;
    const newest = entries.slice(-TICKER_LINES);
    const key = `${this.formatter.version}|${newest.map(e => e.seq).join(',')}`;
    if (key === this.lastTickerKey) return;
    this.lastTickerKey = key;
    this.ticker.innerHTML = newest.map(line => this.lineHtml(line)).join('');
  }

  private renderFull(force: boolean): void {
    const entries = this.buffer.entries;
    const rebuild = force || this.renderedGen !== this.buffer.generation || this.renderedFormatter !== this.formatter.version;
    if (rebuild) {
      this.full.innerHTML = entries.map(line => this.lineHtml(line)).join('');
      this.renderedSeqs = entries.map(e => e.seq);
      this.renderedGen = this.buffer.generation;
      this.renderedFormatter = this.formatter.version;
    } else {
      const firstSeq = entries.length > 0 ? entries[0].seq : Infinity;
      let drop = 0;
      while (drop < this.renderedSeqs.length && this.renderedSeqs[drop] < firstSeq) drop++;
      for (let i = 0; i < drop; i++) this.full.firstElementChild?.remove();
      if (drop > 0) this.renderedSeqs.splice(0, drop);
      const lastSeq = this.renderedSeqs.length > 0 ? this.renderedSeqs[this.renderedSeqs.length - 1] : -1;
      const fresh = entries.filter(e => e.seq > lastSeq);
      if (fresh.length > 0) {
        this.full.insertAdjacentHTML('beforeend', fresh.map(line => this.lineHtml(line)).join(''));
        for (const line of fresh) this.renderedSeqs.push(line.seq);
      }
    }
    this.full.scrollTop = this.full.scrollHeight;
  }

  private lineHtml(line: CombatLogLine): string {
    return `<div class="log-entry ${line.type}">${this.formatter.format(line.text, line.key)}</div>`;
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.resumeBtn.style.display = paused ? '' : 'none';
  }
}
