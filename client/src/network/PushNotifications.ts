import type { GameClient } from './GameClient';

/** Registers the service worker (app shell caching + Web Push). No-op in dev — a stale SW is worse than none. */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return;

  try {
    await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('[PushNotifications] Service worker registration failed:', err);
  }
}

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export function getPushPermission(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64Safe);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/** Requests permission (if needed), subscribes via the SW's PushManager, and registers with the server. */
export async function subscribeToPush(gameClient: GameClient): Promise<{ success: boolean; error?: string }> {
  if (!isPushSupported()) return { success: false, error: 'Push is not supported in this browser' };

  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') return { success: false, error: 'Notification permission was not granted' };

  const keyRes = await fetch('/api/notifications/vapid-public-key', { credentials: 'include' });
  const { publicKey } = await keyRes.json() as { publicKey: string | null };
  if (!publicKey) return { success: false, error: 'Push is not configured on this server' };

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });

  gameClient.sendRegisterPushSubscription(subscription.toJSON() as {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  });
  return { success: true };
}

export async function unsubscribeFromPush(gameClient: GameClient): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  gameClient.sendUnregisterPushSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}
