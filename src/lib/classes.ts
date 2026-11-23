/**
 * Classes, as the app sees them.
 *
 * The deployment holds the class records (see src/convex/classes.ts): a
 * teacher owns the classes they created, and a student belongs to the one
 * class they joined with its code. Which class the browser is showing lives
 * in the local vault store, because all of the content — media, folders,
 * practice entries, messages, attendance — is kept per class there. The
 * Google Drive connection is on the account, so every class shares it.
 *
 * Teachers and the admin see every class in the studio (classes.allClasses);
 * a student only ever sees the one they joined.
 */
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { getLocalStore } from "@/lib/auth-storage";
import type { AttendanceEntry } from "@/lib/vault";
import { useQuery } from "convex/react";
import { getLastAccount } from "@/lib/last-account";
import { useActiveStudio } from "@/lib/studios";
import { useEffect, useMemo, useState } from "react";

export interface ClassSummary {
  code: string;
  name: string;
}

export interface ClassesState {
  /** Classes this account created (a teacher may run several). */
  owned: ClassSummary[];
  /** The class this account joined, if any. */
  joined: ClassSummary | null;
  /** Every class the account may open, owned first. */
  available: ClassSummary[];
  isLoading: boolean;
}

/** A class as the studio list shows it, with who runs it and how many joined. */
export interface ClassOverview extends ClassSummary {
  ownerName: string;
  members: number;
  /** True when the signed-in account created this class. */
  isMine: boolean;
  /**
   * True when this account may delete the class: the teacher who created it,
   * or the admin. Seeing a class in the studio list is not enough.
   */
  canDelete: boolean;
}

export interface AllClassesState {
  classes: ClassOverview[];
  /** False for students: they may not see the studio's other classes. */
  canSeeAll: boolean;
  isLoading: boolean;
}

/**
 * Every class in the studio, for teachers and the admin. A student gets
 * `canSeeAll: false` and an empty list, so they keep seeing only the class
 * they joined.
 */
export function useAllClasses(): AllClassesState {
  // The platform admin looks at one studio at a time; for a teacher the studio
  // is their own and the argument is ignored by the deployment.
  const { studioId } = useActiveStudio();
  const data = useQuery(
    api.classes.allClasses,
    studioId ? { studioId } : {},
  );
  return {
    classes: data?.classes ?? [],
    canSeeAll: data?.canSeeAll ?? false,
    isLoading: data === undefined,
  };
}

/**
 * Whether the signed-in account is staff (teacher, admin, or class owner),
 * answered by the deployment rather than by this browser's stored role.
 */
export interface ViewerRole {
  isStaff: boolean;
  /** True for the built-in admin account: the operator, across studios. */
  isPlatformAdmin: boolean;
  /** True until the deployment has answered. */
  isLoading: boolean;
  /** False when the server cannot see this browser's session at all. */
  signedIn: boolean | null;
}

/** Last role the deployment confirmed for an account, kept per account. */
const ROLE_CACHE_KEY = "natyavault.roles.v1";

/**
 * The role the deployment confirmed during this page session, per account.
 *
 * Storage is the fallback, never the only memory: the vault's media shares that
 * quota, so a full browser refuses these writes without saying so, and the
 * cached role used to vanish with the storage — taking the admin's studio
 * picker, Classes entry and Admin badge with it across the next answer gap.
 * This holds the last confirmed answer for as long as the tab is open.
 */
const sessionRoles = new Map<string, CachedRole>();

function accountKey(account: string | undefined): string {
  return (account ?? "#session").toLowerCase();
}

/** What the deployment last said about an account's place in the app. */
export interface CachedRole {
  staff: boolean;
  /** The operator account: sees every studio, opens the studio controls. */
  admin: boolean;
}

