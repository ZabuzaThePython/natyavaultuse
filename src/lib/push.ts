/**
 * Web Push helpers.
 *
 * The browser owns the subscription; the deployment only stores its endpoint
 * and keys (convex/push.ts). Nothing here asks for permission — browsers
 * require that to happen straight from a tap, so the component calls
 * `Notification.requestPermission()` in its click handler before this is used.
 */

export const INSTALL_FINISHED_EVENT = "natyavault:install-finished";

const PROMPT_KEY = "natyavault.notificationsPrompt.v1";

/** Can this browser receive web push at all? */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

/** Register the notification service worker (idempotent). */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      scope: "/",
    });
    await navigator.serviceWorker.ready;
    return registration;
  } catch (error) {
    console.error("Service worker registration failed:", error);
    return null;
  }
}

/** The VAPID key is base64url; PushManager wants the raw bytes. */
export function urlBase64ToUint8Array(
  base64String: string,
): Uint8Array<ArrayBuffer> {
  const padded = `${base64String}${"=".repeat((4 - (base64String.length % 4)) % 4)}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = atob(padded);
  // Backed by a plain ArrayBuffer so it can be used as an applicationServerKey.
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export interface DeviceSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Subscribe this browser and hand back what the deployment should store.
 * Reuses an existing subscription when there is one, so turning notifications
 * back on does not create a second device entry.
 */
export async function subscribeThisDevice(
  publicKey: string,
): Promise<DeviceSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await registerServiceWorker();
  if (!registration) return null;

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) return null;
  return { endpoint: subscription.endpoint, keys: { p256dh, auth } };
}

/** This browser's current subscription endpoint, if it has one. */
export async function currentEndpoint(): Promise<string | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const registration =
      (await navigator.serviceWorker.getRegistration()) ??
      (await registerServiceWorker());
    const subscription = await registration?.pushManager.getSubscription();
    return subscription?.endpoint ?? null;
  } catch {
    return null;
  }
}

/** Unsubscribe this browser and return the endpoint that should be forgotten. */
export async function unsubscribeThisDevice(): Promise<string | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return null;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    return endpoint;
  } catch {
    return null;
  }
}

/** True while this browser can still be asked to turn notifications on. */
export function notificationsPromptDue(): boolean {
  if (!pushSupported()) return false;
  if (notificationPermission() !== "default") return false;
  try {
    return localStorage.getItem(PROMPT_KEY) !== "seen";
  } catch {
    return false;
  }
}

const ZONE_KEY = "natyavault.pushTimeZone.v1";

/**
 * This device's IANA time zone (e.g. "Asia/Kolkata"), as the browser reports
 * it. Sent with the subscription so the monthly fee reminder can arrive at 9am
 * where the student actually is. Null when the browser cannot say.
 */
export function currentTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === "string" && zone.length > 0 && zone.length <= 64
      ? zone
      : null;
  } catch {
    return null;
  }
}

/** The zone this device last saved, so a trip re-syncs it exactly once. */
export function lastSyncedTimeZone(): string | null {
  try {
    return localStorage.getItem(ZONE_KEY);
  } catch {
    return null;
  }
}

export function markTimeZoneSynced(zone: string) {
  try {
    localStorage.setItem(ZONE_KEY, zone);
  } catch {
    // Private mode — the saved zone simply stays as it was.
  }
}

/** Remember that the prompt was shown, so it does not keep reappearing. */
export function markNotificationsPromptSeen() {
  try {
    localStorage.setItem(PROMPT_KEY, "seen");
  } catch {
    // Private mode — the prompt is a nicety, never fatal.
  }
}

/**
 * Tell the app the "Add to Home Screen" steps are finished (dismissed or
 * actually installed), so the notifications reminder can follow.
 */
export function announceInstallFinished() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(INSTALL_FINISHED_EVENT));
}
