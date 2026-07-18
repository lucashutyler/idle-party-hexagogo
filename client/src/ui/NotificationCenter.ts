import type { GameClient } from '../network/GameClient';
import type { NotificationEntry } from '@idle-party-rpg/shared';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';

const TOAST_LIFETIME_MS = 6000;

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/**
 * Global notification bell + dropdown inbox + live toast stack. Mounted once
 * outside #app (like ChatPopout) so it survives screen switches.
 */
export class NotificationCenter {
  private root: HTMLElement;
  private bellButton: HTMLButtonElement;
  private toastStack: HTMLElement;
  private dropdown: HTMLElement | null = null;
  private notifications: NotificationEntry[] = [];

  constructor(private gameClient: GameClient) {
    this.root = document.getElementById('notification-center-root')!;

    this.bellButton = document.createElement('button');
    this.bellButton.className = 'notif-bell-btn';
    this.bellButton.setAttribute('aria-label', 'Notifications');
    this.bellButton.innerHTML = `
      <span class="notif-bell-icon">🔔</span>
      <span class="notif-bell-badge"></span>
    `;
    this.bellButton.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleDropdown();
    });
    this.root.appendChild(this.bellButton);

    this.toastStack = document.createElement('div');
    this.toastStack.className = 'notif-toast-stack';
    this.root.appendChild(this.toastStack);

    document.addEventListener('click', () => this.closeDropdown());

    this.gameClient.subscribe((state) => {
      this.notifications = state.social?.notifications ?? [];
      this.updateBadge();
      if (this.dropdown) this.renderDropdownList();
    });

    this.gameClient.onNotification((notification) => {
      this.showToast(notification);
    });
  }

  private unreadCount(): number {
    return this.notifications.filter(n => n.readAt === null).length;
  }

  private updateBadge(): void {
    const badge = this.bellButton.querySelector('.notif-bell-badge') as HTMLElement;
    const count = this.unreadCount();
    badge.textContent = count > 9 ? '9+' : String(count);
    badge.classList.toggle('visible', count > 0);
  }

  private toggleDropdown(): void {
    if (this.dropdown) {
      this.closeDropdown();
    } else {
      this.openDropdown();
    }
  }

  private openDropdown(): void {
    if (this.dropdown) return;

    const panel = document.createElement('div');
    panel.className = 'notif-dropdown';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML = `
      <div class="notif-dropdown-header">
        <span class="notif-dropdown-title">Notifications</span>
        <button class="notif-mark-all-btn">Mark all read</button>
      </div>
      <div class="notif-dropdown-list"></div>
    `;

    panel.querySelector('.notif-mark-all-btn')!.addEventListener('click', () => {
      this.gameClient.sendMarkAllNotificationsRead();
    });

    document.body.appendChild(panel);
    this.dropdown = panel;
    this.renderDropdownList();

    requestAnimationFrame(() => {
      const btnRect = this.bellButton.getBoundingClientRect();
      const panelRect = panel.getBoundingClientRect();
      const margin = 8;
      let left = btnRect.right - panelRect.width;
      left = Math.max(margin, Math.min(window.innerWidth - panelRect.width - margin, left));
      panel.style.left = `${left}px`;
      panel.style.top = `${btnRect.bottom + 6}px`;
      panel.classList.add('notif-dropdown-shown');
    });

    bringToFront(panel);
    wireFocusOnInteract(panel);
  }

  private closeDropdown(): void {
    if (!this.dropdown) return;
    release(this.dropdown);
    this.dropdown.remove();
    this.dropdown = null;
  }

  private renderDropdownList(): void {
    if (!this.dropdown) return;
    const list = this.dropdown.querySelector('.notif-dropdown-list') as HTMLElement;

    if (this.notifications.length === 0) {
      list.innerHTML = '<div class="notif-empty">No notifications yet.</div>';
      return;
    }

    const sorted = [...this.notifications].sort((a, b) => b.createdAt - a.createdAt);
    list.innerHTML = sorted.map(n => `
      <button class="notif-row${n.readAt === null ? ' notif-row-unread' : ''}" data-id="${n.id}">
        <span class="notif-row-dot"></span>
        <span class="notif-row-body">
          <span class="notif-row-title">${escapeHtml(n.title)}</span>
          <span class="notif-row-text">${escapeHtml(n.body)}</span>
          <span class="notif-row-time">${relativeTime(n.createdAt)}</span>
        </span>
      </button>
    `).join('');

    list.querySelectorAll<HTMLButtonElement>('.notif-row').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id!;
        this.gameClient.sendMarkNotificationRead(id);
      });
    });
  }

  private showToast(notification: NotificationEntry): void {
    const toast = document.createElement('div');
    toast.className = 'notif-toast';
    toast.innerHTML = `
      <span class="notif-toast-title">${escapeHtml(notification.title)}</span>
      <span class="notif-toast-text">${escapeHtml(notification.body)}</span>
    `;
    toast.addEventListener('click', () => {
      this.gameClient.sendMarkNotificationRead(notification.id);
      dismiss();
    });

    const dismiss = () => {
      toast.classList.add('notif-toast-leaving');
      setTimeout(() => toast.remove(), 300);
    };

    this.toastStack.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('notif-toast-shown'));
    setTimeout(dismiss, TOAST_LIFETIME_MS);
  }
}
