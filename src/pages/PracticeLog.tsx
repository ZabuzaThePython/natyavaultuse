import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import { useViewerIsStaff } from "@/lib/classes";
import { useClassPractice, type PracticeEntryView } from "@/lib/practice";
import { shortNames } from "@/lib/display-name";
import { formatDate, useVault } from "@/lib/vault";
import { useMutation } from "convex/react";
import { CalendarDays, Clock3, Lock, Plus, Trash2, Users } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

const today = () => new Date().toISOString().slice(0, 10);

/** Time windows the teacher can review. */
type Range = "week" | "month" | "year" | "all";

const RANGES: { value: Range; label: string }[] = [
  { value: "week", label: "Last week" },
  { value: "month", label: "Last month" },
  { value: "year", label: "Last year" },
  { value: "all", label: "Lifetime" },
];

/** Earliest date (YYYY-MM-DD) included in a range; null = no cutoff. */
function cutoffFor(range: Range): string | null {
  const d = new Date();
  if (range === "week") d.setDate(d.getDate() - 7);
  else if (range === "month") d.setMonth(d.getMonth() - 1);
  else if (range === "year") d.setFullYear(d.getFullYear() - 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

export default function PracticeLog() {
  const vault = useVault();
  const enabled = vault.practiceLogEnabled;
  // Sessions come from the deployment, so the whole class shares one log: a
  // teacher sees every student's practice, and none of it is lost when a
  // browser is cleared.
  const practice = useClassPractice(vault.classCode);
  const logs = practice.entries;
  const addEntry = useMutation(api.practice.addEntry);
  const removeEntry = useMutation(api.practice.removeEntry);

  // Teachers review every student's sessions instead of logging their own.
  // The deployment decides who is staff, not the role stored in this browser.
  const { isStaff: isTeacher } = useViewerIsStaff();

  const [date, setDate] = useState(today());
  const [minutes, setMinutes] = useState("45");
  const [item, setItem] = useState("");
  const [saving, setSaving] = useState(false);
  // Teachers start on the last week; a student's own log opens on everything.
  // `null` means "not chosen yet": the default is applied once the deployment
  // has told us the role, and the picker's own choice wins from then on.
  const [range, setRange] = useState<Range | null>(null);
  const activeRange: Range = range ?? (isTeacher ? "week" : "all");

  // The deployment marks each row with whether this account logged it.
  const myLogs = useMemo(
    () => logs.filter((l) => l.mine),
    [logs],
  );

  // Teacher view: every student's entries inside the chosen window.
  const teacherLogs = useMemo(() => {
    const cutoff = cutoffFor(activeRange);
    const scoped = cutoff
      ? logs.filter((l) => l.date >= cutoff)
      : logs;
    return [...scoped].sort(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt,
    );
  }, [logs, activeRange]);

  // The student's own entries inside the chosen window.
  const entries = useMemo(() => {
    const cutoff = cutoffFor(activeRange);
    const scoped = cutoff
      ? myLogs.filter((l) => l.date >= cutoff)
      : myLogs;
    return [...scoped].sort(
      (a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt,
    );
  }, [myLogs, activeRange]);

  const minutesInRange = entries.reduce((sum, l) => sum + l.minutes, 0);

  const teacherMinutes = teacherLogs.reduce((sum, l) => sum + l.minutes, 0);
  const teacherStudents = new Set(teacherLogs.map((l) => l.author)).size;
  // Students are listed by first name, with a last initial when two of them
  // share one (see lib/display-name).
  const authorLabels = useMemo(
    () => shortNames(teacherLogs.map((log) => log.author)),
    [teacherLogs],
  );
  const rangeLabel =
    RANGES.find((r) => r.value === activeRange)?.label.toLowerCase() ?? "";

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!enabled) {
      toast.error("The Practice Log is currently disabled by the admin.");
      return;
    }
    if (!vault.classCode) {
      toast.error("Open a class first — sessions belong to your class.");
      return;
    }
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) {
      toast.error("Enter how many minutes you practiced.");
      return;
    }
    if (!item.trim()) {
      toast.error("Type the item you practised.");
      return;
    }
    setSaving(true);
    try {
      const result = await addEntry({
        code: vault.classCode,
        date,
        minutes: Math.round(value),
        item: item.trim(),
      });
      if (!result.ok) {
        toast.error(result.error ?? "Could not save that session.");
        return;
      }
      setItem("");
      toast.success("Practice session logged.");
    } catch (caught) {
      console.error("Log practice failed:", caught);
      toast.error("Could not save that session. Check your connection.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: PracticeEntryView["id"]) => {
    try {
      const result = await removeEntry({ id });
      if (!result.ok) {
        toast.error(result.error ?? "Could not remove that session.");
        return;
      }
      toast.success("Log entry removed.");
    } catch (caught) {
      console.error("Remove practice entry failed:", caught);
      toast.error("Could not remove that session. Check your connection.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Practice Log
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isTeacher
            ? "Every student's practice sessions — choose a time range to review."
            : "Record every session — date, duration, and the item you practised. Only your own entries appear here."}
        </p>
      </header>

      {!enabled && !isTeacher && (
        <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-muted px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
            <Lock className="size-4" />
          </span>
          <div>
            <p className="text-sm font-medium">Practice Log is turned off</p>
            <p className="text-xs text-muted-foreground">
              An admin has disabled practice logging for everyone. Posting new
              entries is unavailable until it is switched back on.
            </p>
          </div>
        </div>
      )}

      <div
        aria-disabled={!enabled && !isTeacher}
        className={`grid gap-6 ${
          isTeacher ? "" : "lg:grid-cols-[360px_1fr]"
        } ${
          enabled || isTeacher
            ? ""
            : "pointer-events-none opacity-50 select-none"
        }`}
      >
        {/* ------------------------------------------------- log form (students) */}
        {!isTeacher && (
          <Card
            data-tour="practice-form"
            className="h-fit gap-5 lg:sticky lg:top-20"
          >
            <CardHeader className="px-5">
              <CardTitle className="text-base">Log a practice</CardTitle>
              <CardDescription>Date, duration, and item.</CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="log-date">Date</Label>
                    <Input
                      id="log-date"
                      type="date"
                      value={date}
                      max={today()}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="log-minutes">Duration (min)</Label>
                    <Input
                      id="log-minutes"
                      type="number"
                      min={1}
                      max={600}
                      value={minutes}
                      onChange={(e) => setMinutes(e.target.value)}
                      placeholder="45"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="log-item">Item name</Label>
                  <Input
                    id="log-item"
                    value={item}
                    onChange={(e) => setItem(e.target.value)}
                    placeholder="e.g. Alarippu, Varnam, adavu drills…"
                    required
                  />
                </div>

                <Button
                  data-tour="practice-post"
                  type="submit"
                  disabled={saving || !enabled}
                  className="w-full"
                >
                  <Plus />
                  {saving ? "Saving…" : "Post entry"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {/* ---------------------------------------------------- entries */}
        <section data-tour="practice-entries" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                {isTeacher && <Users className="size-4 text-gold-foreground" />}
                {isTeacher ? "All student entries" : "Your entries"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {isTeacher ? (
                  <>
                    {teacherLogs.length} session
                    {teacherLogs.length === 1 ? "" : "s"} · {teacherStudents}{" "}
                    student{teacherStudents === 1 ? "" : "s"} ·{" "}
                    {teacherMinutes} min in {rangeLabel}
                  </>
                ) : (
                  <>
                    {entries.length} session
                    {entries.length === 1 ? "" : "s"} · {minutesInRange} min in{" "}
                    {rangeLabel}
                  </>
                )}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {!isTeacher && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gold/25 px-3 py-1 text-xs font-medium text-gold-foreground">
                  <Clock3 className="size-3.5" />
                  {minutesInRange} min
                </span>
              )}
              <div
                data-tour="practice-range"
                className="flex flex-wrap gap-1 rounded-lg bg-muted p-1"
              >
                {RANGES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={activeRange === option.value}
                    onClick={() => setRange(option.value)}
                    className={
                      activeRange === option.value
                        ? "rounded-md bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm"
                        : "rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {practice.isLoading ? (
            <Card className="py-8 text-center">
              <CardContent className="text-xs text-muted-foreground">
                Loading your class's log…
              </CardContent>
            </Card>
          ) : (isTeacher ? teacherLogs : entries).length === 0 ? (
            <Card className="items-center gap-3 py-10 text-center">
              <CardContent className="flex flex-col items-center gap-3 px-6">
                <span className="flex size-11 items-center justify-center rounded-full bg-muted">
                  <CalendarDays className="size-5 text-muted-foreground" />
                </span>
                <div>
                  <p className="text-sm font-medium">No entries yet</p>
                  <p className="text-xs text-muted-foreground">
                    {isTeacher
                      ? "No student logged a session in this range."
                      : "No sessions logged in this range."}
                  </p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {(isTeacher ? teacherLogs : entries).map((log) => (
                <Card key={log.id} className="gap-0 py-0">
                  <CardContent className="flex items-start gap-3 px-4 py-3.5">
                    <span className="flex size-9 shrink-0 flex-col items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <span className="text-[13px] leading-none font-semibold tabular-nums">
                        {log.minutes}
                      </span>
                      <span className="mt-0.5 text-[9px] leading-none uppercase">
                        min
                      </span>
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p className="text-sm font-medium">{log.item}</p>
                        <span className="text-xs text-muted-foreground">
                          {formatDate(log.date)}
                        </span>
                        {isTeacher && (
                          <Badge
                            variant="secondary"
                            className="px-1.5 text-[11px]"
                          >
                            {authorLabels.get(log.author) ?? log.author}
                          </Badge>
                        )}
                      </div>
                    </div>
                    {!isTeacher && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        disabled={!enabled}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label="Delete entry"
                        onClick={() => handleDelete(log.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
