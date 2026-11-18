import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { announceInstallFinished } from "@/lib/push";
import { cn } from "@/lib/utils";
import {
  clearInstallPrompt,
  detectPlatform,
  dismissInstallPrompt,
  isInstallPromptPending,
  isStandalone,
  watchForInstall,
  type Platform,
} from "@/lib/install";
import { EllipsisVertical, Share, Smartphone, SquarePlus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

/** One numbered instruction inside a platform column. */
function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-red-800 text-[11px] font-semibold text-yellow-300">
        {n}
      </span>
      <span className="text-sm leading-relaxed text-foreground/85">
        {children}
      </span>
    </li>
  );
}

function PlatformCard({
  title,
  subtitle,
  icon,
  isThisDevice,
  steps,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
  isThisDevice: boolean;
  steps: ReactNode[];
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-3 rounded-xl border p-4",
        isThisDevice
          ? "border-gold/60 bg-gold/5"
          : "border-border bg-muted/40",
      )}
    >
      <div className="flex items-start gap-2.5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-red-800 text-yellow-300">
          {icon}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="font-semibold text-foreground">{title}</p>
            {isThisDevice && (
              <Badge variant="outline" className="border-gold/70 text-gold-foreground">
                This device
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      <ol className="flex flex-col gap-2.5">
        {steps.map((step, index) => (
          <Step key={index} n={index + 1}>
            {step}
          </Step>
        ))}
      </ol>
    </section>
  );
}

/**
 * Shown to an account that was just created: NatyaVault opens like an app from
 * the home screen, and the steps are the same two every time — one column for
 * iPhone/iPad, one for Android, side by side.
 *
 * It asks at most twice. A plain browser tab gives us no way to know the site
 * is already on this phone's home screen, so waving the popup away keeps it
 * quiet for a week rather than at every visit, a second wave (or "Don't ask
 * again") stops it for good, and an actual install — the standalone display
 * mode, or Chrome's `appinstalled` event — clears it outright.
 */
export function AddToHomeScreenDialog({
  suppressed = false,
  ready = true,
}: {
  /** Held back while another first-run card is on screen, so they never stack. */
  suppressed?: boolean;
  /**
   * The deployment has answered which other first-run cards are owed. Until it
   * has, the walkthrough's own answer is still unknown, and opening now is how
   * these steps used to end up hidden underneath it.
   */
  ready?: boolean;
} = {}) {
  // Offered once the first-run cards have settled and none of them has the
  // screen: a fresh account gets the steps, and a browser already running the
  // installed app never does. `open` is derived rather than synced, so a card
  // that takes the screen later simply holds this one back until it is done.
  const [showing, setShowing] = useState(false);
  const open = showing && !suppressed;
  const setOpen = (next: boolean) => setShowing(next);
  const platform: Platform = detectPlatform();

  useEffect(() => {
    if (!ready || suppressed) return;
    if (isStandalone()) return;
    if (isInstallPromptPending()) setShowing(true);
  }, [ready, suppressed]);

  // Installed mid-session? Then the steps are history — forget them.
  useEffect(
    () =>
      watchForInstall(() => {
        clearInstallPrompt();
        setOpen(false);
        // Installed: the next useful step is turning notifications on.
        announceInstallFinished();
      }),
    [],
  );

  // Waving the popup away buys quiet, not silence forever (see src/lib/install.ts).
  const close = () => {
    // Another first-run card taking over is not the reader waving these steps
    // away — they were never really on screen — so it is not a dismissal.
    if (suppressed) return;
    dismissInstallPrompt();
    setOpen(false);
    // The install steps are done being shown — offer notifications next.
    announceInstallFinished();
  };

  // The explicit escape hatch: never offer these steps on this browser again.
  const dontAskAgain = () => {
    dismissInstallPrompt({ forever: true });
    setOpen(false);
    announceInstallFinished();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-samarkan text-2xl text-primary">
            Add NatyaVault to your home screen
          </DialogTitle>
          <DialogDescription>
            Your vault opens like an app — one tap from the home screen, full
            screen, no address bar. Nothing to download from a store.
          </DialogDescription>
        </DialogHeader>

        {platform === "other" && (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            You're on a computer right now — pick up your phone, open this same
            web address in its browser, and follow the steps for your phone.
            (On desktop Chrome or Edge you can also use{" "}
            <span className="font-medium text-foreground">
              Install app
            </span>{" "}
            in the address bar.)
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <PlatformCard
            title="iPhone & iPad"
            subtitle="Safari, or Chrome, Edge and Firefox on iOS 16.4+"
            icon={<Share className="size-4" />}
            isThisDevice={platform === "ios"}
            steps={[
              <>
                Open NatyaVault in your browser (Safari works everywhere).
              </>,
              <>
                Tap the <span className="font-medium">Share</span> button — the
                square with an arrow pointing up. In Safari it sits at the
                bottom of the screen; in Chrome and Firefox it is at the top.
              </>,
              <>
                Tap <span className="font-medium">View More</span> at the end
                of the row of apps — on newer iPhones it is a{" "}
                <span className="font-medium">⋯</span> button.
              </>,
              <>
                <span className="font-medium">Scroll down</span> the list that
                opens and tap{" "}
                <span className="font-medium">Add to Home Screen</span> — it
                sits near the bottom.
              </>,
              <>
                Tap <span className="font-medium">Add</span> up in the corner.
                The Om icon lands next to your other apps.
              </>,
            ]}
          />
          <PlatformCard
            title="Android"
            subtitle="Chrome, Edge, Firefox or Samsung Internet"
            icon={<EllipsisVertical className="size-4" />}
            isThisDevice={platform === "android"}
            steps={[
              <>Open NatyaVault in your phone's browser.</>,
              <>
                Tap the <span className="font-medium">⋮</span> menu in the
                top-right corner (Samsung Internet: the{" "}
                <span className="font-medium">☰</span> menu at the bottom).
              </>,
              <>
                Tap <span className="font-medium">Add to Home screen</span> —
                Chrome sometimes labels it{" "}
                <span className="font-medium">Install app</span>.
              </>,
              <>
                Confirm <span className="font-medium">Add</span> /{" "}
                <span className="font-medium">Install</span>. The Om icon opens
                your vault without the browser bars.
              </>,
            ]}
          />
        </div>

        <p className="flex items-start gap-2 rounded-lg bg-red-800/5 px-3 py-2 text-xs text-muted-foreground">
          <Smartphone className="mt-0.5 size-3.5 shrink-0 text-red-800/70" />
          <span>
            The option only exists in a real browser — inside an app's built-in
            browser (Instagram, Facebook, Gmail) open the page in Safari or
            Chrome first.
          </span>
        </p>

        <DialogFooter className="sm:items-center sm:justify-between">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <SquarePlus className="size-3.5" />
            About ten seconds — you can browse your vault without it.
          </p>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={dontAskAgain}>
              Don't ask again
            </Button>
            <Button type="button" onClick={close}>
              Got it
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
