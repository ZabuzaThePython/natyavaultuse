import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { getLocalStore } from "@/lib/auth-storage";
import { useViewerIsStaff } from "@/lib/classes";
import { getLastAccount } from "@/lib/last-account";
import { useMutation, useQuery } from "convex/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

/**
 * Whether the admin credentials have been entered on this browser.
 *
 * The flag lives in the same store the session does (see lib/auth-storage.ts),
 * so closing NatyaVault — the tab, the phone app, the browser itself — no
 * longer locks the admin out; the Admin area stays unlocked until the admin
 * signs out. Raw `localStorage` used to be assumed here, which silently failed
 * once the vault's media had filled the quota.
 *
 * The credentials are re-sent to the server for every admin call
 * (list/delete accounts, feature switches); they are only ever checked by
 * Convex functions, never shipped to the client bundle.
 */
const KEY = "natyavault.admin.v1";
const CREDS_KEY = "natyavault.admin.creds.v1";
/** Per account, when the deployment last confirmed admin access. */
const GRANT_KEY = "natyavault.admin.grant.v1";
/** How long a confirmed answer is trusted — the server's grant lasts the same. */
const GRANT_TTL = 90 * 24 * 60 * 60 * 1000;

interface AdminCreds {
  username: string;
  password: string;
  /** The account that unlocked it, when the entry records one. */
  account: string | null;
}

const listeners = new Set<() => void>();

/**
 * The unlock as this page holds it, independent of storage.
 *
 * Browser storage is not a reliable place for it: the vault's media shares the
 * same quota, so once that fills every write fails silently and nothing about
 * the unlock survives. Keeping the pair in memory means the deployment can
 * still be told "this browser unlocked with these" for the rest of the visit
 * even when nothing could be written.
 */
let memoryCreds: AdminCreds | null = null;

/**
 * Accounts the deployment said "admin" about during this page session.
 *
 * A subscription can go quiet — a deploy lands mid-flight, a dropped socket
 * while the tab sleeps — and when the Admin page mounts again it starts a new
 * one. The only other memory used to be browser storage, which is exactly what
 * fails here; remembering the answer in memory is what stops the gate from
 * asking for the password again every time the page is opened. Cleared on
 * sign-out.
 */
const sessionConfirmed = new Set<string>();

function accountKey(account: string | undefined): string {
  return (account ?? "#session").toLowerCase();
}