function readCachedRole(account: string | undefined): CachedRole | null {
  if (!account) return null;
  try {
    const raw = getLocalStore().getItem(ROLE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed[account];
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
  } catch {
    return null;
  }
}

function writeCachedRole(account: string | undefined, role: CachedRole) {
  if (!account) return;
  try {
    const raw = getLocalStore().getItem(ROLE_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = parsed && typeof parsed === "object" ? parsed : {};
    next[account] = { staff: role.staff, admin: role.admin };
    getLocalStore().setItem(ROLE_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Storage refused the write — the role simply won't be remembered.
  }
}

/**
 * The account's real role, per the deployment.
 *
 * The answer is remembered per account, because it used to be the whole
 * difference between the teacher view and the student view: whenever the query
 * had not arrived — a slow socket, a token that had to be refreshed, the app
 * waking up — the admin was rendered as a student until it did. A cached
 * answer keeps the layout steady across those gaps (the deployment still
 * enforces every permission), and a different account on the same browser has
 * its own entry, so a student never inherits a teacher's view.
 */
export function useViewerIsStaff(): ViewerRole {
  const { user } = useAuth();

  // A subscription that never answers is worth asking again. `viewerRole` has
  // no arguments by nature, so after a deploy landed mid-flight (or a dropped
  // socket left the subscription dead) its answer simply never arrived again —
  // the cached staff role kept the layout up, but every admin-only control,
  // which had no cache, stayed gone until the browser was signed in again.
  // Changing the argument re-subscribes. A handful of tries is enough.
  const [retry, setRetry] = useState(0);
  // Send no argument until a retry is actually wanted. The argument was added
  // with this cache-buster, so a frontend that shipped before its backend (or
  // a tab still talking to the previous deployment) would otherwise have every
  // viewerRole call rejected as an unknown field and lose the whole shell.
  const data = useQuery(
    api.classes.viewerRole,
    retry > 0 ? { retry } : {},
  );
  useEffect(() => {
    if (data !== undefined || retry >= 5) return;
    const timer = setTimeout(() => setRetry((tries) => tries + 1), 2000);
    return () => clearTimeout(timer);
  }, [data, retry]);

  // Which account the answer belongs to: the account id (the username kept in
  // `email`), not the display name, so renaming yourself keeps the memory.
  // While `currentUser` reloads — a token refresh, a waking tab — it falls back
  // to the account this browser last signed in with instead of to nobody, which
  // is what used to drop the admin to the student view until they signed in
  // again.
  const account = (
    user?.email ??
    user?.name ??
    getLastAccount()?.username
  )?.toLowerCase();

  // Only a signed-in answer counts. "Not signed in" is what a request that
  // arrives without a token says, so it must never be remembered as
  // "student": the deployment enforces every permission regardless, so keeping
  // the last confirmed role through that gap is safe and stops the flicker.
  //
  // The operator flag is remembered the same way, for the same reason: an admin
  // who lost the studio picker and the studio controls to a gap in one query
  // had to sign in again to get them back.
  const confirmedStaff = data?.signedIn === true ? data.isStaff : null;
  const confirmedAdmin = data?.signedIn === true ? data.isPlatformAdmin : null;
  const key = accountKey(account);
  // This visit's confirmed answer first, whatever was written down next.
  const remembered = sessionRoles.get(key) ?? null;
  const written = useMemo(() => readCachedRole(account), [account]);
  const cached = remembered ?? written;

  useEffect(() => {
    if (confirmedStaff === null || confirmedAdmin === null) return;
    const role: CachedRole = { staff: confirmedStaff, admin: confirmedAdmin };
    sessionRoles.set(key, role);
    writeCachedRole(account, role);
  }, [confirmedStaff, confirmedAdmin, account, key]);

  return {
    isStaff: confirmedStaff ?? cached?.staff ?? false,
    isPlatformAdmin: confirmedAdmin ?? cached?.admin ?? false,
    isLoading: data === undefined && cached === null,
    signedIn: data === undefined ? null : data.signedIn,
  };
}

/** The class's attendance sheet: who belongs to it, and who is staff. */
export interface ClassSheet {
  /** False when this account may not see the class (unknown code/not signed in). */
  ok: boolean;
  /** Teacher who created the class, when known. */
  ownerName: string | null;
  /** Every account that joined the class as a student. */
  students: string[];
  /** Teachers in this class — never listed on the sheet, never markable. */
  teachers: string[];
  /** Students a teacher added by name, for people without an account yet. */
  added: string[];
  /**
   * Whether the signed-in account is staff for this class, straight from the
   * deployment. This — not the browser's stored role — is what decides whether
   * the account is off the sheet and holds the roll.
   */
  viewerIsStaff: boolean;
  isLoading: boolean;
}

/**
 * Who belongs to the class on screen, from the deployment, so the attendance
 * sheet lists the whole class on every device. Passing `null` skips the query
 * (a browser that has no class open yet).
 */
export function useClassSheet(code: string | null): ClassSheet {
  const data = useQuery(api.classes.classSheet, code ? { code } : "skip");
  return {
    ok: data?.ok ?? false,
    ownerName: data?.ownerName ?? null,
    students: data?.students ?? [],
    teachers: data?.teachers ?? [],
    added: data?.added ?? [],
    viewerIsStaff: data?.viewerIsStaff ?? false,
    isLoading: code !== null && data === undefined,
  };
}

/**
 * The class's attendance marks, straight from the deployment, so a teacher's
 * roll and a student's "not attending" note are the same sheet on every
 * device. Shaped like the marks the vault used to hold, so the existing
 * helpers (`attendanceFor`, `attendanceSummary`) work unchanged.
 */
export function useClassAttendance(code: string | null): {
  /** False when this account may not read the class. */
  ok: boolean;
  marks: AttendanceEntry[];
  isLoading: boolean;
} {
  const data = useQuery(api.attendance.classAttendance, code ? { code } : "skip");
  const marks = useMemo<AttendanceEntry[]>(() => {
    const rows = data?.marks ?? [];
    return rows.map((row) => ({
      id: row.id,
      date: row.date,
      name: row.name,
      status: row.status,
      markedBy: row.markedBy,
      createdAt: row.updatedAt,
    }));
  }, [data]);
  return {
    ok: data?.ok ?? false,
    marks,
    isLoading: code !== null && data === undefined,
  };
}

export function useClasses(): ClassesState {
  const data = useQuery(api.classes.myClasses);
  const owned = data?.owned ?? [];
  const joined = data?.joined ?? null;
  const available =
    joined && !owned.some((entry) => entry.code === joined.code)
      ? [...owned, joined]
      : owned;
  return { owned, joined, available, isLoading: data === undefined };
}

/**
 * A stable key for a list of classes, so effects can depend on the set of
 * classes without re-running on every render.
 */
export function classKey(classes: ClassSummary[]): string {
  return classes.map((entry) => entry.code).join(",");
}

/** Uppercase a typed class code and drop anything it can't contain. */
export function formatClassCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}
