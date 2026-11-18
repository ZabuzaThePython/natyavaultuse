import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import { Loader2, UserRound } from "lucide-react";
import { useState } from "react";
/** Dig the useful sentence out of a Convex mutation error. */
function readableError(error: unknown): string {
  const raw = error instanceof Error ? error.message : "";
  const tail = raw.split("Uncaught Error:").pop()?.trim();
  return tail && tail.length > 0 && tail.length < 140
    ? tail
    : "Couldn't save your name — please try again.";
}

/**
 * "What's your name?" — shown once to an account that was created before
 * sign-up asked for a full name. Those accounts go by their username (say
 * `maya.iyer`), which is what classmates see on class lists, chat bubbles and
 * call tiles, so this is the one card that fixes it.
 *
 * It is a nudge, not a wall: "Later" closes it for this visit and it comes back
 * next time, until a name is saved.
 */
export function FullNamePrompt({
  open,
  currentName,
  username,
  onClose,
}: {
  open: boolean;
  /** The name on the account right now — often just the username. */
  currentName: string;
  /** The sign-in handle, used to spot a name that is really a username. */
  username: string;
  onClose: () => void;
}) {
  const setFullName = useMutation(api.names.setFullName);
  // Offer an empty box when the current "name" is the handle, so the username
  // isn't mistaken for a real name they only need to confirm.
  const handle = username.trim().toLowerCase();
  const prefill =
    handle.length > 0 && currentName.trim().toLowerCase() === handle
      ? ""
      : currentName;

  const [draft, setDraft] = useState<string | null>(null);
  // Untouched means "show what the account has now"; typing takes over from
  // there, and a name that arrives late still fills the empty box.
  const value = draft ?? prefill;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Closing forgets the draft, so a card that comes back later starts fresh.
  const close = () => {
    setDraft(null);
    setError(null);
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const cleaned = value.trim().replace(/\s+/g, " ");
    if (cleaned.length < 2) {
      setError("Enter your full name — it's what your teacher and classmates see.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setFullName({ fullName: cleaned });
      close();
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-red-800/10">
            <UserRound className="size-5 text-red-800" />
          </div>
          <DialogTitle className="font-samarkan text-2xl text-primary">
            What's your name?
          </DialogTitle>
          <DialogDescription>
            Your account still goes by{" "}
            <span className="font-mono text-foreground">
              {username || "your username"}
            </span>
            . Add your full name and it's what your teacher and classmates see
            on class lists, in chats and on calls. You still sign in with your
            username.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="full-name">Your full name</Label>
            <Input
              id="full-name"
              name="fullName"
              value={value}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              placeholder="e.g. Maya Iyer"
              autoComplete="name"
              autoFocus
              aria-invalid={error ? true : undefined}
              disabled={saving}
            />
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter className="sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={close}
              disabled={saving}
            >
              Later
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              Save name
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
