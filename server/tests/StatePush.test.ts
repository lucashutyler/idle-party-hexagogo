import { describe, it, expect } from 'vitest';
import { PARTIAL_STATE_PARAM, restoreElidedState } from '@idle-party-rpg/shared';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { clientAcceptsPartialState, prepareStatePush, encodeStatePush } from '../src/game/StatePush.js';
import type { SentStateFields } from '../src/game/StatePush.js';

const CATALOG = { recipes: [{ id: 'r1', name: 'A recipe with a long enough name to be worth leaving out' }], itemDefs: {} };
const SHOP = { id: 'shop1', name: 'A shop with a long enough name to be worth leaving out', inventory: [] };

function makeState(overrides: Record<string, unknown> = {}): ServerStateMessage {
  return { type: 'state', username: 'alice', battleCount: 1, craftingCatalog: CATALOG, serverVersion: 'v1', ...overrides } as unknown as ServerStateMessage;
}

function push(state: ServerStateMessage, sent: SentStateFields): Record<string, unknown> {
  return JSON.parse(encodeStatePush(prepareStatePush(state), sent));
}

describe('state push encoding', () => {
  it('sends everything the first time', () => {
    const msg = push(makeState(), new Map());
    expect(msg.craftingCatalog).toEqual(CATALOG);
    expect(msg.unchangedFields).toBeUndefined();
  });

  it('names a field it leaves out when the socket already holds it', () => {
    const sent: SentStateFields = new Map();
    push(makeState(), sent);
    const msg = push(makeState(), sent);
    expect(msg.craftingCatalog).toBeUndefined();
    expect(msg.unchangedFields).toEqual(['craftingCatalog']);
  });

  it('sends a field again as soon as it changes', () => {
    const sent: SentStateFields = new Map();
    push(makeState(), sent);
    const changed = { ...CATALOG, itemDefs: { x: { id: 'x' } } };
    expect(push(makeState({ craftingCatalog: changed }), sent).craftingCatalog).toEqual(changed);
  });

  it('always sends small fields, whose name would cost as much as their value', () => {
    const sent: SentStateFields = new Map();
    push(makeState({ otherPlayers: [] }), sent);
    const msg = push(makeState({ otherPlayers: [] }), sent);
    expect(msg.otherPlayers).toEqual([]);
    expect(msg.username).toBe('alice');
    expect(msg.type).toBe('state');
    expect(msg.unchangedFields).not.toContain('otherPlayers');
  });

  it('sends a field that left the state and came back, because the client dropped it', () => {
    const sent: SentStateFields = new Map();
    push(makeState({ shopDefinition: SHOP }), sent);
    const away = push(makeState(), sent);
    expect(away.shopDefinition).toBeUndefined();
    expect(away.unchangedFields).not.toContain('shopDefinition');
    expect(push(makeState({ shopDefinition: SHOP }), sent).shopDefinition).toEqual(SHOP);
  });

  it('sends a field that grew back after shrinking below the size worth leaving out', () => {
    const sent: SentStateFields = new Map();
    const big = ['a long enough entry to be worth leaving out of a state push when unchanged'];
    push(makeState({ unlocked: big }), sent);
    push(makeState({ unlocked: [] }), sent);
    expect(push(makeState({ unlocked: big }), sent).unlocked).toEqual(big);
  });

  it('tracks each socket separately, so a new tab gets everything', () => {
    const fields = prepareStatePush(makeState());
    const oldTab: SentStateFields = new Map();
    encodeStatePush(fields, oldTab);
    expect(JSON.parse(encodeStatePush(fields, oldTab)).craftingCatalog).toBeUndefined();
    expect(JSON.parse(encodeStatePush(fields, new Map())).craftingCatalog).toEqual(CATALOG);
  });

  it('always rebuilds the exact state on the client, whatever the sequence of pushes', () => {
    let seed = 12345;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const longText = (n: number) => `a value long enough to be worth leaving out of a push, variant ${n}`;
    const choices: Record<string, unknown[]> = {
      craftingCatalog: [CATALOG, { recipes: [], itemDefs: { i: longText(1) } }],
      shopDefinition: [undefined, SHOP, { ...SHOP, name: longText(2) }],
      unlocked: [[], [longText(3)], [longText(3), longText(4)]],
      social: [undefined, { allPlayers: [longText(5)] }, { allPlayers: [] }],
      battleCount: [1, 2, 3],
    };

    const sent: SentStateFields = new Map();
    let held: ServerStateMessage | null = null;
    for (let i = 0; i < 500; i++) {
      const overrides: Record<string, unknown> = {};
      for (const [field, values] of Object.entries(choices)) overrides[field] = values[random(values.length)];
      const state = makeState(overrides);

      const received = JSON.parse(encodeStatePush(prepareStatePush(state), sent)) as ServerStateMessage;
      restoreElidedState(received, held);
      held = received;

      expect(received).toEqual(JSON.parse(JSON.stringify(state)));
    }
  });
});

describe('clientAcceptsPartialState', () => {
  it('is true only for a client that asks', () => {
    expect(clientAcceptsPartialState(`/?${PARTIAL_STATE_PARAM}=1`)).toBe(true);
    expect(clientAcceptsPartialState('/')).toBe(false);
    expect(clientAcceptsPartialState(undefined)).toBe(false);
  });

  it('is false for a bundle that only knows the first version of partial pushes', () => {
    expect(clientAcceptsPartialState('/?partialState=1')).toBe(false);
  });

  it.each(['//', '///', '/\\', '?', '%', '//[', '/?%zz', ''])('copes with the request target %s', (target) => {
    expect(clientAcceptsPartialState(target)).toBe(false);
  });

  it('finds the parameter on an odd path', () => {
    expect(clientAcceptsPartialState(`//?${PARTIAL_STATE_PARAM}=1`)).toBe(true);
  });
});
