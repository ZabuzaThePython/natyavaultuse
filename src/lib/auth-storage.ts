import type { TokenStorage } from "@convex-dev/auth/react";

/**
 * Where Convex Auth keeps a signed-in session.
 *
 * The library's default is `window.localStorage`, which is what we want: a
 * session that is still there tomorrow, not just in this tab. Two edges of the
 * default are worth handling, though — reading `window.localStorage` throws in a
 * sandboxed iframe or with storage switched off, and storage that exists but
 * cannot be written (full quota, old private mode) fails on every token write.
 * Either one lands the user back on the sign-in card.
 *
 * So the provider gets a store we have actually probed: persistent local storage
 * when it works, the tab's session storage when only that works, and an
 * in-memory store when neither does — no crash, and the session survives a
 * reload in every case but the last.
 *
 * The store chosen here is also where the app keeps its own small memories —
 * which account this browser last signed in with (see src/lib/last-account.ts)
 * — so those live exactly as long as a session would.
 */

/** The three calls the app needs from a web storage (sync, unlike TokenStorage). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function probe(store: Storage): boolean {
  try {
    const key = "natyavault.storage-probe";
    store.setItem(key, "1");
    const writable = store.getItem(key) === "1";
    store.removeItem(key);
    return writable;
  } catch {
    return false;
  }
}

function inMemory(): KeyValueStore {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

function pick(): KeyValueStore {
  if (typeof window === "undefined") return inMemory();
  // Read each storage inside the try: the property access itself throws when
  // storage is disabled, and building the list outside would let that escape.
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const candidate = window[name];
      if (candidate && probe(candidate)) return candidate;
    } catch {
      // Browser refuses to hand over this storage — try the next one.
    }
  }
  return inMemory();
}

let cached: KeyValueStore | null = null;

/**
 * This browser's most durable working storage, probed once and then reused.
 * Persistent local storage when it works, the tab's session storage when only
 * that does, and memory when neither can be written.
 */
export function getLocalStore(): KeyValueStore {
  cached ??= pick();
  return cached;
}

/** Storage for `ConvexAuthProvider`, probed once and then reused. */
export function getAuthStorage(): TokenStorage {
  return getLocalStore();
}
