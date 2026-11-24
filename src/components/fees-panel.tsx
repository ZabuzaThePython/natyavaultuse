import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useViewerIsStaff } from "@/lib/classes";
import { shortNames } from "@/lib/display-name";
import { monthKey, useClassFees, type FeeMark } from "@/lib/fees";
import { useVault } from "@/lib/vault";
import { cn } from "@/lib/utils";
import { Check, ChevronLeft, ChevronRight, Lock, Wallet } from "lucide-react";
import { useMutation } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** One cell of the grid: a student's month. */
const cellKey = (name: string, month: string) =>
  `${name.trim().toLowerCase()}|${month}`;

/**
 * The last fee board this tab saw, per class.
 *
 * Coming back to the dashboard starts the query again, and while it was
 * unanswered the table was replaced by "Loading the class list…" — which is
 * what the students going missing looked like. The last board stays up, and a
 * fresh answer always replaces it.
 */
const lastFeeBoards = new Map<string, FeeMark[]>();

/**
 * Fees, on the dashboard — a year at a glance.
 *
 * Months run across the top, students down the side, and each cell is one
 * student's fee for that month. A teacher taps a cell to tick it; the tick
 * lands on that student's own dashboard, whose view is the same grid narrowed
 * to their one row, read-only. Both read the same rows (convex/fees.ts).
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
  const feesKey = vault.classCode ?? "none";
  // The board from the last visit to this class, shown while a fresh one is on
  // its way.
  const keptFees = lastFeeBoards.get(feesKey);
  useEffect(() => {
    if (!isLoading) lastFeeBoards.set(feesKey, fees);
  }, [fees, isLoading, feesKey]);
  const board = isLoading && keptFees !== undefined ? keptFees : fees;
  const setFee = useMutation(api.fees.setFee);
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [saving, setSaving] = useState<string | null>(null);

  const key = (name: string) => name.trim().toLowerCase();
  const myName = user?.name ?? "You";
  const now = new Date();
  const thisMonth = monthKey(now);

  const columns = useMemo(
    () =>
      MONTHS.map(
        (_, index) => `${year}-${String(index + 1).padStart(2, "0")}`,
      ),
    [year],
  );
  // Every tick on the board, so a row reads its own cells without scanning.
  const paidCells = new Set(
    board.filter((fee) => fee.paid).map((fee) => cellKey(fee.studentName, fee.month)),
  );
  const roster = useMemo(
    () =>
      [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort(
        (a, b) => a.localeCompare(b),
      ),
    [names],
  );
  const labels = useMemo(() => shortNames(roster), [roster]);
  // A student sees only their own row; their name is matched the way the rows
  // are stored, so a teacher's tick is found even if the capitals differ.
  const myRow = roster.find((name) => key(name) === key(myName)) ?? myName;
  const rows = isTeacher ? roster : [myRow];
  const paidThisMonth = roster.filter((name) =>
    paidCells.has(cellKey(name, thisMonth)),
  ).length;
  const myMonthsPaid = columns.filter((month) =>
    paidCells.has(cellKey(myRow, month)),
  ).length;
  // Show the table as soon as there is a roster or a board to show: a fresh
  // answer arriving late must not be able to empty a list that was just on
  // screen.
  const settled =
    (ready || roster.length > 0) &&
    !roleLoading &&
    (!isLoading || keptFees !== undefined);

  const toggle = async (name: string, month: string, paid: boolean) => {
    if (!vault.classCode) {
      toast.error("Open a class first.");
      return;
    }
    const cell = cellKey(name, month);
    setSaving(cell);
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
      const monthLabel = new Date(
        Number(month.slice(0, 4)),
        Number(month.slice(5, 7)) - 1,
        1,
      ).toLocaleDateString(undefined, { month: "long", year: "numeric" });
      toast.success(
        paid
          ? `${label} marked paid for ${monthLabel}.`
          : `${label} unmarked for ${monthLabel}.`,
      );
    } catch (error) {
      console.error("Saving a fee mark failed:", error);
      toast.error("Could not save that. Check your connection.");
    } finally {
      setSaving(null);
    }
  };

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
              ? "Months across the top, students down the side — tap a cell to tick that month as paid."
              : "Months across the top, your name down the side — ticked by your teacher, read-only here."}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Previous year"
            onClick={() => setYear((value) => value - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-16 text-center text-sm font-medium tabular-nums">
            {year}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="Next year"
            onClick={() => setYear((value) => value + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <Card className="gap-0 py-0">
        <CardContent className="flex flex-col gap-3 p-4">
          {!vault.classCode ? (
            <p className="py-4 text-center text-xs text-muted-foreground">
              Open a class to track fees.
            </p>
          ) : isTeacher ? (
            /* ------------------------------------------------- the teacher */
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-gold/40 bg-gold/15 text-gold-foreground tabular-nums"
                >
                  {year === now.getFullYear()
                    ? `${paidThisMonth} of ${roster.length} paid in ${
                        MONTHS[now.getMonth()]
                      }`
                    : `${roster.length} students in ${year}`}
                </Badge>
                <span className="text-[11px] text-muted-foreground">
                  Tap a cell to tick it, tap again to undo.
                </span>
              </div>
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
                <div className="-mx-1 overflow-x-auto">
                  <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-xs">
                    <thead>
                      <tr>
                        <th
                          scope="col"
                          className="sticky left-0 z-10 bg-card px-2 py-2 text-left text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"
                        >
                          Student
                        </th>
                        {MONTHS.map((label, index) => (
                          <th
                            key={label}
                            scope="col"
                            className={cn(
                              "px-0.5 py-2 text-center text-[10px] font-semibold uppercase",
                              columns[index] === thisMonth
                                ? "text-gold-foreground"
                                : "text-muted-foreground",
                            )}
                          >
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((name) => (
                        <tr key={name}>
                          <th
                            scope="row"
                            className="sticky left-0 z-10 max-w-32 truncate border-t border-border/60 bg-card px-2 py-1.5 text-left text-xs font-medium"
                          >
                            {labels.get(name) ?? name}
                          </th>
                          {columns.map((month) => {
                            const paid = paidCells.has(cellKey(name, month));
                            const busy = saving === cellKey(name, month);
                            const monthName = `${MONTHS[Number(month.slice(5, 7)) - 1]} ${year}`;
                            return (
                              <td
                                key={month}
                                className="border-t border-border/60 px-0.5 py-1 text-center"
                              >
                                <button
                                  type="button"
                                  disabled={busy}
                                  aria-pressed={paid}
                                  aria-label={`${
                                    paid ? "Unmark" : "Mark"
                                  } ${name} as paid for ${monthName}`}
                                  title={`${name} · ${monthName}`}
                                  onClick={() => void toggle(name, month, !paid)}
                                  className={cn(
                                    "mx-auto flex size-7 items-center justify-center rounded-md border transition-colors",
                                    paid
                                      ? "border-gold/50 bg-gold/20 text-gold-foreground"
                                      : "border-border/60 text-muted-foreground/40 hover:border-gold/50 hover:bg-gold/10",
                                    busy && "opacity-40",
                                  )}
                                >
                                  {paid ? (
                                    <Check className="size-3.5" />
                                  ) : (
                                    <span className="size-1 rounded-full bg-current" />
                                  )}
                                </button>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                      <tr>
                        <th
                          scope="row"
                          className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"
                        >
                          Paid
                        </th>
                        {columns.map((month) => {
                          const count = roster.filter((name) =>
                            paidCells.has(cellKey(name, month)),
                          ).length;
                          return (
                            <td
                              key={month}
                              className="px-0.5 py-1.5 text-center text-[11px] tabular-nums text-muted-foreground"
                            >
                              {count > 0 ? count : "·"}
                            </td>
                          );
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            /* ------------------------------------------------- the student */
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className={cn(
                    "tabular-nums",
                    paidCells.has(cellKey(myRow, thisMonth))
                      ? "border-gold/40 bg-gold/15 text-gold-foreground"
                      : "border-border/70 bg-muted/40 text-muted-foreground",
                  )}
                >
                  {paidCells.has(cellKey(myRow, thisMonth))
                    ? `Paid for ${MONTHS[now.getMonth()]} ${now.getFullYear()}`
                    : `Not marked yet for ${MONTHS[now.getMonth()]} ${now.getFullYear()}`}
                </Badge>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {myMonthsPaid} of 12 months paid in {year}
                </span>
              </div>
              <div className="-mx-1 overflow-x-auto">
                <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-xs">
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="sticky left-0 z-10 bg-card px-2 py-2 text-left text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase"
                      >
                        You
                      </th>
                      {MONTHS.map((label, index) => (
                        <th
                          key={label}
                          scope="col"
                          className={cn(
                            "px-0.5 py-2 text-center text-[10px] font-semibold uppercase",
                            columns[index] === thisMonth
                              ? "text-gold-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th
                        scope="row"
                        className="sticky left-0 z-10 max-w-32 truncate border-t border-border/60 bg-card px-2 py-1.5 text-left text-xs font-medium"
                      >
                        {labels.get(myRow) ?? myRow}
                      </th>
                      {columns.map((month) => {
                        const paid = paidCells.has(cellKey(myRow, month));
                        const monthName = `${MONTHS[
                          Number(month.slice(5, 7)) - 1
                        ]} ${year}`;
                        return (
                          <td
                            key={month}
                            className="border-t border-border/60 px-0.5 py-1 text-center"
                          >
                            <span
                              title={`${monthName}: ${
                                paid ? "paid" : "not marked"
                              }`}
                              aria-label={`${monthName}: ${
                                paid ? "paid" : "not marked"
                              }`}
                              className={cn(
                                "mx-auto flex size-7 items-center justify-center rounded-md border",
                                paid
                                  ? "border-gold/50 bg-gold/20 text-gold-foreground"
                                  : "border-border/50 text-muted-foreground/30",
                              )}
                            >
                              {paid ? (
                                <Check className="size-3.5" />
                              ) : (
                                <span className="size-1 rounded-full bg-current" />
                              )}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
                <Lock className="mt-0.5 size-3 shrink-0" />
                Only your teacher can change this — a tick appears here as soon
                as they record that month.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
