import {
  NOTIFICATION_EVENT_REGISTRY,
  NOTIFICATION_CATEGORY_META,
  ALL_NOTIFICATION_CHANNELS,
} from '@idle-party-rpg/shared';
import type { NotificationChannel, NotificationPreferences } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { subscribeToPush, unsubscribeFromPush, getPushPermission } from '../network/PushNotifications';

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

export function renderNotificationPreferences(container: HTMLElement, gameClient: GameClient): void {
  let prefs = resolvePreferences(gameClient.lastState?.social?.notificationPreferences);

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
                <label class="notif-prefs-master">
                  <input type="checkbox" data-master-channel="${ch}" ${prefs.channelDisabled[ch] ? '' : 'checked'} />
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
                    ${prefs.events[evt.eventKey].includes(ch) ? 'checked' : ''} />
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
      send();
    });
  });

  // Per-channel master kill switch
  container.querySelectorAll<HTMLInputElement>('input[data-master-channel]').forEach((box) => {
    box.addEventListener('change', async () => {
      const channel = box.dataset.masterChannel as NotificationChannel;

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

      prefs.channelDisabled[channel] = !box.checked;
      send();
    });
  });

  // Bulk enable/disable
  container.querySelectorAll<HTMLButtonElement>('.notif-prefs-bulk-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const enable = btn.dataset.bulk === 'enable';
      for (const def of NOTIFICATION_EVENT_REGISTRY) {
        prefs.events[def.eventKey] = enable ? [...ALL_NOTIFICATION_CHANNELS] : [];
      }
      send();
      renderNotificationPreferences(container, gameClient);
    });
  });
}
