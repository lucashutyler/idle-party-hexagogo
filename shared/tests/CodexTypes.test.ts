import { describe, it, expect } from 'vitest';
import {
  CODEX_ID_MAX_LENGTH,
  codexRefKey,
  codexTableKey,
  isCodexRef,
  parseCodexRefKey,
} from '../src/systems/CodexTypes';

describe('codexTableKey', () => {
  it('keys a room with its own table by the room', () => {
    expect(codexTableKey({ id: 'mill', zone: 'meadow', encounterTable: [{ encounterId: 'wolves', weight: 1 }] })).toBe('r:mill');
  });

  it('keys a room without a table, or with an empty one, by its zone', () => {
    expect(codexTableKey({ id: 'mill', zone: 'meadow' })).toBe('z:meadow');
    expect(codexTableKey({ id: 'mill', zone: 'meadow', encounterTable: [] })).toBe('z:meadow');
  });
});

describe('codexRefKey and parseCodexRefKey', () => {
  it('round-trips every kind', () => {
    for (const kind of ['monster', 'item', 'room', 'shop'] as const) {
      expect(parseCodexRefKey(codexRefKey({ kind, id: 'wolf' }))).toEqual({ kind, id: 'wolf' });
    }
  });

  it('splits at the first colon, so an id may hold colons', () => {
    expect(parseCodexRefKey('item:pelt:grey')).toEqual({ kind: 'item', id: 'pelt:grey' });
  });

  it('rejects unknown kinds, missing colons, empty ids and over-long ids', () => {
    expect(parseCodexRefKey('quest:hunt')).toBeNull();
    expect(parseCodexRefKey('monster')).toBeNull();
    expect(parseCodexRefKey('monster:')).toBeNull();
    expect(parseCodexRefKey(`monster:${'x'.repeat(CODEX_ID_MAX_LENGTH + 1)}`)).toBeNull();
    expect(parseCodexRefKey(`monster:${'x'.repeat(CODEX_ID_MAX_LENGTH)}`)).not.toBeNull();
    expect(parseCodexRefKey(':wolf')).toBeNull();
  });

  it('rejects a non-string', () => {
    expect(parseCodexRefKey(42 as unknown as string)).toBeNull();
  });
});

describe('isCodexRef', () => {
  it('accepts a known kind with a valid id', () => {
    expect(isCodexRef({ kind: 'shop', id: 'mill_post' })).toBe(true);
  });

  it('rejects non-objects, arrays, null and bad parts', () => {
    expect(isCodexRef(null)).toBe(false);
    expect(isCodexRef(undefined)).toBe(false);
    expect(isCodexRef('monster:wolf')).toBe(false);
    expect(isCodexRef(['monster', 'wolf'])).toBe(false);
    expect(isCodexRef({ kind: 'npc', id: 'wolf' })).toBe(false);
    expect(isCodexRef({ kind: 'monster', id: '' })).toBe(false);
    expect(isCodexRef({ kind: 'monster', id: 7 })).toBe(false);
    expect(isCodexRef({ kind: 'monster', id: 'x'.repeat(CODEX_ID_MAX_LENGTH + 1) })).toBe(false);
  });
});
