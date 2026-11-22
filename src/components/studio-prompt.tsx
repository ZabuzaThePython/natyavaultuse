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
import { GraduationCap, Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * "Name your studio" — shown once to a teacher account that has no studio.
 *
 * That is every teacher who was teaching before studios existed: their classes
 * have no `studioId`, so nothing scopes them. Creating the studio here adopts
 * those classes and places their students, which is why the server returns the
 * counts and the card can say what came along.
 *
 * It is a nudge, not a wall: "Later" closes it for this visit and it comes back
 * next time, until a studio exists.
 */
export function StudioPrompt({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const createStudio = useMutation(api.studios.createStudio);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folder = name.toLowerCase().replace(/[^a-z0-9]/g, "");

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const clean = name.trim();
    if (clean.length < 2) {
      setError("Give your studio a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await createStudio({ name: clean });
      if (!result.ok) {
        setError(result.error ?? "Could not create the studio.");
        return;
      }
      const came =
        result.adoptedClasses > 0
          ? ` ${result.adoptedClasses} class${
              result.adoptedClasses === 1 ? "" : "es"
            } and ${result.adoptedStudents} student${
              result.adoptedStudents === 1 ? "" : "s"
            } came with it.`
          : "";
      toast.success(`${clean} is ready.${came}`);
      setName("");
      onClose();
    } catch (caught) {
      console.error("Creating the studio failed:", caught);
      setError("Could not create the studio. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 tracking-tight">
            <GraduationCap className="h-5 w-5 text-primary" />
            Name your studio
          </DialogTitle>
          <DialogDescription>
            Your classes and students belong to a studio. Name it once; the classes
            you already run move into it with their students.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="studio-name">Studio name</Label>
            <Input
              id="studio-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Shubha Studio of Arts"
              autoComplete="organization"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Its folder in the archive becomes{" "}
              <span className="font-mono">nv{folder || "…"}</span>.
            </p>
          </div>

          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : null}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              className="cursor-pointer"
              onClick={onClose}
              disabled={saving}
            >
              Later
            </Button>
            <Button type="submit" className="cursor-pointer" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating…
                </>
              ) : (
                "Create studio"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
