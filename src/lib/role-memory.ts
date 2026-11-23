/**
 * What the deployment last said about an account's place in the app, and the
 * rule for remembering it.
 *
 * Kept apart from the hooks so the promise the shell makes — "once this account
 * has been confirmed as the operator, the menu and the studio picker never drop
 * back to a student view" — is one small function that can be reasoned about (and
 * tested) on its own.
 *
 * Two kinds of memory are used, because either one alone has failed:
 *
 * - this page session, held in a module-level map, which survives the query
 *   going quiet but not a reload;
 * - browser storage, written to both `localStorage` and `sessionStorage`
 *   independently, because the vault's media can fill one to quota and a write
 *   that fails there must not take the role with it.
 */

export interface CachedRole {
  staff: boolean;
  /** The operator account: sees every studio, opens the studio controls. */
  admin: boolean;
}

/** A storage a role can be written to (`localStorage`, `sessionStorage`). */
export interface RoleStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** One row per account, so a shared studio device never shares a role. */
export const ROLE_KEY = "natyavault.roles.v1";

/**
 * The account the app treats as the operator, for UI purposes only. The
 * deployment decides every permission; this is the signed-in session's own
 * account id, and it exists so a quiet role query cannot hide the studio
 * picker from the person who owns the account.
 */
const OPERATOR_ACCOUNT = "admin";

/** The role confirmed during this page session, before any storage is read. */
const session = new Map<string, CachedRole>();

/** The key one account's memories live under. */
export function roleKey(account: string | undefined): string {
  return (account ?? "#session").toLowerCase();
}

/**
 * Whether this session is signed in as the operator account.
 *
 * Only the account id is used — never the display name, which anybody can set
 * to "Admin" (the deployment ignores it for exactly that reason too).
 */
export function isOperatorAccount(accountId: string | undefined | null): boolean {
  if (typeof accountId !== "string") return false;
  return accountId.trim().toLowerCase() === OPERATOR_ACCOUNT;
}

/**
 * Merge a fresh answer with what is already known for this account.
 *
 * A yes is never undone by a later answer: signing out is the only thing that
 * clears it (see `forgetRoles`). A quiet or unauthenticated answer — what a
 * dropped socket, a token mid-refresh or a deploy landing mid-flight looks
 * like — leaves the last confirmed role alone instead of demoting the operator
 * to a student. The deployment still authorises every call, so this is only
 * about which controls the shell shows.
 */
export function mergeRole(
  previous: CachedRole | null,
  confirmed: CachedRole | null,
): CachedRole | null {
  if (confirmed === null) return previous;
  if (previous === null) return confirmed;
  return {
    staff: previous.staff || confirmed.staff,
    admin: previous.admin || confirmed.admin,
  };
}

/** Remember a role for the rest of this page session. */
export function rememberRole(key: string, role: CachedRole): void {
  session.set(key, mergeRole(session.get(key) ?? null, role) ?? role);
}

/** The role remembered for this page session, if any. */
export function rememberedRole(key: string): CachedRole | null {
  return session.get(key) ?? null;
}

/** Forget every remembered role (sign-out). */
export function forgetRoles(): void {
  session.clear();
}

/** The browser's storages, whichever of them are usable. */
export function browserRoleStores(): RoleStore[] {
  const stores: RoleStore[] = [];
  if (typeof window === "undefined") return stores;
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const candidate = window[name];
      if (candidate) stores.push(candidate);
    } catch {
      // The property itself throws when storage is switched off — skip it.
    }
  }
  return stores;
}

function parseMap(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseEntry(raw: string | null, key: string): CachedRole | null {
  const parsed = parseMap(raw);
  if (parsed === null) return null;
  const entry = parsed[key];
  // Entries written before the admin flag existed are a bare boolean: they
  // still mean "staff", they just know nothing about the operator.
  if (typeof entry === "boolean") return { staff: entry, admin: false };
  if (entry && typeof entry === "object") {
    const value = entry as { staff?: unknown; admin?: unknown };
    if (typeof value.staff === "boolean") {
      return { staff: value.staff, admin: value.admin === true };
    }
  }
  return null;
}

/** A remembered role, from whichever store still has one. */
export function readStoredRole(
  key: string,
  stores: RoleStore[],
): CachedRole | null {
  for (const store of stores) {
    try {
      const role = parseEntry(store.getItem(ROLE_KEY), key);
      if (role !== null) return role;
    } catch {
      // This store refused a read — try the next one.
    }
  }
  return null;
}

/**
 * Write a role into every usable store, merging with what is already there so
 * a store that missed the last write catches up rather than resetting the
 * account to a student.
 */
export function writeStoredRole(
  key: string,
  role: CachedRole,
  stores: RoleStore[],
): void {
  for (const store of stores) {
    try {
      const raw = store.getItem(ROLE_KEY);
      const map = parseMap(raw) ?? {};
      map[key] = mergeRole(parseEntry(raw, key), role);
      store.setItem(ROLE_KEY, JSON.stringify(map));
    } catch {
      // Storage refused the write — the other store, or the session memory,
      // still holds the answer.
    }
  }
}
