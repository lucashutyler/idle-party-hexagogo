import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientSocialState, ServerErrorCode, ServerStateMessage, TradeState } from '@idle-party-rpg/shared';
import { SocialScreen } from '../src/screens/SocialScreen';
import type { GameClient } from '../src/network/GameClient';
import type { ChatLocalStore } from '../src/network/ChatLocalStore';
import type { WorldCache } from '../src/network/WorldCache';

/**
 * The trade confirm nonce (issue #295) is only as good as what the client sends
 * with it. These pin the two client-side properties the server check relies on:
 *   1. Confirm is never silently re-armed when the partner changes their offer —
 *      otherwise a partner can swap items in during the read-then-click window
 *      and the server sees a perfectly valid nonce.
 *   2. The modal keeps receiving state even when SocialScreen is deactivated,
 *      because the Items screen opens it without a screen switch.
 */

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: ServerErrorCode) => void;

function makeTrade(overrides: Partial<TradeState> = {}): TradeState {
  return {
    id: 'trade_1',
    status: 'countered',
    initiator: { username: 'alice', items: [{ itemId: 'sword', quantity: 1 }] },
    target: { username: 'bob', items: [{ itemId: 'legendary_blade', quantity: 1 }] },
    timestamp: 1,
    lastUpdatedBy: 'bob',
    nonce: 'nonce-1',
    ...overrides,
  };
}

function makeState(trade: TradeState): ServerStateMessage {
  return {
    username: 'alice',
    character: { inventory: { sword: 1 } },
    itemDefinitions: {
      sword: { id: 'sword', name: 'Sword', rarity: 'common' },
      legendary_blade: { id: 'legendary_blade', name: 'Legendary Blade', rarity: 'legendary' },
      pebble: { id: 'pebble', name: 'Pebble', rarity: 'common' },
    },
    social: { proposedTrades: [trade] } as unknown as ClientSocialState,
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '<div id="social"></div>';

  const listeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState: ServerStateMessage | null = null;
  const sendConfirmTrade = vi.fn();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onResume: () => () => {},
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    onChat: () => () => {},
    onSyncChat: () => () => {},
    sendSyncChat: () => {},
    sendConfirmTrade,
    sendCounterTrade: vi.fn(),
    sendProposeTrade: vi.fn(),
    sendCancelTrade: vi.fn(),
  } as unknown as GameClient;

  const chatStore = {
    getLatestId: () => null,
    addMessage: () => {},
    mergeSyncBatch: () => {},
  } as unknown as ChatLocalStore;

  const worldCache = { getSkillContent: () => ({ skills: {} }) } as unknown as WorldCache;

  const screen = new SocialScreen('social', gameClient, chatStore, worldCache);

  /** Push a state frame the way the server would. */
  const push = (trade: TradeState) => {
    lastState = makeState(trade);
    for (const l of listeners) l(lastState);
  };

  /** Deliver a server `error` frame the way GameClient would. */
  const pushError = (message: string, code?: ServerErrorCode) => {
    for (const l of errorListeners) l(message, code);
  };

  const modal = () => document.querySelector('.trade-modal');
  const confirmBtn = () => document.querySelector('.trade-modal-confirm-btn') as HTMLButtonElement | null;
  const reviewBtn = () => document.querySelector('.trade-modal-review-btn') as HTMLButtonElement | null;

  return {
    screen, push, pushError, sendConfirmTrade, modal, confirmBtn, reviewBtn,
    listenerCount: () => listeners.size,
  };
}

