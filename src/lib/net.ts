/**
 * Recognising a browser-level network failure, as opposed to a bug.
 *
 * `fetch` rejects with a bare `TypeError: Failed to fetch` when the request
 * never got an answer at all — offline, DNS failure, TLS failure, a CORS-less
 * edge error page. Those are conditions, not defects, so the app reports them
 * as "can't reach the server" instead of crashing.
 */

const NETWORK_FAILURE =
  /Failed to fetch|NetworkError|network error|fetch failed|Load failed|Network request failed|ERR_NETWORK|ERR_INTERNET_DISCONNECTED|The network connection was lost/i;

/** True for browser-level fetch failures (offline, DNS, TLS, edge 5xx). */
export function isNetworkFailure(reason: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  if (typeof reason === "string") return NETWORK_FAILURE.test(reason);
  if (!reason || typeof reason !== "object") return false;
  const { name, message } = reason as { name?: unknown; message?: unknown };
  // An aborted request (page leaving, query cancelled) is not an outage.
  if (name === "AbortError") return false;
  return typeof message === "string" && NETWORK_FAILURE.test(message);
}
