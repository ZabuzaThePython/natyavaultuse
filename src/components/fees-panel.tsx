import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useViewerIsStaff } from "@/lib/classes";
import { shortNames } from "@/lib/display-name";
import { monthKey, monthLabel, shiftMonth, useClassFees } from "@/lib/fees";
import { useVault } from "@/lib/vault";
import { cn } from "@/lib/utils";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Lock,
  Wallet,
} from "lucide-react";
import { useMutation } from "convex/react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Fees, on the dashboard.
 *
 * A teacher picks a month and ticks each student who has paid; a student sees
 * the form his teacher already ticked, as a month calendar they can read but
 * not change. Both read the same rows (convex/fees.ts), so a tick lands on the
 * student's page straight away.
 */
export function FeesPanel({
  names,
  ready,
}: {
  /** The class's roster, from the same sheet attendance uses. */
  names: string[];
  /** False until the deployment has answered who belongs to the class. */
  ready: boolean;
}) {
  const { user } = useAuth();
  const vault = useVault();
  const { isStaff: isTeacher, isLoading: roleLoading } = useViewerIsStaff();
  const { fees, isLoading } = useClassFees(vault.classCode);
  const setFee = useMutation(api.fees.setFee);
  const [month, setMonth] = useState(() => monthKey());
  const [saving, setSaving] = useState<string | null>(null);

  const key = (name: string) => name.trim().toLowerCase();
  const myName = user?.name ?? "You";

  const paidNames = new Set(
    fees
      .filter((fee) => fee.month === month && fee.paid)
      .map((fee) => key(fee.studentName)),
  );
  const roster = useMemo(
    () =>
      [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [names],
  );
  const labels = useMemo(() => shortNames(roster), [roster]);
  const paidCount = roster.filter((name) => paidNames.has(key(name))).length;
  const myPaid = paidNames.has(key(myName));
  const settled = ready && !roleLoading && !isLoading;

  const toggle = async (name: string, paid: boolean) => {
    if (!vault.classCode) {
      toast.error("Open a class first.");
      return;
    }
    setSaving(name);
    try {
      const result = await setFee({
        code: vault.classCode,
        studentName: name,
        month,
        paid,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Could not save that.");
        return;
      }
      const label = labels.get(name) ?? name;
      toast.success(
        paid
          ? `${label} marked paid for ${monthLabel(month)}.`
          : `${label} unmarked for ${monthLabel(month)}.`,
      );
    } catch (error) {
      console.error("Saving a fee mark failed:", error);
      toast.error("Could not save that. Check your connection.");
    } finally {
      setSaving(null);
    }
  };

  // The month grid: Monday-first, with blank cells before the 1st.
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(year, monthNumber, 0).getDate();
  const lead = (new Date(year, monthNumber - 1, 1).getDay() + 6) % 7;
  const today = new Date();
  const isThisMonth = monthKey(today) === month;

  return (
    <section data-tour="dash-fees" className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Wallet className="size-4 text-gold-foreground" />
            Fees
          </h2>
          <p className="text-xs text-muted-foreground">
            {isTeacher
              ? "Tick the students who have paid for the month — it shows on their dashboard straight away."
              : "Your monthly fee record, kept by your teacher. Read-only here."}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous month"
            onClick={() => setMonth((value) => shiftMonth(value, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-36 text-center text-sm font-medium tabular-nums">
            {monthLabel(month)}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next month"
            onClick={() => setMonth((value) => shiftMonth(value, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="p-4">
          {!vault.classCode ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Open a class to track fees.
            </p>
          ) : isTeacher ? (
            /* ------------------------------------------------- the teacher */
            <div className="flex flex-col gap-3">
              <Badge
                variant="outline"
                className="w-fit border-gold/40 bg-gold/15 text-gold-foreground tabular-nums"
              >
                {paidCount} of {roster.length} paid
              </Badge>
              {!settled ? (
                <p className="py-4 text-center text-xs text-muted-foreground">
                  Loading the class list…
                </p>
              ) : roster.length === 0 ? (
                <p className="rounded-lg border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
                  No students on this class's sheet yet — they appear here as
                  soon as they create an account with your class code.
                </p>
              ) : (
                <div className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border/70">
                  {roster.map((name) => {
                    const paid = paidNames.has(key(name));
                    const busy = saving === name;
                    return (
                      <label
                        key={name}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={paid}
                          disabled={busy}
                          onCheckedChange={(value) =>
                            void toggle(name, value === true)
                          }
                          aria-label={`${
                            paid ? "Unmark" : "Mark"
                          } ${name} as paid for ${monthLabel(month)}`}
                        />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {labels.get(name) ?? name}
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-[11px] font-medium",
                            paid ? "text-gold-foreground" : "text-muted-foreground",
                          )}
                        >
                          {paid ? "Paid" : "Not paid"}
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            /* ------------------------------------------------ the student */
            <div className="grid gap-4 sm:grid-cols-[1fr_220px]">
              <div>
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {WEEKDAYS.map((day, index) => (
                    <span key={`${day}-${index}`}>{day}</span>
                  ))}
                </div>
                <div className="mt-1 grid grid-cols-7 gap-1">
                  {Array.from({ length: lead }).map((_, index) => (
                    <span key={`lead-${index}`} />
                  ))}
                  {Array.from({ length: dayCount }).map((_, index) => {
                    const day = index + 1;
                    return (
                      <span
                        key={day}
                        className={cn(
                          "relative flex aspect-square items-center justify-center rounded-md border text-xs tabular-nums",
                          myPaid
                            ? "border-gold/40 bg-gold/15 font-medium text-gold-foreground"
                            : "border-border/60 bg-muted/30 text-muted-foreground",
                          isThisMonth &&
                            day === today.getDate() &&
                            "ring-1 ring-primary/60",
                        )}
                      >
                        {day}
                        {myPaid && (
                          <Check className="absolute top-0.5 right-0.5 size-2.5" />
                        )}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div
                  className={cn(
                    "rounded-xl border px-3 py-3",
                    myPaid
                      ? "border-gold/40 bg-gold/15"
                      : "border-border/70 bg-muted/40",
                  )}
                >
                  <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    Your fees
                  </p>
                  <p
                    className={cn(
                      "mt-1 flex items-center gap-1.5 text-sm font-semibold",
                      myPaid ? "text-gold-foreground" : "text-foreground",
                    )}
                  >
                    {myPaid ? (
                      <>
                        <Check className="size-4" /> Paid
                      </>
                    ) : (
                      "Not marked yet"
                    )}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {monthLabel(month)}
                  </p>
                </div>
                <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                  <Lock className="mt-0.5 size-3 shrink-0" />
                  Only your teacher can change this — it updates here as soon as
                  they tick it.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
