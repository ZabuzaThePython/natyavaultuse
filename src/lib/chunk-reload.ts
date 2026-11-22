/**
 * Recovering from a redeploy that happened while a tab was open.
 *
 * Every build gives its JavaScript chunks a new hash in the file name, so the
 * `index.html` of one build names files that only that build uploaded. A tab
 * (or a browser cache) still holding yesterday's `index.html` asks for chunks
 * that no longer exist, and the browser reports exactly that:
 *
 *   Failed to fetch dynamically imported module: …/assets/Auth-AEpVNQab.js
 *
 * Nothing is broken — the page just needs the current `index.html`, which names
 * files that do exist. One reload fixes it, so this module decides when to
 * reload and, just as importantly, when not to: reloading in a loop would be
 * worse than the error.
 */

/** How long after a reload-for-update another one is refused, in ms. */
const GUARD_MS = 60_000;
const GUARD_KEY = "natyavault.update-reload.v1";

/** True once this page load has already asked for a reload. */
let askedThisLoad = false;

/**
 * Whether an error means "this tab is running an older build".
 *
 * Matched on the message because browsers do not give the failure a stable
 * type: Chrome says "Failed to fetch dynamically imported module", Firefox
 * "error loading dynamically imported module", and a module that arrives with
 * the wrong MIME type fails differently again.
 */
export function isStaleChunkError(error: unknown): boolean {
  const message = (
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error ?? "")
  ).toLowerCase();
  return (
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("importing a module script failed") ||
    message.includes("expected a javascript module script") ||
    // Safari's wording when the chunk is gone.
    message.includes("importing a module script failed")
  );
}

/**
 * Reload this page to pick up the current build. Returns false when a reload
 * was already attempted moments ago (or on this page load), so a chunk that is
 * genuinely missing shows a message instead of an endless refresh.
 */
export function reloadForUpdate(): boolean {
  if (askedThisLoad) return false;
  askedThisLoad = true;
  try {
    const last = Number(sessionStorage.getItem(GUARD_KEY) ?? "0");
    if (Number.isFinite(last) && Date.now() - last < GUARD_MS) return false;
    sessionStorage.setItem(GUARD_KEY, String(Date.now()));
  } catch {
    // Storage refused: the in-memory guard above still stops a loop on this
    // page load, which is the case that matters.
  }
  window.location.reload();
  return true;
}
