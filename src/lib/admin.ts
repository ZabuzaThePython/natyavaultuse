import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { useSyncExternalStore } from "react";

/**
 * Whether the admin credentials have been entered on this browser.
 *
 * The flag lives in localStorage, so closing NatyaVault — the tab, the phone
 * app, the browser itself — no longer locks the admin out; the Admin area
 * stays unlocked until the admin signs out. (It used to live in
 * sessionStorage, which a full restart clears, so privileges came and went.)
 *
 * The credentials are re-sent to the server for every admin call
 * (list/delete accounts, feature switches); they are only ever checked by
 * Convex functions, never shipped to the client bundle.
 */
const KEY = "natyavault.admin.v1";
const CREDS_KEY = "natyavault.admin.creds.v1";

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return (
      localStorage.getItem(KEY) === "1" &&
      localStorage.getItem(CREDS_KEY) !== null
    );
  } catch {
    return false;
  }
}

let current = read();

function emit() {
  listeners.forEach((l) => l());
}

/** Non-reactive read (for event handlers). */
export function getIsAdmin(): boolean {
  return current;
}

/** Mark the admin area as unlocked on this browser. */
export function unlockAdmin(username: string, password: string) {
  try {
    localStorage.setItem(KEY, "1");
    localStorage.setItem(
      CREDS_KEY,
      JSON.stringify({ username, password }),
    );
  } catch {
    // Storage unavailable — the flag just won't persist.
  }
  current = true;
  emit();
}

/** The stored admin credentials, or null when the admin area is locked. */
export function getAdminCreds(): { username: string; password: string } | null {
  try {
    // Read from storage rather than the in-memory flag: this is what every
    // admin call re-verifies with, including one made after a restart.
    const raw = localStorage.getItem(CREDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { username?: unknown; password?: unknown };
    if (typeof parsed.username !== "string" || typeof parsed.password !== "string") {
      return null;
    }
    return { username: parsed.username, password: parsed.password };
  } catch {
    return null;
  }
}

/** Lock the admin area again (also clears the stored credentials). */
export function lockAdmin() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(CREDS_KEY);
    // Clear the old session-scoped flag too, so a device that unlocked the
    // admin area before this moved stores nothing stale.
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(CREDS_KEY);
  } catch {
    // ignore
  }
  current = false;
  emit();
}

/** The unlock kept in this browser (false once storage forgets it). */
function useStoredUnlock(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      listeners.add(onStoreChange);
      return () => listeners.delete(onStoreChange);
    },
    () => current,
    () => false,
  );
}

/**
 * Reactive admin access: the unlock stored in this browser, or the grant the
 * deployment holds for this account.
 *
 * The server half is what makes admin access reliable. A stored unlock can
 * disappear for reasons outside the app's control — browser storage evicted,
 * filled to the quota by vault media, a fresh install, another device — which
 * looked like admin powers being taken away at random. `hasAdminAccess` is
 * true for the admin account itself and for any account whose credentials were
 * accepted in the last 90 days, so a reload or a new phone cannot lose it.
 */
export function useIsAdmin(): boolean {
  const stored = useStoredUnlock();
  const serverAdmin = useQuery(api.admin.hasAdminAccess) === true;
  return stored || serverAdmin;
}

/** Admin access, plus whether the server's answer is still on its way. */
export function useAdminAccess(): { isAdmin: boolean; loading: boolean } {
  const stored = useStoredUnlock();
  const serverAdmin = useQuery(api.admin.hasAdminAccess);
  return {
    isAdmin: stored || serverAdmin === true,
    // Only a wait when the browser has nothing stored: with a stored unlock
    // there is nothing to wait for.
    loading: !stored && serverAdmin === undefined,
  };
}
