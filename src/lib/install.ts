/**
 * "Add to Home Screen" helpers.
 *
 * NatyaVault is a plain web app, so it can only be installed from the phone's
 * own browser: iOS exposes no API for it and every browser hides the command
 * behind its own menu. Nothing here can trigger the install — creating an
 * account just records that this browser might still owe itself the
 * instructions, and `AddToHomeScreenDialog` does the explaining.
 *
 * Asking again is the tricky part. Nothing on the web tells a plain browser
 * tab "this site is already on the home screen", so we cannot quietly know the
 * steps are done; only an installed app (`isStandalone`) or Chrome's
 * `appinstalled` event actually says so. So the popup asks at most twice:
 * waving it away keeps it quiet for a week rather than at every visit, a second
 * wave — or the explicit "Don't ask again" — ends it for good, and a real
 * install clears it outright.
 */

const KEY = "natyavault.install";

/** How long one dismissal keeps the popup quiet. */
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

/** Dismissals before we take the hint and stop asking altogether. */
const DISMISSALS_BEFORE_STOPPING = 2;

interface InstallPromptRecord {
  /** "pending" while this browser might still owe itself the steps. */
  state: "pending" | "done";
  /** How many times the steps have been waved away. */
  dismissals: number;
  /** Epoch ms before which the popup stays quiet. */
  showAfter: number;
}

function read(): InstallPromptRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    // Older versions stored the bare string "pending".
    if (raw === "pending") {
      return { state: "pending", dismissals: 0, showAfter: 0 };
    }
    const parsed = JSON.parse(raw) as Partial<InstallPromptRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      state: parsed.state === "pending" ? "pending" : "done",
      dismissals:
        typeof parsed.dismissals === "number" ? parsed.dismissals : 0,
      showAfter: typeof parsed.showAfter === "number" ? parsed.showAfter : 0,
    };
  } catch {
    // Unreadable (private mode, storage off, hand-edited) — treat as nothing.
    return null;
  }
}

function write(record: InstallPromptRecord | null) {
  try {
    if (record === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Private mode / storage disabled — the popup is a nicety, never fatal.
  }
}

/**
 * Remember that this browser might still have to be shown the install steps.
 * Called when an account is created, so the dashboard has something to offer.
 */
export function markInstallPromptPending() {
  const current = read();
  // Someone who has already waved the steps away twice meant it — a new
  // account on the same browser is not a reason to start nagging again.
  if (
    current?.state === "done" &&
    current.dismissals >= DISMISSALS_BEFORE_STOPPING
  ) {
    return;
  }
  write({
    state: "pending",
    dismissals: current?.dismissals ?? 0,
    showAfter: 0,
  });
}

/** Done with the steps: the app is installed, or no account was created. */
export function clearInstallPrompt() {
  write(null);
}

/**
 * Start the steps over. The guided walkthrough ends on "put NatyaVault on your
 * home screen", so the account that just finished it is owed those steps even
 * if an earlier account on this browser waved them away.
 */
export function rearmInstallPrompt() {
  write({ state: "pending", dismissals: 0, showAfter: 0 });
}

/**
 * The steps were waved away. They stay quiet for a week and come back once —
 * then stop for good. Pass `{ forever: true }` for the explicit "Don't ask
 * again", which stops immediately.
 */
export function dismissInstallPrompt(options?: { forever?: boolean }) {
  const current = read();
  const dismissals = options?.forever
    ? DISMISSALS_BEFORE_STOPPING
    : (current?.dismissals ?? 0) + 1;
  if (dismissals >= DISMISSALS_BEFORE_STOPPING) {
    // Asked twice already: stop, and remember that we were told so.
    write({ state: "done", dismissals, showAfter: 0 });
    return;
  }
  write({ state: "pending", dismissals, showAfter: Date.now() + SNOOZE_MS });
}

/** True while the install steps are still owed, and not currently snoozed. */
export function isInstallPromptPending(): boolean {
  const record = read();
  if (record === null || record.state !== "pending") return false;
  return Date.now() >= record.showAfter;
}

export type Platform = "ios" | "android" | "other";

/**
 * Which phone this is, so the matching instructions can be highlighted. An
 * iPad reports itself as a Mac, so touch points are what gives it away.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  if (/iPhone|iPod|iPad/.test(ua) || iPadOS) return "ios";
  if (/Android/i.test(ua)) return "android";
  return "other";
}

/** The display modes that mean "opened from the home screen, not a browser". */
const STANDALONE_QUERIES = [
  "(display-mode: standalone)",
  "(display-mode: minimal-ui)",
  "(display-mode: fullscreen)",
  "(display-mode: window-controls-overlay)",
];

/** Already running as the installed app — there is nothing left to add. */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  for (const query of STANDALONE_QUERIES) {
    if (window.matchMedia(query).matches) return true;
  }
  // iOS Safari reports the installed state here instead of via display-mode.
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/**
 * Watch for the app actually getting installed, and say so the moment it does.
 * Chrome fires `appinstalled` in the tab that started the install — the one
 * case a display-mode query cannot see, because that tab is still a tab. The
 * display-mode queries flip when an installed app is on screen instead, and
 * iOS only settles on `focus`, when the installed app comes back to the
 * foreground. Returns an unsubscribe function.
 */
export function watchForInstall(onInstalled: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const notify = () => {
    if (isStandalone()) onInstalled();
  };
  const queries = STANDALONE_QUERIES.map((query) => window.matchMedia(query));
  notify();
  window.addEventListener("appinstalled", onInstalled);
  window.addEventListener("focus", notify);
  for (const query of queries) query.addEventListener("change", notify);
  return () => {
    window.removeEventListener("appinstalled", onInstalled);
    window.removeEventListener("focus", notify);
    for (const query of queries) query.removeEventListener("change", notify);
  };
}
