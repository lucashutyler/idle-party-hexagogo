import { escapeHtml } from './CombatFormat';

type NameRole = 'self' | 'party' | 'enemy';

const DAMAGE_TYPE_RE = /\b(physical|magical|holy)\b/gi;
const SELF_SPAN = '<span class="log-name-self">You</span>';
const SENTENCE_START_RE = /(^|[.!?]\s+)$/;

/**
 * Colours player, party and monster names in log lines with one combined RegExp,
 * rebuilt only when the roster changes. The viewer's own name reads as "You".
 */
export class CombatLogFormatter {
  private roles = new Map<string, NameRole>();
  private regex: RegExp | null = null;
  private rosterKey = '';
  private cache = new Map<string, string>();
  private rosterVersion = 0;

  get version(): number {
    return this.rosterVersion;
  }

  /** Returns true when the roster changed (cached HTML was dropped). */
  setRoster(self: string, party: Iterable<string>, enemies: Iterable<string>): boolean {
    const roles = new Map<string, NameRole>();
    for (const name of enemies) if (name) roles.set(escapeHtml(name), 'enemy');
    for (const name of party) if (name) roles.set(escapeHtml(name), 'party');
    if (self) roles.set(escapeHtml(self), 'self');
    const key = [...roles.entries()].map(([n, r]) => `${r}:${n}`).sort().join('\u0000');
    if (key === this.rosterKey) return false;
    this.rosterKey = key;
    this.roles = roles;
    this.cache.clear();
    this.rosterVersion++;
    const names = [...roles.keys()].sort((a, b) => b.length - a.length).map(escapeRegex);
    this.regex = names.length > 0
      ? new RegExp(`(^|[^A-Za-z0-9_])(${names.join('|')})('s|s')?(?![A-Za-z0-9_])`, 'g')
      : null;
    return true;
  }

  /** Escaped HTML for a raw log line; `cacheKey` memoises it until the roster changes. */
  format(text: string, cacheKey?: string): string {
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit;
    }
    let html = escapeHtml(text);
    if (this.regex) {
      html = html.replace(this.regex, (_m, lead: string, name: string, possessive: string | undefined, offset: number, whole: string) => {
        const role = this.roles.get(name);
        if (role === 'self') {
          const word = possessive ? 'Your' : 'You';
          const shown = SENTENCE_START_RE.test(whole.slice(0, offset) + lead) ? word : word.toLowerCase();
          return `${lead}<span class="log-name-self">${shown}</span>`;
        }
        return `${lead}<span class="log-name-${role ?? 'enemy'}">${name}</span>${possessive ?? ''}`;
      });
      if (html.startsWith(SELF_SPAN)) html = SELF_SPAN + secondPerson(html.slice(SELF_SPAN.length));
    }
    html = html.replace(DAMAGE_TYPE_RE, (m) => `<span class="dmg-${m.toLowerCase()}">${m}</span>`);
    if (cacheKey) {
      if (this.cache.size > 600) this.cache.clear();
      this.cache.set(cacheKey, html);
    }
    return html;
  }
}

const IRREGULAR: Record<string, string> = { has: 'have', is: 'are', was: 'were', does: 'do' };

/** " hits Goblin" → " hit Goblin": the log is third person, the viewer's own lines read as "You …". */
function secondPerson(rest: string): string {
  const match = /^ ([a-z]+)\b/.exec(rest);
  if (!match) return rest;
  const verb = match[1];
  let base = IRREGULAR[verb];
  if (!base) {
    if (/(ss|sh|ch|x|z)es$/.test(verb)) base = verb.slice(0, -2);
    else if (/[^aeiou]ies$/.test(verb)) base = `${verb.slice(0, -3)}y`;
    else if (/[^s]s$/.test(verb)) base = verb.slice(0, -1);
    else return rest;
  }
  return ` ${base}${rest.slice(match[0].length)}`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
