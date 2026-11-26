import { isSpoilerQuest, questTitle } from '@idle-party-rpg/shared';
import type { GamePartyMember, QuestStepInfo, RoomLockInfo, RoomLockMember, RoomLockRequirement, ServerStateMessage } from '@idle-party-rpg/shared';
import { confirmNoteHtml } from './ConfirmDialog';
import { escapeHtml } from './ItemIcon';
import { bringToFront, release } from './ModalStack';
import { deferWhilePressed, setHtml } from './render';
import { removableMembers } from './moveBlockText';
import { lockPreviewKey } from './RoomEntryCheck';

export const LOCK_SPOILER_TEXT = 'Opens later in the main story';
export const NO_WAY_YET_TEXT = "Your party hasn't found a way there yet.";
export const LOCK_OPEN_NOW_TEXT = 'Nothing stops your party now.';
const UNKNOWN_ITEM_NAME = 'a special item';

/** Who is looking at the card and what they may do. */
export interface LockCardContext {
  viewer: string;
  /** The party's players, the viewer included; henchmen never count. */
  humans: readonly GamePartyMember[];
  viewerLevel: number;
  /** Owners and leaders can send the party off. */
  canMove: boolean;
}

export type LockCardAction =
  | { kind: 'walk'; roomId: string }
  | { kind: 'show'; roomId: string }
  | { kind: 'quests' }
  | { kind: 'remove'; username: string };

/** What a lock says, who stands where on it, the viewer's next step and what they can do about it. See docs/architecture/client.md → Lock card. */
export function renderLockCard(lock: RoomLockInfo, ctx: LockCardContext): string {
  const solo = ctx.humans.length <= 1;
  const needs = lock.requirements.map(req => needHtml(req, solo, ctx)).join('');
  const step = viewerStep(lock, ctx);
  const removable = solo ? [] : removableMembers(missingMembers(lock, ctx.viewer), ctx.viewer, ctx.humans);
  const buttons = [
    ...(step ? stepButtons(step.step, ctx) : []),
    ...removable.map(name => button('remove', `Remove ${name} from the party`, { username: name })),
  ];
  return `<div class="lock-card" data-unreachable="${lock.unreachable ? '1' : '0'}">`
    + `<div class="lock-card-title">${escapeHtml(lockCardTitle(lock))}</div>`
    + (needs ? `<ul class="lock-card-needs">${needs}</ul>` : '')
    + (step ? stepHtml(step.step, step.requirement, ctx) : '')
    + (buttons.length > 0 ? `<div class="lock-card-buttons">${buttons.join('')}</div>` : '')
    + '</div>';
}

/** Changes whenever the server's card could: anything that moves the preview, a quest the viewer takes on, or any member's gear (the party's forecast key). */
export function lockCardKey(state: ServerStateMessage | null): string {
  const taken = (state?.activeQuests ?? []).map(q => q.questId).join(',');
  return `${lockPreviewKey(state)}|${taken}|${state?.social?.party?.forecastKey ?? ''}`;
}

export function lockCardTitle(lock: RoomLockInfo): string {
  if (lock.unreachable) return NO_WAY_YET_TEXT;
  if (!lock.onRoute) return '🔒 Locked';
  if (lock.door) return lock.roomName ? `🔒 The way there passes a locked door in ${lock.roomName}` : '🔒 The way there passes a locked door';
  return lock.roomName ? `🔒 The way there passes ${lock.roomName}, which is locked` : '🔒 The way there passes a locked room';
}

/** The card button a click landed on, if any. */
export function lockCardAction(target: EventTarget | null): LockCardAction | null {
  const el = target instanceof Element ? target.closest<HTMLElement>('[data-lock-action]') : null;
  const { lockAction, roomId, username } = el?.dataset ?? {};
  if ((lockAction === 'walk' || lockAction === 'show') && roomId) return { kind: lockAction, roomId };
  if (lockAction === 'quests') return { kind: 'quests' };
  if (lockAction === 'remove' && username) return { kind: 'remove', username };
  return null;
}

