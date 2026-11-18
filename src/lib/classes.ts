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
 * Teachers and the admin see every class in the school (classes.allClasses);
 * a student only ever sees the one they joined.
 */
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import type { AttendanceEntry } from "@/lib/vault";
import { useQuery } from "convex/react";
import { useEffect, useMemo } from "react";

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

/** A class as the school list shows it, with who runs it and how many joined. */
export interface ClassOverview extends ClassSummary {
  ownerName: string;
  members: number;
  /** True when the signed-in account created this class. */
  isMine: boolean;
  /**
   * True when this account may delete the class: the teacher who created it,
   * or the admin. Seeing a class in the school list is not enough.
   */
  canDelete: boolean;
}

export interface AllClassesState {
  classes: ClassOverview[];
  /** False for students: they may not see the school's other classes. */
  canSeeAll: boolean;
  isLoading: boolean;
}

/**
 * Every class in the school, for teachers and the admin. A student gets
 * `canSeeAll: false` and an empty list, so they keep seeing only the class
 * they joined.
 */
export function useAllClasses(): AllClassesState {
  const data = useQuery(api.classes.allClasses);
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
  /** True until the deployment has answered. */
  isLoading: boolean;
  /** False when the server cannot see this browser's session at all. */
  signedIn: boolean | null;
}

/** Last role the deployment confirmed for an account, kept per account name. */
const ROLE_CACHE_KEY = "natyavault.roles.v1";

function readCachedRole(name: string | undefined): boolean | null {
  if (!name) return null;
  try {
    const raw = localStorage.getItem(ROLE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed[name] === "boolean" ? (parsed[name] as boolean) : null;
  } catch {
    return null;
  }
}

function writeCachedRole(name: string | undefined, isStaff: boolean) {
  if (!name) return;
  try {
    const raw = localStorage.getItem(ROLE_CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = parsed && typeof parsed === "object" ? parsed : {};
    next[name] = isStaff;
    localStorage.setItem(ROLE_CACHE_KEY, JSON.stringify(next));
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
  const name = user?.name ?? user?.email ?? undefined;
  const data = useQuery(api.classes.viewerRole);
  const cached = useMemo(() => readCachedRole(name), [name]);

  useEffect(() => {
    if (data) writeCachedRole(name, data.isStaff);
  }, [data, name]);

  return {
    isStaff: data ? data.isStaff : (cached ?? false),
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
