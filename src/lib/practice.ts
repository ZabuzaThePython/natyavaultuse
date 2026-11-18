/**
 * The practice log, as the app sees it.
 *
 * Sessions live on the deployment now (src/convex/practice.ts), keyed by the
 * class's join code, so a teacher sees a student's practice on their own
 * device and a cleared browser no longer wipes the history. This module is the
 * client side of that: one hook for reading, plus the one-time import of the
 * sessions an older build kept in this browser.
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { PracticeEntry } from "@/lib/vault";
import { useQuery } from "convex/react";

/** A session with the viewer's own flag, in the shape the pages already use. */
export interface PracticeEntryView {
  /** Row id on the deployment, for deleting it again. */
  id: Id<"practiceEntries">;
  /** Practice date, YYYY-MM-DD. */
  date: string;
  minutes: number;
  item: string;
  /** Display name of whoever logged it. */
  author: string;
  createdAt: number;
  /** True when the signed-in account logged this session. */
  mine: boolean;
}

export interface ClassPractice {
  /** False when this account may not read that class (or isn't signed in). */
  ok: boolean;
  entries: PracticeEntryView[];
  /** Whether this account is staff for the class, per the deployment. */
  viewerIsStaff: boolean;
  isLoading: boolean;
}

/**
 * The class's sessions, newest first. `null` skips the query — a browser that
 * has no class open yet. `since` (YYYY-MM-DD) narrows the window.
 */
export function useClassPractice(
  code: string | null,
  since?: string,
): ClassPractice {
  const data = useQuery(
    api.practice.classPractice,
    code === null ? "skip" : since ? { code, since } : { code },
  );
  return {
    ok: data?.ok ?? false,
    entries: data?.entries ?? [],
    viewerIsStaff: data?.viewerIsStaff ?? false,
    isLoading: code !== null && data === undefined,
  };
}

/**
 * Which local sessions still owe themselves an upload, per class.
 *
 * The flag is written once the import has run (or turned out to have nothing
 * to do), so opening the app again does not re-check.
 */
const IMPORTED_KEY = "natyavault.practiceImported.v1";

function readImported(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(IMPORTED_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Has this class's local log already been handed to the deployment? */
export function localPracticeImported(code: string): boolean {
  return code !== "" && readImported()[code] === true;
}

/** Remember that this class's local log has been imported. */
export function markLocalPracticeImported(code: string) {
  if (code === "") return;
  try {
    localStorage.setItem(
      IMPORTED_KEY,
      JSON.stringify({ ...readImported(), [code]: true }),
    );
  } catch {
    // Storage unavailable — the import is idempotent, so it just runs again.
  }
}

/**
 * The sessions in this browser's vault that belong to the signed-in account
 * and have not been imported yet. Only the viewer's own entries travel: a
 * browser a whole class used must not attribute someone else's practice to
 * whoever happens to sign in next.
 */
export function pendingLocalPractice(
  code: string,
  authorName: string,
  logs: PracticeEntry[],
): { clientId: string; date: string; minutes: number; item: string }[] {
  if (!code || !authorName || localPracticeImported(code)) return [];
  return logs
    .filter((log) => log.author === authorName)
    .map((log) => ({
      clientId: log.id,
      date: log.date,
      minutes: log.minutes,
      item: log.item,
    }));
}