function read(): boolean {
  if (memoryCreds !== null) return true;
  try {
    const store = getLocalStore();
    return (
      store.getItem(KEY) === "1" && store.getItem(CREDS_KEY) !== null
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
  // The account that unlocked it, so a later repair of the server grant is
  // only ever made for the same person — never a classmate who signs in next
  // on a shared studio device.
  const account = getLastAccount()?.username?.toLowerCase() ?? null;
  memoryCreds = { username, password, account };
  try {
    getLocalStore().setItem(KEY, "1");
    getLocalStore().setItem(
      CREDS_KEY,
      JSON.stringify({ username, password, account }),
    );
  } catch {
    // Storage unavailable — the flag just won't persist past this page.
  }
  current = true;
  emit();
}

/** The stored admin credentials, or null when the admin area is locked. */
export function getAdminCreds(): {
  username: string;
  password: string;
  /** The account that unlocked it, when the entry records one. */
  account: string | null;
} | null {
  // The copy this page holds first: it is what was typed, whether or not the
  // browser let it be written down.
  if (memoryCreds !== null) return memoryCreds;
  try {
    const raw = getLocalStore().getItem(CREDS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      username?: unknown;
      password?: unknown;
      account?: unknown;
    };
    if (
      typeof parsed.username !== "string" ||
      typeof parsed.password !== "string"
    ) {
      return null;
    }
    return {
      username: parsed.username,
      password: parsed.password,
      account: typeof parsed.account === "string" ? parsed.account : null,
    };
  } catch {
    return null;
  }
}

/** Lock the admin area again (also clears the stored credentials). */
export function lockAdmin() {
  try {
    const store = getLocalStore();
    store.removeItem(KEY);
    store.removeItem(CREDS_KEY);
    // Clear the old session-scoped flag too, so a device that unlocked the
    // admin area before this moved stores nothing stale.
    sessionStorage.removeItem(KEY);
    sessionStorage.removeItem(CREDS_KEY);
  } catch {
    // ignore
  }
  memoryCreds = null;
  sessionConfirmed.clear();
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

/** Whether this account was confirmed an admin lately, from a past visit. */
function readGrant(account: string | undefined): boolean {
  if (!account) return false;
  try {
    const raw = getLocalStore().getItem(GRANT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const at = parsed[account];
    return typeof at === "number" && Date.now() - at < GRANT_TTL;
  } catch {
    return false;
  }
}

function writeGrant(account: string | undefined) {
  if (!account) return;
  try {
    const raw = getLocalStore().getItem(GRANT_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = parsed && typeof parsed === "object" ? parsed : {};
    next[account] = Date.now();
    getLocalStore().setItem(GRANT_KEY, JSON.stringify(next));
  } catch {
    // Storage refused the write — the grant simply won't be remembered here.
  }
}

/**
 * Reactive admin access: the unlock stored in this browser, the grant the
 * deployment holds for this account, or one it confirmed recently.
 *
 * The server half is what makes admin access reliable. A stored unlock can
 * disappear for reasons outside the app's control — browser storage evicted,
 * filled to the quota by vault media, a fresh install, another device — which
 * looked like admin powers being taken away at random. `hasAdminAccess` is
 * true for the admin account itself and for any account whose credentials were
 * accepted in the last 90 days, so a reload or a new phone cannot lose it.
 *
 * The answer is remembered per account (the same way the viewer's role is, see
 * lib/classes.ts), because this query can go quiet: a deploy landing mid-flight
 * or a socket that dropped while the tab slept left it unanswered for the rest
 * of the visit. That is what made the admin badge and the Admin area disappear
 * after leaving the dashboard and coming back. It is asked again instead, and a
 * confirmed yes stands in until the next answer arrives.
 */
export function useAdminAccess(): { isAdmin: boolean; loading: boolean } {
  const stored = useStoredUnlock();
  const { user } = useAuth();
  // The deployment's own answer about who this account is. This is the one
  // signal that never touches this browser's storage: if the signed-in account
  // is the admin — or holds an unexpired admin grant on the deployment — the
  // Admin area stays open on every device, even after a cleared browser.
  const { isPlatformAdmin } = useViewerIsStaff();

  // Who this answer belongs to: the sign-in name when the session is loaded,
  // otherwise the account this browser last used — never nobody, so a waking
  // tab keeps the grant it already had.
  const account = (
    user?.email ??
    user?.name ??
    getLastAccount()?.username
  )?.toLowerCase();

  // Bumping the argument re-subscribes. A handful of tries is enough.
  const [retry, setRetry] = useState(0);
  // The credentials this browser unlocked with are sent along, so the
  // deployment confirms admin access directly instead of relying only on the
  // grant row (which a lost or failed claim can leave missing). They are the
  // same pair the gate itself verifies.
  const creds = getAdminCreds();
  const serverAdmin = useQuery(api.admin.hasAdminAccess, {
    ...(retry > 0 ? { retry } : {}),
    ...(creds ? { username: creds.username, password: creds.password } : {}),
  });

  const confirmed = serverAdmin === true;
  const cached = useMemo(() => readGrant(account), [account]);
  // A yes already heard in this visit: the query can go quiet, and the Admin
  // page mounts a fresh subscription every time it is opened. Remembering the
  // answer here — not in browser storage, which is what fills up — is what
  // stops the gate asking for the password again on the way back.
  const sticky = sessionConfirmed.has(accountKey(account));
  const isAdmin =
    stored || confirmed || cached || isPlatformAdmin || sticky;

  useEffect(() => {
    if (!confirmed) return;
    sessionConfirmed.add(accountKey(account));
  }, [confirmed, account]);

  useEffect(() => {
    if (serverAdmin !== undefined || retry >= 5 || isAdmin) return;
    const timer = setTimeout(() => setRetry((tries) => tries + 1), 1500);
    return () => clearTimeout(timer);
  }, [serverAdmin, retry, isAdmin]);

  // Only a yes is remembered. A "no" can mean "not signed in yet", and must
  // never wipe a grant this account already holds. The operator's own answer
  // counts too, so a slow or silent query after a reload cannot close a door
  // the deployment has already opened.
  useEffect(() => {
    if (confirmed || isPlatformAdmin) writeGrant(account);
  }, [confirmed, isPlatformAdmin, account]);

  // The browser still holds the admin credentials, but the deployment no
  // longer remembers the grant (it lapsed, or the call that granted it was
  // lost). Claim it again for the account that unlocked it — and only that
  // account, so a student on the same device cannot inherit it.
  const claim = useMutation(api.admin.claimAdminAccess);
  const repaired = useRef(false);
  useEffect(() => {
    if (repaired.current || !stored || serverAdmin !== false) return;
    const creds = getAdminCreds();
    if (!creds || creds.account === null) return;
    const identity = [user?.email, user?.name, getLastAccount()?.username]
      .filter((name): name is string => typeof name === "string")
      .map((name) => name.toLowerCase());
    if (!identity.includes(creds.account)) return;
    repaired.current = true;
    void claim({ username: creds.username, password: creds.password }).catch(
      (error) => {
        console.error("Could not restore the admin grant:", error);
      },
    );
  }, [stored, serverAdmin, account, claim, user?.email, user?.name]);

  return {
    isAdmin,
    // Only a wait while an answer is plausibly still on its way.
    loading: !isAdmin && serverAdmin === undefined && retry < 5,
  };
}

/** Reactive admin access, for the badge, the nav and the tour. */
export function useIsAdmin(): boolean {
  return useAdminAccess().isAdmin;
}
