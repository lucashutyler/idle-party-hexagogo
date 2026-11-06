import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_SKILLS } from '@idle-party-rpg/shared';
import { classAttackSkill } from '../src/ui/SkillCardChip';
import { WorldCache } from '../src/network/WorldCache';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(skills: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/world') return json({ startTile: { col: 0, row: 0 }, tiles: [] });
    if (url === '/api/skills') return skills();
    return json({});
  }));
}

describe('WorldCache skill catalog', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('offers no Attack before the catalog loads', () => {
    const cache = new WorldCache();
    expect(cache.hasServerSkillCatalog()).toBe(false);
    expect(classAttackSkill('Knight', cache.getSkillContent().skills)).toBeUndefined();
    expect(cache.getSkill('knight_bash')).toBeDefined();
  });

  it.each([
    ['fails', () => new Response('', { status: 500 })],
    ['does not parse', () => new Response('not json', { status: 200 })],
    ['has no skills', () => json({})],
  ])('offers no Attack when the skills response %s', async (_label, skills) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubFetch(skills);
    const cache = new WorldCache();
    await cache.loadWorld();
    expect(cache.hasServerSkillCatalog()).toBe(false);
    expect(classAttackSkill('Knight', cache.getSkillContent().skills)).toBeUndefined();
  });

  it('uses the server catalog, Attack included, and keeps it through a later failed fetch', async () => {
    let healthy = true;
    stubFetch(() => (healthy ? json({ skills: { knight_attack: SEED_SKILLS.knight_attack } }) : new Response('', { status: 500 })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cache = new WorldCache();
    await cache.loadWorld();
    expect(cache.hasServerSkillCatalog()).toBe(true);
    expect(classAttackSkill('Knight', cache.getSkillContent().skills)?.id).toBe('knight_attack');

    healthy = false;
    await cache.loadWorld();
    expect(cache.hasServerSkillCatalog()).toBe(true);
    expect(classAttackSkill('Knight', cache.getSkillContent().skills)?.id).toBe('knight_attack');
  });
});
