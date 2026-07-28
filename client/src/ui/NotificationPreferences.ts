import {
  NOTIFICATION_EVENT_REGISTRY,
  NOTIFICATION_CATEGORY_META,
  ALL_NOTIFICATION_CHANNELS,
} from '@idle-party-rpg/shared';
import type { NotificationChannel, NotificationPreferences } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { subscribeToPush, unsubscribeFromPush, getPushPermission, isPushSupported, isPushConfiguredOnServer } from '../network/PushNotifications';

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
  in_app: 'In-App',
  browser_push: 'Push',
  email: 'Email',
};

/** Every category that has at least one registered event — categories with none stay hidden (no dead rows). */
function activeCategories(): { category: string; label: string }[] {
  const withEvents = new Set(NOTIFICATION_EVENT_REGISTRY.map(e => e.category));
  return NOTIFICATION_CATEGORY_META.filter(c => withEvents.has(c.category));
}

/** Fills in registry defaults for any event the player hasn't explicitly touched yet. */
function resolvePreferences(saved: NotificationPreferences | undefined): NotificationPreferences {
  const events: Record<string, NotificationChannel[]> = {};
  for (const def of NOTIFICATION_EVENT_REGISTRY) {
    events[def.eventKey] = [...(saved?.events[def.eventKey] ?? def.defaultChannels)];
  }
  return { events, channelDisabled: { ...(saved?.channelDisabled ?? {}) } };
}

/**
 * `channelDisabled[channel]` drives the master checkbox's checked state, so keep it a pure derived
 * value — true only when nothing uses this channel — rather than an independently-toggled flag. That
 * way the master checkbox always reads "checked" whenever at least one event still uses the channel,
 * regardless of whether it changed via the master, a bulk button, or a single per-event checkbox.
 */
function syncChannelDisabled(prefs: NotificationPreferences, channel: NotificationChannel): void {
  prefs.channelDisabled[channel] = !NOTIFICATION_EVENT_REGISTRY.some(def => prefs.events[def.eventKey].includes(channel));
}

// Cached for the page's lifetime, mirroring isPushConfiguredOnServer's caching rationale.
let cachedEmailConfigured: boolean | undefined;
async function isEmailConfiguredOnServer(): Promise<boolean> {
  if (cachedEmailConfigured !== undefined) return cachedEmailConfigured;
  try {
    const res = await fetch('/api/notifications/email-configured', { credentials: 'include' });
    const { configured } = await res.json() as { configured: boolean };
    cachedEmailConfigured = configured;
  } catch {
    cachedEmailConfigured = false;
  }
  return cachedEmailConfigured;
}

/** Why a channel can't be used right now, keyed by channel. Absent = usable. Mutated in place as async checks resolve. */
type DisabledReasons = Partial<Record<NotificationChannel, string>>;

export function renderNotificationPreferences(container: HTMLElement, gameClient: GameClient): void {
  const prefs = resolvePreferences(gameClient.lastState?.social?.notificationPreferences);
  for (const ch of ALL_NOTIFICATION_CHANNELS) syncChannelDisabled(prefs, ch);

  const disabledReasons: DisabledReasons = {};
  if (!isPushSupported()) disabledReasons.browser_push = 'Not supported in this browser';
  renderGrid(container, gameClient, prefs, disabledReasons);

  const pushCheck = disabledReasons.browser_push
    ? Promise.resolve()
    : isPushConfiguredOnServer().then((configured) => {
      if (!configured) disabledReasons.browser_push = 'Not set up on this server';
    });
  const emailCheck = isEmailConfiguredOnServer().then((configured) => {
    if (!configured) disabledReasons.email = 'Not set up on this server';
  });

  Promise.all([pushCheck, emailCheck]).then(() => {
    if (!container.isConnected) return;
    if (disabledReasons.browser_push || disabledReasons.email) {
      renderGrid(container, gameClient, prefs, disabledReasons);
    }
  });
}

/**
 * Renders the grid from a given `prefs` object and wires its handlers to re-render from that same
 * object on mutation — never by re-deriving from `gameClient.lastState`, which only updates once the
 * server's WS response arrives on a later event-loop tick and would otherwise clobber the just-made change.
 */
