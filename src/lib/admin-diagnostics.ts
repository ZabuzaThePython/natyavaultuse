/**
 * A small, in-memory record of what the deployment said about this account's
 * admin role — and of the exact moment the studio picker and the Classes/
 * Studio entries disappeared.
 *
 * It exists because that failure has been guessed at three times: the answers
 * looked correct whenever they were checked by hand, so the only way forward is
 * to keep the last few answers and the transition that hid the controls, and
 * read them right after it happens.
 *
 * Deliberately inert: nothing is written to storage, nothing is sent anywhere,
 * and no answer is changed by recording it. The only side effect is a probe of
 * whether browser storage accepts a write, taken once per disappearance,
 * because a full quota is one of the suspected causes.
 */
import { useSyncExternalStore } from "react";

export type DiagnosisKind = "hasAdminAccess" | "viewerRole" | "shell";

export interface DiagnosisEntry {
  at: number;
  kind: DiagnosisKind;
  /** The admin controls disappeared on this entry. */
  vanished?: boolean;
  /** They came back on this entry. */
  restored?: boolean;
  data: Record<string, unknown>;
}

/** How many answers are kept. Older ones fall off the front. */
const MAX_ENTRIES = 80;

/**
 * The same answer is seen by several mounted copies of a hook (the shell, the
 * Classes page, the Admin page). Within this window it is recorded once.
 */
const DEDUPE_MS = 2000;

/** Where the record is kept so a reload does not erase the evidence. */
const STORE_KEY = "natyavault.diag.v1";
/** When this page load started; earlier entries came from previous loads. */
const SESSION_START = Date.now();

function isEntry(value: unknown): value is DiagnosisEntry {
  if (value === null || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.at === "number" &&
    (entry.kind === "hasAdminAccess" ||
      entry.kind === "viewerRole" ||
      entry.kind === "shell") &&
    entry.data !== null &&
    typeof entry.data === "object"
  );
}

/**
 * Reloading the page used to erase the record — and the controls going missing
 * is exactly the moment someone reloads. The tab's own storage keeps it for as
 * long as the tab is open, without touching any key the app uses.
 */
function restore(): DiagnosisEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.sessionStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).slice(-MAX_ENTRIES);
  } catch {
    return [];
  }
}

function persist() {
  try {
    if (typeof window === "undefined") return;
    window.sessionStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch {
    // Quota or a blocked store: the record simply stays in memory.
  }
}

let entries: DiagnosisEntry[] = restore();
// Restored entries are history, not news: the badge starts clean.
let unseen = 0;
const listeners = new Set<() => void>();
const EMPTY: DiagnosisEntry[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record one answer or transition. Cheap, capped, and never throws. */
export function recordDiagnosis(
  kind: DiagnosisKind,
  data: Record<string, unknown>,
  flags: { vanished?: boolean; restored?: boolean } = {},
): void {
  try {
    const now = Date.now();
    const payload = JSON.stringify(data);
    // Skip an answer another mounted copy of the same hook just recorded.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (now - entry.at > DEDUPE_MS) break;
      if (entry.kind !== kind || entry.vanished || entry.restored) continue;
      if (JSON.stringify(entry.data) === payload) return;
    }
    const next: DiagnosisEntry = { at: now, kind, data, ...flags };
    entries = [...entries.slice(-(MAX_ENTRIES - 1)), next];
    unseen += 1;
    persist();
    emit();
  } catch {
    // Diagnostics must never be the reason something else fails.
  }
}

/** Every recorded entry, oldest first. */
export function readDiagnoses(): DiagnosisEntry[] {
  return entries;
}

/** How many entries were recorded since the panel was last opened. */
export function readUnseenDiagnoses(): number {
  return unseen;
}

/** The panel was opened: the badge starts counting again. */
export function markDiagnosesSeen(): void {
  if (unseen === 0) return;
  unseen = 0;
  emit();
}

/** Throw the record away (after it has been copied out). */
export function clearDiagnoses(): void {
  entries = [];
  unseen = 0;
  persist();
  emit();
}

/** Reactive list, for the panel. */
export function useDiagnoses(): DiagnosisEntry[] {
  return useSyncExternalStore(subscribe, readDiagnoses, () => EMPTY);
}

/** Reactive unseen count, for the small badge. */
export function useUnseenDiagnoses(): number {
  return useSyncExternalStore(subscribe, readUnseenDiagnoses, () => 0);
}

/**
 * Whether each browser storage accepts a write right now. Checked only when
 * something is recorded, so a normal visit never touches it.
 */
export function storageProbe(): { local: boolean; session: boolean } {
  const result = { local: false, session: false };
  if (typeof window === "undefined") return result;
  for (const name of ["local", "session"] as const) {
    try {
      const store = name === "local" ? window.localStorage : window.sessionStorage;
      const key = "natyavault.diag.probe";
      store.setItem(key, "1");
      store.removeItem(key);
      result[name] = true;
    } catch {
      result[name] = false;
    }
  }
  return result;
}

/** The two admin controls whose disappearance is being tracked. */
export interface AdminViewState {
  /** The studio picker: true/false once its list has loaded, null before. */
  picker: boolean | null;
  /** The Classes and Studio entries in the menu. */
  nav: boolean;
}

/**
 * What changed between two states of the admin controls. A picker that is
 * simply still loading (null) is not a change in either direction.
 */
export function adminViewChange(
  previous: AdminViewState | null,
  current: AdminViewState,
): "first" | "vanished" | "restored" | null {
  if (previous === null) return "first";
  const vanished =
    (previous.picker === true && current.picker === false) ||
    (previous.nav && !current.nav);
  if (vanished) return "vanished";
  const restored =
    (previous.picker === false && current.picker === true) ||
    (!previous.nav && current.nav);
  return restored ? "restored" : null;
}

function clock(at: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(at % 1000).padStart(3, "0")}`;
}

/**
 * The whole record as plain text, for pasting into a message. Kept
 * single-line-per-entry so it survives being copied from a phone.
 */
export function formatDiagnoses(): string {
  const earlier = entries.filter((entry) => entry.at < SESSION_START).length;
  // Which published build this tab is running. A page left open, an installed
  // app, or a browser that held on to an older bundle answers a question about
  // the code differently from the build that is live now, and that is worth
  // being able to see rather than guess at.
  const build =
    typeof document === "undefined"
      ? "?"
      : (document.querySelector('script[type="module"]')?.getAttribute("src") ??
        "?");
  const header = [
    "NatyaVault admin diagnostics",
    `time: ${new Date().toISOString()}`,
    `build: ${build}`,
    `page: ${typeof location === "undefined" ? "?" : location.href}`,
    `agent: ${typeof navigator === "undefined" ? "?" : navigator.userAgent}`,
    `this page load: ${new Date(SESSION_START).toISOString()}`,
    `from earlier page loads in this tab: ${earlier}`,
    "",
  ].join("\n");
  if (entries.length === 0) return `${header}(nothing recorded yet)`;
  const lines = entries.map((entry) => {
    const mark = entry.vanished
      ? " VANISHED"
      : entry.restored
        ? " RESTORED"
        : "";
    return `${clock(entry.at)} ${entry.kind}${mark} ${JSON.stringify(entry.data)}`;
  });
  return `${header}${lines.join("\n")}`;
}