function needHtml(req: RoomLockRequirement, solo: boolean, ctx: LockCardContext): string {
  const text = needText(req, solo, ctx);
  const rows = solo ? '' : `<ul class="lock-card-members">${req.members.map(m => memberHtml(m, req, ctx)).join('')}</ul>`;
  return `<li class="lock-card-need"><div class="lock-card-need-text">${escapeHtml(text)}</div>${rows}</li>`;
}

function needText(req: RoomLockRequirement, solo: boolean, ctx: LockCardContext): string {
  switch (req.kind) {
    case 'level':
      return solo ? `You need level ${req.minLevel} (you're level ${ctx.viewerLevel})` : `Needs level ${req.minLevel}`;
    case 'item': {
      const item = req.itemName || UNKNOWN_ITEM_NAME;
      return solo ? `You need ${item} equipped` : `Needs ${item} equipped`;
    }
    case 'quest': {
      const name = gateQuestName(req, ctx);
      if (!name) return LOCK_SPOILER_TEXT;
      return solo ? `You need to complete "${name}"` : `Needs "${name}" completed`;
    }
  }
}

function memberHtml(member: RoomLockMember, req: RoomLockRequirement, ctx: LockCardContext): string {
  const you = member.username === ctx.viewer;
  const details: string[] = [];
  if (!member.met && req.kind === 'level' && member.level !== undefined) details.push(`level ${member.level}`);
  if (!member.met && !you && member.nextStep) details.push(`next: ${stepName(member.nextStep, req, ctx)}`);
  return `<li class="lock-card-member" data-met="${member.met ? '1' : '0'}">`
    + `<span class="lock-card-tick" role="img" aria-label="${member.met ? 'Has it' : 'Missing'}">${member.met ? '✓' : '✗'}</span>`
    + `<span class="lock-card-member-name">${escapeHtml(you ? 'You' : member.username)}</span>`
    + details.map(d => `<span class="lock-card-member-detail">${escapeHtml(d)}</span>`).join('')
    + '</li>';
}

function viewerStep(lock: RoomLockInfo, ctx: LockCardContext): { step: QuestStepInfo; requirement: RoomLockRequirement } | null {
  for (const requirement of lock.requirements) {
    const step = requirement.members.find(m => m.username === ctx.viewer && !m.met)?.nextStep;
    if (step) return { step, requirement };
  }
  return null;
}

function stepHtml(step: QuestStepInfo, req: RoomLockRequirement, ctx: LockCardContext): string {
  const name = stepName(step, req, ctx);
  const place = step.giver ? [step.giver.npcName, step.giver.roomName || step.giver.zoneName, step.giver.mapName].filter(Boolean).join(', ') : '';
  const notes = [stepNote(step), step.remaining > 1 ? `${step.remaining} quests to go` : null].filter(Boolean) as string[];
  return '<div class="lock-card-step">'
    + `<div class="lock-card-step-line">Your next step: <span class="lock-card-step-quest">${escapeHtml(name)}</span>`
    + (place ? `<span class="lock-card-step-place"> · ${escapeHtml(place)}</span>` : '')
    + '</div>'
    + notes.map(note => `<div class="lock-card-step-note">${escapeHtml(note)}</div>`).join('')
    + '</div>';
}

/** A next step that is the hidden gate quest itself is named by what it waits for. */
function stepName(step: QuestStepInfo, req: RoomLockRequirement, ctx: LockCardContext): string {
  if (step.questId === req.questId && !gateQuestName(req, ctx)) {
    return step.requiredLevel !== undefined ? `Reach level ${step.requiredLevel}` : LOCK_SPOILER_TEXT;
  }
  return questTitle({ name: step.questName });
}

function stepNote(step: QuestStepInfo): string | null {
  switch (step.state) {
    case 'active': return "It's in your Quest Log.";
    case 'available': return null;
    case 'needs_level': return step.requiredLevel !== undefined ? `Reach level ${step.requiredLevel} to take it.` : null;
    case 'unavailable': return 'No one offers it yet.';
  }
}

function stepButtons(step: QuestStepInfo, ctx: LockCardContext): string[] {
  const buttons: string[] = [];
  const roomId = step.giver?.roomId;
  if (step.state === 'available' && roomId && ctx.canMove) buttons.push(button('walk', 'Walk there', { roomId }, true));
  if ((step.state === 'available' || step.state === 'needs_level') && roomId) buttons.push(button('show', 'Show on map', { roomId }));
  if (step.state === 'active') buttons.push(button('quests', 'Quest Log', {}, true));
  return buttons;
}

