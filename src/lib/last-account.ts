import { getLocalStore } from "@/lib/auth-storage";

/**
 * The account this browser last signed in with.
 *
 * A session is what actually keeps someone signed in (see
 * `src/lib/auth-storage.ts`); this is the small memory that goes with it, so a
 * returning visitor is recognised even when the session is not there any more
 * — after signing out, after the session expires, or on a browser that cleared
 * its tokens. The sign-in card opens on "Sign in" with the name already
 * filled in, which is the difference between "I'm still me here" and "who are
 * you?".
 *
 * It shares the store the session itself uses, so it lives exactly as long as
 * a signed-in session would: this browser's local storage when that works,
 * this tab when only session storage does, and memory when neither is usable.
 */

const KEY = "natyavault.last-account.v1";

export interface LastAccount {
  /** The name as it was typed at sign-up (what the sign-in field expects). */
  username: string;
  /** When this account was last used here, epoch ms. */
  at: number;
}

/** Record `username` as the account most recently used in this browser. */
export function rememberAccount(username: string): void {
  const trimmed = username.trim();
  if (!trimmed) return;
  const entry: LastAccount = { username: trimmed, at: Date.now() };
  try {
    getLocalStore().setItem(KEY, JSON.stringify(entry));
  } catch {
    // Storage refused the write — the memory just won't persist.
  }
}

/** The account last used in this browser, or null when there is none. */
export function getLastAccount(): LastAccount | null {
  try {
    const raw = getLocalStore().getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastAccount>;
    if (typeof parsed.username !== "string" || !parsed.username.trim()) {
      return null;
    }
    return {
      username: parsed.username,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return null;
  }
}

/** Forget the remembered account — "sign in as someone else". */
export function forgetAccount(): void {
  try {
    getLocalStore().removeItem(KEY);
  } catch {
    // Nothing to clear.
  }
}
