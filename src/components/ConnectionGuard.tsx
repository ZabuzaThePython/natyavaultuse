import { Button } from "@/components/ui/button";
import { isNetworkFailure } from "@/lib/net";
import { WifiOff } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";

/**
 * A dropped connection is not a code fault.
 *
 * Convex Auth refreshes the stored session when the app boots, and it retries
 * that call only twice over ~2.5s (see `RETRY_BACKOFF` in
 * @convex-dev/auth's client). If the phone has no signal in that window — or
 * Convex's edge is briefly unreachable — the refresh rejects with a bare
 * `TypeError: Failed to fetch`, which used to surface as an uncaught error with
 * no explanation and no way forward.
 *
 * The listeners are installed when this module loads, not in an effect: the
 * provider's refresh starts in a child effect, and child effects run before
 * parent effects, so a listener added from this component would miss the very
 * first failure — the one that happens while the app is booting.
 *
 * This keeps those rejections out of the crash reporter and says what actually
 * happened: the server could not be reached, here is a Retry. Every other
 * error — including anything thrown by our own code — passes through untouched.
 */

function currentlyOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

let unreachable = currentlyOffline();
const subscribers = new Set<() => void>();

function publish(next: boolean) {
  if (unreachable === next) return;
  unreachable = next;
  subscribers.forEach((notify) => notify());
}

function subscribe(notify: () => void) {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

function getSnapshot() {
  return unreachable;
}

if (typeof window !== "undefined") {
  // Module evaluation can repeat (HMR), so only wire the handlers once.
  const flag = window as Window & { __natyavaultConnectionGuard?: boolean };
  if (!flag.__natyavaultConnectionGuard) {
    flag.__natyavaultConnectionGuard = true;
    window.addEventListener("unhandledrejection", (event) => {
      if (!isNetworkFailure(event.reason)) return;
      // Reported in the notice below instead of as an uncaught rejection.
      event.preventDefault();
      publish(true);
    });
    window.addEventListener("error", (event) => {
      if (!isNetworkFailure(event.error ?? event.message)) return;
      publish(true);
    });
    window.addEventListener("offline", () => publish(true));
    window.addEventListener("online", () => publish(false));
  }
}

export function ConnectionGuard({ children }: { children: ReactNode }) {
  const offline = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return (
    <>
      {children}
      {offline && (
        <div
          role="status"
          aria-live="polite"
          className="fixed inset-x-3 bottom-3 z-[60] mx-auto flex max-w-md items-start gap-3 rounded-xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur sm:bottom-5"
        >
          <WifiOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Can't reach the server</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              NatyaVault couldn't load your session just now. Check your
              connection, then try again.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => window.location.reload()}
          >
            Retry
          </Button>
        </div>
      )}
    </>
  );
}