function renderGrid(container: HTMLElement, gameClient: GameClient, prefs: NotificationPreferences, disabledReasons: DisabledReasons): void {
  const send = () => gameClient.sendSetNotificationPreferences(prefs);

  const categories = activeCategories();

  container.innerHTML = `
    <div class="notif-prefs-toolbar">
      <button class="notif-prefs-bulk-btn" data-bulk="enable">Enable all</button>
      <button class="notif-prefs-bulk-btn" data-bulk="disable">Disable all</button>
    </div>
    <div class="notif-prefs-status" style="display:none"></div>
    <table class="notif-prefs-grid">
      <thead>
        <tr>
          <th></th>
          ${ALL_NOTIFICATION_CHANNELS.map(ch => `
            <th>
              <div class="notif-prefs-col-head">
                <span>${CHANNEL_LABELS[ch]}</span>
                ${disabledReasons[ch] ? `<span class="notif-prefs-col-note">${disabledReasons[ch]}</span>` : ''}
                <label class="notif-prefs-master">
                  <input type="checkbox" data-master-channel="${ch}" ${!disabledReasons[ch] && !prefs.channelDisabled[ch] ? 'checked' : ''}
                    ${disabledReasons[ch] ? 'disabled' : ''} />
                </label>
              </div>
            </th>
          `).join('')}
        </tr>
      </thead>
      ${categories.map(cat => `
        <tbody>
          <tr class="notif-prefs-cat-row"><td colspan="${ALL_NOTIFICATION_CHANNELS.length + 1}">${cat.label}</td></tr>
          ${NOTIFICATION_EVENT_REGISTRY.filter(e => e.category === cat.category).map(evt => `
            <tr>
              <td class="notif-prefs-event-label">${evt.label}</td>
              ${ALL_NOTIFICATION_CHANNELS.map(ch => `
                <td>
                  <input type="checkbox" data-event="${evt.eventKey}" data-channel="${ch}"
                    ${!disabledReasons[ch] && prefs.events[evt.eventKey].includes(ch) ? 'checked' : ''}
                    ${disabledReasons[ch] ? 'disabled' : ''} />
                </td>
              `).join('')}
            </tr>
          `).join('')}
        </tbody>
      `).join('')}
    </table>
  `;

  const statusEl = container.querySelector('.notif-prefs-status') as HTMLElement;
  const showStatus = (text: string) => {
    statusEl.textContent = text;
    statusEl.style.display = '';
  };

  // Per-event checkboxes
  container.querySelectorAll<HTMLInputElement>('input[data-event]').forEach((box) => {
    box.addEventListener('change', async () => {
      const eventKey = box.dataset.event!;
      const channel = box.dataset.channel as NotificationChannel;

      if (channel === 'browser_push' && box.checked && getPushPermission() !== 'granted') {
        box.disabled = true;
        const result = await subscribeToPush(gameClient);
        box.disabled = false;
        if (!result.success) {
          box.checked = false;
          showStatus(result.error ?? 'Could not enable push notifications');
          return;
        }
      }

      const list = new Set(prefs.events[eventKey]);
      if (box.checked) list.add(channel); else list.delete(channel);
      prefs.events[eventKey] = Array.from(list);
      syncChannelDisabled(prefs, channel);
      send();

      // Keep that channel's master checkbox in sync without a full re-render.
      const masterBox = container.querySelector<HTMLInputElement>(`input[data-master-channel="${channel}"]`);
      if (masterBox) masterBox.checked = !prefs.channelDisabled[channel];
    });
  });

  // Per-channel "select all" checkbox — checked whenever any event still uses this channel.
  container.querySelectorAll<HTMLInputElement>('input[data-master-channel]').forEach((box) => {
    box.addEventListener('change', async () => {
      const channel = box.dataset.masterChannel as NotificationChannel;

      if (!box.checked) {
        // Unchecking clears the channel from every event — confirm before doing something that broad.
        if (!window.confirm(`Turn off ${CHANNEL_LABELS[channel]} for every notification type?`)) {
          box.checked = true;
          return;
        }
      }

      if (channel === 'browser_push' && box.checked && getPushPermission() !== 'granted') {
        box.disabled = true;
        const result = await subscribeToPush(gameClient);
        box.disabled = false;
        if (!result.success) {
          box.checked = false;
          showStatus(result.error ?? 'Could not enable push notifications');
          return;
        }
      }
      if (channel === 'browser_push' && !box.checked) {
        await unsubscribeFromPush(gameClient);
      }

      for (const def of NOTIFICATION_EVENT_REGISTRY) {
        const list = new Set(prefs.events[def.eventKey]);
        if (box.checked) list.add(channel); else list.delete(channel);
        prefs.events[def.eventKey] = Array.from(list);
      }
      syncChannelDisabled(prefs, channel);
      send();
      renderGrid(container, gameClient, prefs, disabledReasons);
    });
  });

  // Bulk enable/disable
  container.querySelectorAll<HTMLButtonElement>('.notif-prefs-bulk-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const enable = btn.dataset.bulk === 'enable';
      // Enabling never turns on a channel the player can't actually use.
      const enableChannels = ALL_NOTIFICATION_CHANNELS.filter(ch => !disabledReasons[ch]);
      for (const def of NOTIFICATION_EVENT_REGISTRY) {
        prefs.events[def.eventKey] = enable ? [...enableChannels] : [];
      }
      for (const ch of ALL_NOTIFICATION_CHANNELS) syncChannelDisabled(prefs, ch);
      send();
      renderGrid(container, gameClient, prefs, disabledReasons);
    });
  });
}
