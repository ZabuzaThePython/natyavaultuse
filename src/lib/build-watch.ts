/**
 * Notices when a newer build of NatyaVault has been published, so a tab that
 * was left open does not keep running yesterday's code.
 *
 * A tab keeps the JavaScript it loaded until something replaces it. That is
 * invisible while nothing changes, but after a deploy it means the person
 * staring at the app is testing code nobody else has any more — which is
 * exactly how a fix can look like it never shipped.
 *
 * The check is deliberately cheap and private: once on start-up, whenever the
 * tab is brought back to the foreground, and every few minutes while it stays
 * open. It compares the entry script this page is running with the one the
 * published `index.html` now points at, and only then offers a reload.
 */
import { isNewBuild } from "@/lib/build-version";
import { useEffect } from "react";
import { toast } from "sonner";

/** How often an open tab checks while it is in the foreground. */
const CHECK_EVERY = 5 * 60 * 1000;

/** The script this page actually booted from. */
function runningEntry(): string | null {
  if (typeof document === "undefined") return null;
  const script = document.querySelector<HTMLScriptElement>(
    'script[type="module"][src]',
  );
  return script?.src ?? null;
}

/** Offer a reload when a newer build has been published. */
export function useBuildWatcher(): void {
  useEffect(() => {
    // In development the entry script is the Vite client, which does not
    // change between edits — and the dev server already reloads the page.
    if (import.meta.env.DEV) return;

    let stopped = false;
    let offered = false;

    const check = async () => {
      if (stopped || offered || navigator.onLine === false) return;
      const running = runningEntry();
      if (!running) return;
      try {
        const response = await fetch(`/index.html?build=${Date.now()}`, {
          cache: "no-store",
          headers: { accept: "text/html" },
        });
        if (!response.ok) return;
        const html = await response.text();
        if (!isNewBuild(running, html)) return;
        offered = true;
        toast("A new version of NatyaVault is ready", {
          description: "Reload to pick up the latest changes.",
          duration: Infinity,
          action: {
            label: "Reload",
            onClick: () => window.location.reload(),
          },
        });
      } catch {
        // Offline, or the check itself failed — nothing to report, and the
        // next check will try again.
      }
    };

    const timer = window.setInterval(() => void check(), CHECK_EVERY);
    // Coming back to the tab is the moment to look. They are separate handlers
    // on purpose: `visibilitychange` fires for a tab being hidden too, while a
    // window that is focused but not yet painted still deserves a check.
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    void check();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