describe('trade confirm nonce (client)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('sends the nonce of the offer on screen', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');

    t.confirmBtn()!.click();
    expect(t.sendConfirmTrade).toHaveBeenCalledWith('trade_1', 'nonce-1');
  });

  it('does not gate the normal flow when the partner first counters', () => {
    const t = setup();
    // Proposed by alice, waiting on bob — no confirm button yet.
    t.push(makeTrade({ status: 'pending', lastUpdatedBy: 'alice', target: { username: 'bob', items: [] } }));
    t.screen.openExistingTrade('trade_1');
    expect(t.confirmBtn()).toBeNull();

    // Bob counters for the first time — confirm appears and is immediately live.
    t.push(makeTrade({ nonce: 'nonce-2' }));
    expect(t.reviewBtn()).toBeNull();
    t.confirmBtn()!.click();
    expect(t.sendConfirmTrade).toHaveBeenCalledWith('trade_1', 'nonce-2');
  });

  it('withholds confirm when the offer changes while the button is on screen', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');
    expect(t.confirmBtn()).not.toBeNull();

    // Bob swaps the Legendary Blade for a Pebble while alice is reaching for Confirm.
    t.push(makeTrade({
      nonce: 'nonce-2',
      target: { username: 'bob', items: [{ itemId: 'pebble', quantity: 1 }] },
    }));

    // Confirm is gone — a swapped-in offer cannot be accepted by an already-aimed click.
    expect(t.confirmBtn()).toBeNull();
    expect(t.reviewBtn()).not.toBeNull();
    expect(t.modal()!.textContent).toContain('changed while you were looking at it');
    expect(t.sendConfirmTrade).not.toHaveBeenCalled();
  });

  it('re-arms confirm against the new offer once the player acknowledges it', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');
    t.push(makeTrade({
      nonce: 'nonce-2',
      target: { username: 'bob', items: [{ itemId: 'pebble', quantity: 1 }] },
    }));

    t.reviewBtn()!.click();
    expect(t.reviewBtn()).toBeNull();
    t.confirmBtn()!.click();
    expect(t.sendConfirmTrade).toHaveBeenCalledWith('trade_1', 'nonce-2');
  });

  it('gates again if the offer moves a second time', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');
    t.push(makeTrade({ nonce: 'nonce-2' }));
    t.reviewBtn()!.click();

    t.push(makeTrade({ nonce: 'nonce-3' }));
    expect(t.confirmBtn()).toBeNull();
    expect(t.reviewBtn()).not.toBeNull();
  });

  it('explains a rejected confirm instead of leaving a silently dead button', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');
    t.confirmBtn()!.click();

    // The server rejected it because the offer had already moved on.
    t.pushError('This trade changed — review the updated offer before confirming', 'trade_nonce_mismatch');
    expect(t.modal()!.textContent).toContain('changed before your confirmation went through');
  });

  it('ignores unrelated server errors', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');

    t.pushError('Your inventory is full for that item (max 99)');
    expect(t.modal()!.textContent).not.toContain('changed before your confirmation');
    expect(t.confirmBtn()).not.toBeNull();
  });

  it('keeps the gate up when a counter attempt fails silently', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');

    // Bob swaps the offer while Confirm is on screen — gate goes up.
    const swapped = makeTrade({
      nonce: 'nonce-2',
      target: { username: 'bob', items: [{ itemId: 'pebble', quantity: 1 }] },
    });
    t.push(swapped);
    expect(t.reviewBtn()).not.toBeNull();

    // Alice tries to counter instead. The server rejects it (untagged error, no
    // state push) or the socket was closed — either way nothing repaints.
    (document.querySelector('.trade-qty-inc') as HTMLButtonElement).click();
    (document.querySelector('.trade-send-btn') as HTMLButtonElement).click();

    // The next routine state tick must NOT turn Review back into a live Confirm.
    t.push(swapped);
    expect(t.confirmBtn()).toBeNull();
    expect(t.reviewBtn()).not.toBeNull();
  });

  it('drops the gate once the player\'s own counter lands', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.openExistingTrade('trade_1');
    t.push(makeTrade({ nonce: 'nonce-2' }));
    expect(t.reviewBtn()).not.toBeNull();

    // Alice's counter lands — now bob has to act, so there is nothing to gate.
    t.push(makeTrade({ nonce: 'nonce-3', lastUpdatedBy: 'alice' }));
    expect(t.reviewBtn()).toBeNull();
    expect(t.confirmBtn()).toBeNull();

    // Bob counters back: confirm is live again without a stale review gate.
    t.push(makeTrade({ nonce: 'nonce-4' }));
    expect(t.reviewBtn()).toBeNull();
    t.confirmBtn()!.click();
    expect(t.sendConfirmTrade).toHaveBeenCalledWith('trade_1', 'nonce-4');
  });

  it('keeps the modal live when opened while the screen is deactivated', () => {
    const t = setup();
    t.push(makeTrade());
    // Opened from the Items screen: no onActivate, so the screen has no
    // subscription of its own.
    expect(t.listenerCount()).toBe(0);
    t.screen.openExistingTrade('trade_1');
    expect(t.listenerCount()).toBe(1);

    // A later offer change still reaches the modal.
    t.push(makeTrade({ nonce: 'nonce-2' }));
    expect(t.reviewBtn()).not.toBeNull();

    t.screen.dismissTradeModal();
    expect(t.listenerCount()).toBe(0);
  });

  it('paints from fresh state, not a frozen snapshot, when opened from another screen', () => {
    const t = setup();
    t.push(makeTrade());
    t.screen.onActivate();      // screen caches state...
    t.screen.onDeactivate();    // ...then goes away, freezing it
    t.push(makeTrade({ nonce: 'nonce-2' }));

    t.screen.openExistingTrade('trade_1');
    t.confirmBtn()!.click();
    // The frozen snapshot held nonce-1; the modal must use the live nonce-2.
    expect(t.sendConfirmTrade).toHaveBeenCalledWith('trade_1', 'nonce-2');
  });
});
