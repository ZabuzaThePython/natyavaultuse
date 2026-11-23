import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { detectPlatform, isStandalone } from "@/lib/install";
import {
  INSTALL_FINISHED_EVENT,
  currentEndpoint,
  currentTimeZone,
  lastSyncedTimeZone,
  markNotificationsPromptSeen,
  markTimeZoneSynced,
  notificationPermission,
  notificationsPromptDue,
  pushSupported,
  subscribeThisDevice,
  unsubscribeThisDevice,
} from "@/lib/push";
import { useMutation, useQuery } from "convex/react";
import { Bell, BellOff, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/**
 * Turning chat notifications on for this device.
 *
 * With `autoOpen`, it offers itself once the "Add to Home Screen" steps are
 * finished (or straight away when the app is already running from the home
 * screen) and never asks again after that. Messages also opens it from a bell
 * button, so it can be turned on — or off — at any time.
 *
 * The permission request only ever runs from the button's click handler:
 * browsers ignore notification prompts that were not triggered by a tap.
 */
export function NotificationsPrompt({
  autoOpen = false,
  open: controlledOpen,
  onOpenChange,
}: {
  autoOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [internalOpen, setInternalOpen] = useState(
    () => autoOpen && isStandalone() && notificationsPromptDue(),
  );
  const open = controlledOpen ?? internalOpen;

  const publicKey = useQuery(api.push.publicKey);
  const devices = useQuery(api.push.devices);
  const saveSubscription = useMutation(api.push.subscribe);
  const forgetSubscription = useMutation(api.push.unsubscribe);

  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Follow the "Add to Home Screen" dialog: when it closes, offer this next.
  useEffect(() => {
    if (!autoOpen) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onInstallFinished = () => {
      if (!notificationsPromptDue()) return;
      // A beat after the install dialog closes, so the two dialogs never
      // fight over focus.
      timer = setTimeout(() => setInternalOpen(true), 250);
    };
    window.addEventListener(INSTALL_FINISHED_EVENT, onInstallFinished);
    return () => {
      window.removeEventListener(INSTALL_FINISHED_EVENT, onInstallFinished);
      if (timer) clearTimeout(timer);
    };
  }, [autoOpen]);

  // Whether *this* browser already has a subscription saved.
  useEffect(() => {
    let cancelled = false;
    void currentEndpoint()
      .then((value) => {
        if (!cancelled) setEndpoint(value);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the saved time zone in step with this device's clock. The browser
  // names its own zone without asking, so opening the app somewhere new (or
  // after a daylight-saving switch) refreshes it once and the monthly fee
  // reminder lands at 9am local time from then on.
  useEffect(() => {
    if (!publicKey) return;
    if (notificationPermission() !== "granted" || endpoint === null) return;
    if (!(devices ?? []).includes(endpoint)) return;
    const zone = currentTimeZone();
    if (!zone || lastSyncedTimeZone() === zone) return;
    let cancelled = false;
    void (async () => {
      const subscription = await subscribeThisDevice(publicKey);
      if (!subscription || cancelled) return;
      const result = await saveSubscription({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: navigator.userAgent.slice(0, 200),
        timeZone: zone,
      });
      if (result.ok) markTimeZoneSynced(zone);
    })().catch(() => {
      // A failed sync only leaves the old zone in place — try again next open.
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, endpoint, devices, saveSubscription]);

  const setOpen = (next: boolean) => {
    if (!next) markNotificationsPromptSeen();
    if (onOpenChange) onOpenChange(next);
    else setInternalOpen(next);
  };

  const supported = pushSupported();
  const permission = notificationPermission();
  const iPhoneBrowser = detectPlatform() === "ios" && !isStandalone();
  const savedHere =
    endpoint !== null && (devices ?? []).includes(endpoint) && permission === "granted";
  // `undefined` means the query is still on its way; only a settled `null`
  // means the deployment really has no VAPID key.
  const keyLoading = publicKey === undefined;
  const keyMissing = publicKey === null;

  const enable = async () => {
    setError(null);
    if (!supported) {
      setError("This browser can't receive notifications.");
      return;
    }
    if (keyLoading) {
      setError("Still checking the deployment — try again in a moment.");
      return;
    }
    if (!publicKey) {
      setError("Notifications aren't configured on this deployment yet.");
      return;
    }
    setBusy(true);
    try {
      // Must stay the first await in the click handler — Safari ignores a
      // permission request that is not tied to the tap.
      const answer = await Notification.requestPermission();
      if (answer === "denied") {
        setError(
          "Notifications are blocked for this site. Allow them in the browser's settings for this site, then try again.",
        );
        return;
      }
      if (answer !== "granted") {
        setError("Notifications weren't turned on.");
        return;
      }

      const subscription = await subscribeThisDevice(publicKey);
      if (!subscription) {
        setError("Couldn't set up notifications on this device. Try again.");
        return;
      }
      const zone = currentTimeZone();
      const result = await saveSubscription({
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: navigator.userAgent.slice(0, 200),
        timeZone: zone ?? undefined,
      });
      if (!result.ok) {
        setError(result.error ?? "Couldn't save this device.");
        return;
      }
      if (zone) markTimeZoneSynced(zone);
      setEndpoint(subscription.endpoint);
      toast.success("Notifications are on for this device.");
      setOpen(false);
    } catch (setupError) {
      console.error("Notifications setup failed:", setupError);
      setError("Couldn't turn notifications on. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setError(null);
    setBusy(true);
    try {
      const removed = await unsubscribeThisDevice();
      if (removed) await forgetSubscription({ endpoint: removed });
      setEndpoint(null);
      toast.success("Notifications are off for this device.");
    } catch (disableError) {
      console.error("Notifications removal failed:", disableError);
      setError("Couldn't turn notifications off. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setOpen(false);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bell className="size-4 text-primary" />
            Chat notifications
          </DialogTitle>
          <DialogDescription>
            Get a notification when someone posts in your chats — even when
            NatyaVault isn't open.
          </DialogDescription>
        </DialogHeader>

        {iPhoneBrowser ? (
          <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
            On iPhone and iPad, notifications only work from the installed app.
            Add NatyaVault to your home screen first, then open it from there
            and turn notifications on.
          </p>
        ) : !supported ? (
          <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
            This browser can't receive notifications. Try Chrome, Edge, or
            Firefox on a computer or Android, or the installed app on iPhone.
          </p>
        ) : permission === "denied" ? (
          <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
            Notifications are blocked for this site. Open the browser's site
            settings and allow notifications, then come back here.
          </p>
        ) : keyMissing ? (
          <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
            Notifications aren't configured on this deployment yet. The site
            owner needs to add the VAPID keys to the Convex deployment.
          </p>
        ) : savedHere ? (
          <div className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-3">
            <Bell className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-sm font-medium">Notifications are on</p>
              <p className="text-xs text-muted-foreground">
                This device gets a notification for every new chat message.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              You'll get a notification when someone sends a message, and
              tapping it opens that chat. Your browser will ask for permission
              once.
            </p>
            <p className="text-xs">
              You can turn them off on this device at any time.
            </p>
          </div>
        )}

        {error && (
          <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={busy}
            >
              {keyLoading ? "Close" : "Not now"}
            </Button>
          {savedHere ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void disable()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <BellOff className="size-4" />
              )}
              Turn off on this device
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => void enable()}
              disabled={
                busy ||
                keyLoading ||
                keyMissing ||
                iPhoneBrowser ||
                !supported ||
                permission === "denied"
              }
            >
              {busy || keyLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Bell className="size-4" />
              )}
              Turn on notifications
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