function gateQuestName(req: RoomLockRequirement, ctx: LockCardContext): string | null {
  if (!req.questName || isSpoilerQuest(req.questLevel, ctx.viewerLevel)) return null;
  return questTitle({ name: req.questName });
}

function missingMembers(lock: RoomLockInfo, viewer: string): string[] {
  const names = new Set<string>();
  for (const req of lock.requirements) {
    for (const member of req.members) if (!member.met && member.username !== viewer) names.add(member.username);
  }
  return [...names];
}

function button(action: LockCardAction['kind'], label: string, data: { roomId?: string; username?: string }, primary = false): string {
  const attrs = [
    `data-lock-action="${action}"`,
    data.roomId ? `data-room-id="${escapeHtml(data.roomId)}"` : '',
    data.username ? `data-username="${escapeHtml(data.username)}"` : '',
  ].filter(Boolean).join(' ');
  return `<button type="button" class="lock-card-btn${primary ? ' lock-card-btn-primary' : ''}" ${attrs}>${escapeHtml(label)}</button>`;
}

export interface LockDialogOptions {
  title: string;
  /** What the client can tell, shown until the server's answer arrives. */
  lines: readonly string[];
  /** Stays under the title whatever the server answers. */
  note?: { text: string; danger: boolean } | null;
  context: () => LockCardContext;
  onAction: (action: LockCardAction) => void;
  /** Offered as a Travel button when the server finds nothing in the way after all. */
  onOpen?: () => void;
  /** However the dialog closed. */
  onClose?: () => void;
}

export interface LockDialog {
  readonly isOpen: boolean;
  /** The server's answer; null means nothing stops the party. */
  setLock(lock: RoomLockInfo | null): void;
  close(): void;
}

/** A dialog that stays until closed, for a locked door of the party's room. Shaped like confirmDialog. */
export function showLockDialog(opts: LockDialogOptions): LockDialog {
  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay lock-dialog-overlay';
  overlay.innerHTML = `
    <div class="confirm-dialog lock-dialog" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title)}">
      <div class="confirm-title">${escapeHtml(opts.title)}</div>
      ${confirmNoteHtml(opts.note)}
      <div class="lock-dialog-body"></div>
      <div class="confirm-actions">
        <button type="button" class="pixel-btn confirm-cancel lock-dialog-close">Close</button>
      </div>
    </div>
  `;
  const body = overlay.querySelector<HTMLElement>('.lock-dialog-body')!;
  setHtml(body, `<div class="lock-card"><div class="lock-card-title">🔒 Locked</div>`
    + `<ul class="lock-card-needs">${opts.lines.map(line => `<li class="lock-card-need"><div class="lock-card-need-text">${escapeHtml(line)}</div></li>`).join('')}</ul></div>`);

  let open = true;
  const close = (): void => {
    if (!open) return;
    open = false;
    release(overlay);
    overlay.remove();
    opts.onClose?.();
  };

  let pressedBackdrop = false;
  overlay.addEventListener('pointerdown', (e) => { pressedBackdrop = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.target === overlay && pressedBackdrop) {
      close();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest('.lock-dialog-close')) {
      close();
    } else if (target.closest('.lock-dialog-travel')) {
      close();
      opts.onOpen?.();
    } else {
      const action = lockCardAction(target);
      if (action) opts.onAction(action);
    }
  });

  document.body.appendChild(overlay);
  bringToFront(overlay, close);
  overlay.querySelector<HTMLElement>('.lock-dialog-close')!.focus({ preventScroll: true });

  return {
    get isOpen() { return open; },
    setLock(lock) {
      if (!open) return;
      const html = lock
        ? renderLockCard(lock, opts.context())
        : `<div class="lock-card"><div class="lock-card-title">${escapeHtml(LOCK_OPEN_NOW_TEXT)}</div>`
          + (opts.onOpen ? '<div class="lock-card-buttons"><button type="button" class="lock-card-btn lock-card-btn-primary lock-dialog-travel">Travel</button></div>' : '')
          + '</div>';
      deferWhilePressed(body, () => setHtml(body, html));
    },
    close,
  };
}
