import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  clearDiagnoses,
  formatDiagnoses,
  markDiagnosesSeen,
  useDiagnoses,
  useUnseenDiagnoses,
  type DiagnosisEntry,
} from "@/lib/admin-diagnostics";
import { toast } from "sonner";
import { useState } from "react";

const KIND_LABEL: Record<DiagnosisEntry["kind"], string> = {
  hasAdminAccess: "hasAdminAccess",
  viewerRole: "viewerRole",
  shell: "menu state",
};

function clock(at: number): string {
  const time = new Date(at).toLocaleTimeString(undefined, { hour12: false });
  return `${time}.${String(at % 1000).padStart(3, "0")}`;
}

function DiagnosisRow({ entry }: { entry: DiagnosisEntry }) {
  const tone = entry.vanished
    ? "border-destructive/50 bg-destructive/5"
    : entry.restored
      ? "border-emerald-500/40 bg-emerald-500/5"
      : "border-border/60 bg-card/40";
  return (
    <li className={`rounded-md border px-2.5 py-2 ${tone}`}>
      <div className="flex items-center gap-2 text-[10px] tracking-wide uppercase">
        <span className="font-mono text-muted-foreground">{clock(entry.at)}</span>
        <span className="font-semibold text-foreground/70">
          {KIND_LABEL[entry.kind]}
        </span>
        {entry.vanished ? (
          <span className="font-semibold text-destructive">disappeared</span>
        ) : null}
        {entry.restored ? (
          <span className="font-semibold text-emerald-600 dark:text-emerald-400">
            returned
          </span>
        ) : null}
      </div>
      <code className="mt-1 block font-mono text-[10px] leading-4 break-all text-foreground/75">
        {JSON.stringify(entry.data)}
      </code>
    </li>
  );
}

/**
 * The way to see what the deployment actually answered about admin access.
 *
 * A small link in the support card opens the last answers and, above all, the
 * moments the studio picker and the Classes/Studio entries disappeared. It is
 * available to every account on purpose: when the controls vanish, the account
 * that needs to read this is the one that just lost them.
 */
export function AdminDiagnostics() {
  const [open, setOpen] = useState(false);
  const entries = useDiagnoses();
  const unseen = useUnseenDiagnoses();

  const openPanel = () => {
    setOpen(true);
    markDiagnosesSeen();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatDiagnoses());
      toast.success("Diagnostics copied");
    } catch {
      toast.error("Couldn't copy — select the text instead.");
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={openPanel}
        className="mt-2 flex items-center gap-1.5 text-[10px] font-medium text-sidebar-foreground/50 underline-offset-2 transition-colors hover:text-sidebar-foreground hover:underline"
        title="What the deployment answered about admin access"
      >
        Admin diagnostics
        {unseen > 0 ? (
          <span className="flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-gold/25 px-1 text-[9px] font-semibold text-gold">
            {unseen > 9 ? "9+" : unseen}
          </span>
        ) : null}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Admin diagnostics</DialogTitle>
            <DialogDescription>
              Every answer the deployment gave about your admin role this
              visit, and the moment the studio picker or the Classes/Studio
              entries changed. Newest last. Nothing here leaves this device
              until you copy it.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[55vh] overflow-y-auto pr-1">
            {entries.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground">
                Nothing recorded yet. Leave this open in the background and come
                back when the menu changes.
              </p>
            ) : (
              <ol className="space-y-1.5">
                {entries.map((entry, index) => (
                  <DiagnosisRow
                    key={`${entry.at}-${entry.kind}-${index}`}
                    entry={entry}
                  />
                ))}
              </ol>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => clearDiagnoses()}
              disabled={entries.length === 0}
            >
              Clear
            </Button>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" onClick={copy}>
                Copy
              </Button>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
