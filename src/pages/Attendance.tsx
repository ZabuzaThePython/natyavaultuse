/**
 * Attendance — the class sheet.
 *
 * One roll per class day: the teacher marks every student, and a student can
 * mark their own row (useful when the teacher isn't holding the roll).
 *
 * The sheet is the whole class: the accounts that joined it on the deployment
 * (`classes.classSheet`), the names its teacher added (`classStudents`), plus
 * anyone this browser's vault already knows about. Marks live on the
 * deployment too (`convex/attendance.ts`), so a teacher's roll and a student's
 * "not attending" note are the same sheet on every device — marks taken in
 * this browser before that existed are moved up on first open.
 *
 * Teachers are not on the sheet and cannot be marked.
 */
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar, CalendarDayButton } from "@/components/ui/calendar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/convex/_generated/api";
import { useClassAttendance, useClassSheet } from "@/lib/classes";
import {
  attendanceSheetNames,
  attendanceSummary,
  formatDate,
  useVault,
  type AttendanceEntry,
  type AttendanceStatus,
} from "@/lib/vault";
import { cn } from "@/lib/utils";
import {
  Ban,
  CalendarCheck,
  CalendarDays,
  Check,
  Clock3,
  Undo2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { useMutation } from "convex/react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

const today = () => new Date().toISOString().slice(0, 10);

/** Students may tell the teacher in advance, so upcoming days are markable. */
const latestMarkableDay = () => {
  const date = new Date();
  date.setDate(date.getDate() + 30);
  return date.toISOString().slice(0, 10);
};

const STATUSES: {
  value: AttendanceStatus;
  label: string;
  icon: typeof Check;
  /** Classes applied to the chip while it is the recorded mark. */
  on: string;
}[] = [
  {
    value: "present",
    label: "Present",
    icon: Check,
    on: "border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground",
  },
  {
    value: "late",
    label: "Late",
    icon: Clock3,
    on: "border-gold bg-gold text-gold-foreground hover:bg-gold hover:text-gold-foreground",
  },
  {
    value: "absent",
    label: "Absent",
    icon: X,
    on: "border-destructive bg-destructive text-white hover:bg-destructive/90 hover:text-white",
  },
  {
    value: "away",
    label: "Not attending",
    icon: Ban,
    on: "border-terracotta bg-terracotta text-white hover:bg-terracotta/90 hover:text-white",
  },
];

const STATUS_LABEL: Record<AttendanceStatus, string> = {
  present: "Present",
  late: "Late",
  absent: "Absent",
  away: "Not attending",
};

/** How a mark reads in the roll. */
function describeMark(
  entry: AttendanceEntry,
  markedBySomeoneElse: boolean,
): string {
  if (entry.status === "away") {
    return markedBySomeoneElse
      ? `Not attending — noted by ${entry.markedBy}`
      : "Not attending — told the teacher";
  }
  return markedBySomeoneElse
    ? `Marked ${STATUS_LABEL[entry.status].toLowerCase()} by ${entry.markedBy}`
    : `Marked ${STATUS_LABEL[entry.status].toLowerCase()} themselves`;
}

/** A Date as `YYYY-MM-DD` in local time (never shifted by the timezone). */
function isoDay(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(
    2,
    "0",
  )}-${String(value.getDate()).padStart(2, "0")}`;
}

function initialsOf(name: string): string {
  const parts = name.split(/[\s._-]+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[1]] : [parts[0] ?? ""])
    .map((part) => part[0] ?? "")
    .join("");
  return letters.slice(0, 2).toUpperCase();
}

export default function Attendance() {
  const { user } = useAuth();
  const vault = useVault();
  const currentName = user?.name ?? "You";
  // Which role this account is comes from the deployment (see `sheet` below),
  // because the vault's role is per browser and would call a student a teacher
  // on a device a teacher signed in on.

  const [date, setDate] = useState(today());
  const [newStudent, setNewStudent] = useState("");

  // Everyone in the class: the accounts that joined it and the names its
  // teacher added (both from the deployment) plus the names this browser
  // already knows about, so a teacher and every student see the same roll. The
  // teacher is never on it.
  const sheet = useClassSheet(vault.classCode);
  const { marks, isLoading: marksLoading } = useClassAttendance(vault.classCode);
  const setMark = useMutation(api.attendance.setMark);
  const clearMark = useMutation(api.attendance.clearMark);
  const addStudent = useMutation(api.attendance.addStudent);
  const removeStudent = useMutation(api.attendance.removeStudent);
  // Who counts as staff, and the marks, are only known from the deployment, so
  // the rows wait for it: that way the teacher can never flash onto a
  // student's sheet.
  const sheetReady = vault.classCode === null || (!sheet.isLoading && !marksLoading);
  // The account's real role for this class: the owner and the admin are the
  // only ones who hold the roll. While the answer is in flight a student is
  // assumed, so the safe default is "you may mark yourself".
  const isTeacher = sheet.viewerIsStaff;
  const { names: roster, blocked } = useMemo(
    () =>
      attendanceSheetNames(vault, {
        accountName: currentName,
        viewerIsTeacher: isTeacher,
        students: sheet.students,
        added: sheet.added,
        teachers: sheet.teachers,
      }),
    [vault, currentName, isTeacher, sheet.students, sheet.added, sheet.teachers],
  );
  // Nothing is listed until the deployment has said who the staff are.
  const visibleRoster = useMemo(
    () => (sheetReady ? roster : []),
    [sheetReady, roster],
  );

  const marked = useMemo(
    () =>
      new Map(
        marks
          .filter((entry) => entry.date === date)
          .map((entry) => [entry.name, entry]),
      ),
    [marks, date],
  );

  const presentCount = visibleRoster.filter(
    (name) => marked.get(name)?.status === "present",
  ).length;
  const lateCount = visibleRoster.filter(
    (name) => marked.get(name)?.status === "late",
  ).length;
  const absentCount = visibleRoster.filter(
    (name) => marked.get(name)?.status === "absent",
  ).length;
  const awayCount = visibleRoster.filter(
    (name) => marked.get(name)?.status === "away",
  ).length;
  const unmarkedCount =
    visibleRoster.length - presentCount - lateCount - absentCount - awayCount;

  // Overall attendance: the class's marks by day, so the teacher can read the
  // month at a glance and open any day's sheet.
  const byDay = useMemo(() => {
    const tally = new Map<
      string,
      { present: number; late: number; absent: number; away: number; total: number }
    >();
    for (const entry of marks) {
      const day = tally.get(entry.date) ?? {
        present: 0,
        late: 0,
        absent: 0,
        away: 0,
        total: 0,
      };
      day[entry.status] += 1;
      day.total += 1;
      tally.set(entry.date, day);
    }
    return tally;
  }, [marks]);
  const emptyDay = {
    present: 0,
    late: 0,
    absent: 0,
    away: 0,
    total: 0,
  };
  const dateSummary = byDay.get(date) ?? emptyDay;
  // Who was in on the day being looked at, and who needs following up. The
  // present list comes first so the whole day reads at a glance, for the
  // teacher and for the students alike.
  const dayNames = useMemo(() => {
    const names = {
      present: [] as string[],
      late: [] as string[],
      absent: [] as string[],
      away: [] as string[],
    };
    for (const entry of marks) {
      if (entry.date !== date) continue;
      names[entry.status].push(entry.name);
    }
    const markedNames = new Set(
      marks
        .filter((entry) => entry.date === date)
        .map((entry) => entry.name.trim().toLowerCase()),
    );
    const unmarked = visibleRoster.filter(
      (name) => !markedNames.has(name.trim().toLowerCase()),
    );
    const byName = (a: string, b: string) => a.localeCompare(b);
    return {
      present: names.present.sort(byName),
      late: names.late.sort(byName),
      absent: names.absent.sort(byName),
      away: names.away.sort(byName),
      unmarked,
    };
  }, [marks, date, visibleRoster]);
  const monthPrefix = date.slice(0, 7);
  const monthDays = [...byDay.entries()].filter(([day]) =>
    day.startsWith(monthPrefix),
  );
  const monthly = {
    days: monthDays.length,
    total: monthDays.reduce((sum, [, counts]) => sum + counts.total, 0),
  };

  const myMark = marked.get(currentName) ?? null;
  const mySummary = attendanceSummary(marks, currentName);
  const addedNames = sheet.added;

  // Anyone on the sheet can be marked — a student marks themselves and keeps
  // the roll for their classmates too. A teacher (or any staff name) is never
  // markable, whoever is looking. Compared case-insensitively so a student is
  // never locked out by a stray capital in a hand-added name.
  const canMark = (name: string) =>
    !blocked.includes(name.trim().toLowerCase());
  // Only the teacher records an absence; a student can still say they won't be
  // coming, and mark themselves and their classmates present or late.
  const canSet = (name: string, status: AttendanceStatus) =>
    canMark(name) && (isTeacher || status !== "absent");

  const mark = async (name: string, status: AttendanceStatus) => {
    if (!vault.classCode) {
      toast.error("Open a class first.");
      return;
    }
    try {
      const result = await setMark({ code: vault.classCode, date, name, status });
      if (!result.ok) {
        toast.error(result.error ?? "Could not save that mark.");
        return;
      }
      toast.success(`${name} marked ${status} for ${formatDate(date)}.`);
    } catch (caught) {
      console.error("Marking attendance failed:", caught);
      toast.error("Could not save that mark. Check your connection.");
    }
  };

  const unmark = async (name: string) => {
    if (!vault.classCode) return;
    try {
      const result = await clearMark({ code: vault.classCode, date, name });
      if (!result.ok) {
        toast.error(result.error ?? "Could not clear that mark.");
        return;
      }
      toast.success(`${name} is unmarked for ${formatDate(date)}.`);
    } catch (caught) {
      console.error("Clearing an attendance mark failed:", caught);
      toast.error("Could not clear that mark. Check your connection.");
    }
  };

  const handleAddStudent = async (event: FormEvent) => {
    event.preventDefault();
    const name = newStudent.trim();
    if (!name) return;
    if (!vault.classCode) {
      toast.error("Open a class first.");
      return;
    }
    try {
      const result = await addStudent({ code: vault.classCode, name });
      if (!result.ok) {
        toast.error(result.error ?? "Could not add that name.");
        return;
      }
      setNewStudent("");
      toast.success(`${name} added to the class list.`);
    } catch (caught) {
      console.error("Adding a student failed:", caught);
      toast.error("Could not add that name. Check your connection.");
    }
  };

  const handleRemoveStudent = async (name: string) => {
    if (!vault.classCode) return;
    try {
      const result = await removeStudent({ code: vault.classCode, name });
      if (!result.ok) {
        toast.error(result.error ?? "Could not remove that name.");
        return;
      }
      toast.success(`${name} removed from the class list.`);
    } catch (caught) {
      console.error("Removing a student failed:", caught);
      toast.error("Could not remove that name. Check your connection.");
    }
  };

  // Marks and added names taken in this browser before they were shared are
  // moved up once per class, so nothing is lost in the switch. The signed-in
  // account becomes the marker of a moved mark (the original is gone with the
  // old local-only data).
  const migratedClass = useRef<string | null>(null);
  useEffect(() => {
    const code = vault.classCode;
    if (!code || !sheetReady || migratedClass.current === code) return;
    migratedClass.current = code;

    const remoteMarks = new Set(
      marks.map((entry) => `${entry.date}|${entry.name.toLowerCase()}`),
    );
    const pendingMarks = vault.attendance.filter(
      (entry) => !remoteMarks.has(`${entry.date}|${entry.name.toLowerCase()}`),
    );
    const remoteNames = new Set(sheet.added.map((name) => name.toLowerCase()));
    const pendingNames = isTeacher
      ? vault.attendanceRoster.filter(
          (name) => !remoteNames.has(name.toLowerCase()),
        )
      : [];
    if (pendingMarks.length === 0 && pendingNames.length === 0) return;

    void (async () => {
      for (const entry of pendingMarks) {
        try {
          await setMark({
            code,
            date: entry.date,
            name: entry.name,
            status: entry.status,
          });
        } catch (caught) {
          console.error("Could not move a mark up:", caught);
        }
      }
      for (const name of pendingNames) {
        try {
          await addStudent({ code, name });
        } catch (caught) {
          console.error("Could not move a class-list name up:", caught);
        }
      }
    })();
  }, [
    vault.classCode,
    vault.attendance,
    vault.attendanceRoster,
    sheetReady,
    marks,
    sheet.added,
    isTeacher,
    setMark,
    addStudent,
  ]);

  const tallies = [
    { label: "Present", value: presentCount, tint: "bg-primary/10 text-primary" },
    { label: "Late", value: lateCount, tint: "bg-gold/25 text-gold-foreground" },
    { label: "Absent", value: absentCount, tint: "bg-destructive/10 text-destructive" },
    {
      label: "Not attending",
      value: awayCount,
      tint: "bg-terracotta/15 text-terracotta",
    },
    { label: "Unmarked", value: unmarkedCount, tint: "bg-muted text-muted-foreground" },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {isTeacher ? "Class roll" : "Class attendance"}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            Attendance
          </h1>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            {isTeacher
              ? "Mark the whole class for the day — tap Present, Late, Absent, or Not attending next to each student."
              : "Mark your classmates Present or Late, mark yourself, or say you can't come — tap the chips next to any name on the sheet."}
          </p>
        </div>
        {isTeacher ? (
          /* A teacher holds the roll for today; the month calendar on the side
             opens any other day. No "class day" picker needed here. */
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Today</span>
            <div className="flex h-9 w-44 items-center rounded-md border border-input bg-muted/40 px-3 text-sm text-muted-foreground">
              {formatDate(date)}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="attendance-date">Class day</Label>
            <Input
              id="attendance-date"
              type="date"
              className="w-44"
              value={date}
              max={latestMarkableDay()}
              onChange={(event) => setDate(event.target.value)}
            />
            <p className="max-w-44 text-[11px] text-muted-foreground">
              Pick an upcoming class to let your teacher know in advance.
            </p>
          </div>
        )}
      </header>

      <section data-tour="attendance-tallies" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {tallies.map(({ label, value, tint }) => (
          <Card key={label} className="gap-2 py-4">
            <CardContent className="flex items-center gap-3 px-4">
              <span
                className={cn(
                  "flex size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold tabular-nums",
                  tint,
                )}
              >
                {value}
              </span>
              <p className="truncate text-xs font-medium text-muted-foreground">
                {label}
              </p>
            </CardContent>
          </Card>
        ))}
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* ------------------------------------------------------- the sheet */}
        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <Users className="size-4 text-gold-foreground" />
                {isTeacher ? "Class roll" : "Who's in class"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {formatDate(date)} · {visibleRoster.length}{" "}
                {visibleRoster.length === 1 ? "person" : "people"} on the sheet
                {isTeacher &&
                  date !== today() &&
                  " · the calendar on the right opens another day"}
              </p>
            </div>
            {isTeacher ? (
              <Badge
                variant="outline"
                className="w-fit border-primary/30 bg-primary/5 text-primary"
              >
                You can mark everyone
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="w-fit border-gold/40 bg-gold/15 text-gold-foreground"
              >
                Mark your classmates, or say you can't come
              </Badge>
            )}
          </div>

          <Card data-tour="attendance-sheet" className="gap-0 py-0">
            <CardContent className="divide-y divide-border/70 p-0">
              {!sheetReady && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  Loading the class list…
                </p>
              )}
              {sheetReady && roster.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  {isTeacher
                    ? "Nobody is on this class's sheet yet — students appear here as soon as they create an account with your class code."
                    : "Your class's sheet is empty — it fills up as your classmates join with the class code."}
                </p>
              )}
              {visibleRoster.map((name) => {
                const entry = marked.get(name);
                const editable = canMark(name);
                return (
                  <div
                    key={name}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                      {initialsOf(name)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {name}
                        {name === currentName && (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry
                          ? describeMark(entry, entry.markedBy !== entry.name)
                          : "Not marked yet"}
                      </p>
                    </div>

                    <div className="flex w-full flex-wrap items-center justify-end gap-1.5 sm:w-auto">
                      {STATUSES.map(({ value, label, icon: Icon, on }) => (
                        <Button
                          key={value}
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!canSet(name, value)}
                          title={
                            editable && !canSet(name, value)
                              ? "Only your teacher records an absence"
                              : undefined
                          }
                          aria-pressed={entry?.status === value}
                          aria-label={`Mark ${name} ${label.toLowerCase()}`}
                          onClick={() => void mark(name, value)}
                          className={cn(
                            "gap-1.5 px-2 sm:px-3",
                            entry?.status === value && on,
                          )}
                        >
                          <Icon className="size-3.5" />
                          <span className="hidden sm:inline">{label}</span>
                        </Button>
                      ))}
                      {entry && editable && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-muted-foreground hover:text-foreground"
                          aria-label={`Clear ${name}'s mark`}
                          title="Clear this mark"
                          onClick={() => void unmark(name)}
                        >
                          <Undo2 className="size-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </section>

        {/* ------------------------------------------------------- side panel */}
        <aside data-tour="attendance-calendar" className="flex flex-col gap-6">
          <Card className="gap-4">
            <CardHeader className="px-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="size-4 text-gold-foreground" />
                Overall attendance
              </CardTitle>
              <CardDescription>
                {monthly.total === 0
                  ? isTeacher
                    ? "No marks recorded yet — the calendar fills in as you mark the class."
                    : "No marks recorded yet — the calendar fills in as your class marks attendance."
                  : `${monthly.total} ${
                      monthly.total === 1 ? "mark" : "marks"
                    } across ${monthly.days} ${
                      monthly.days === 1 ? "class day" : "class days"
                    } this month.`}
              </CardDescription>
            </CardHeader>
              <CardContent className="flex flex-col gap-3 px-5">
                <Calendar
                  mode="single"
                  selected={new Date(`${date}T00:00:00`)}
                  defaultMonth={new Date(`${date}T00:00:00`)}
                  onSelect={(picked) => {
                    if (!picked) return;
                    const iso = `${picked.getFullYear()}-${String(
                      picked.getMonth() + 1,
                    ).padStart(2, "0")}-${String(picked.getDate()).padStart(
                      2,
                      "0",
                    )}`;
                    setDate(iso);
                  }}
                  components={{
                    // The project's own day cell, with the day's mark count
                    // under the date. Kept as a wrapper so the base cell keeps
                    // its selection/today styling and attributes.
                    DayButton: ({ day, ...props }) => {
                      const count = byDay.get(isoDay(day.date))?.total ?? 0;
                      return (
                        <div className="relative">
                          <CalendarDayButton {...props} day={day} />
                          <span
                            className={cn(
                              "pointer-events-none absolute inset-x-0 bottom-0 text-center text-[10px] leading-none",
                              count > 0
                                ? "font-semibold text-gold-foreground"
                                : "text-muted-foreground/40",
                            )}
                          >
                            {count > 0 ? count : "·"}
                          </span>
                        </div>
                      );
                    },
                  }}
                className="w-full [--cell-size:--spacing(10)]"
              />
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  {(["present", "late", "absent", "away"] as const).map(
                    (status) => (
                      <span key={status} className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            status === "present" && "bg-primary",
                            status === "late" && "bg-gold",
                            status === "absent" && "bg-destructive",
                            status === "away" && "bg-terracotta",
                          )}
                        />
                        {STATUS_LABEL[status]}
                      </span>
                    ),
                  )}
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-muted-foreground/30" />
                    Unmarked
                  </span>
                </div>

                {dateSummary.total > 0 && (
                  <div className="flex flex-col gap-2 border-t border-border/70 pt-3">
                    <p className="text-xs font-medium text-muted-foreground">
                      {formatDate(date)} · {dateSummary.total}{" "}
                      {dateSummary.total === 1 ? "mark" : "marks"}
                    </p>
                    {/* Everyone the day knows about, present first. */}
                    {(
                      [
                        [
                          "Present",
                          dayNames.present,
                          "bg-primary",
                          "text-primary",
                        ],
                        [
                          "Late",
                          dayNames.late,
                          "bg-gold",
                          "text-gold-foreground",
                        ],
                        [
                          "Absent",
                          dayNames.absent,
                          "bg-destructive",
                          "text-destructive",
                        ],
                        [
                          "Not attending",
                          dayNames.away,
                          "bg-terracotta",
                          "text-terracotta",
                        ],
                        [
                          "Unmarked",
                          dayNames.unmarked,
                          "bg-muted-foreground/30",
                          "text-muted-foreground",
                        ],
                      ] as const
                    ).map(([label, names, dot, tone]) => (
                      <div
                        key={label}
                        className="flex flex-col gap-1 rounded-lg border border-border/70 bg-background px-3 py-2"
                      >
                        <div className="flex items-center gap-2 text-xs">
                          <span className={cn("size-2 rounded-full", dot)} />
                          <span className="flex-1 font-medium">{label}</span>
                          <span className="font-semibold tabular-nums">
                            {names.length}
                          </span>
                        </div>
                        {names.length > 0 && (
                          <p className={cn("text-xs leading-relaxed", tone)}>
                            {names.join(", ")}
                          </p>
                        )}
                      </div>
                    ))}
                    {monthly.days > 1 && (
                      <div className="mt-1 flex flex-col gap-1.5 border-t border-border/70 pt-2">
                        <p className="text-[11px] font-medium text-muted-foreground">
                          Days with marks
                        </p>
                        {[...byDay.entries()]
                          .sort((a, b) => b[0].localeCompare(a[0]))
                          .slice(0, 6)
                          .map(([day, counts]) => (
                            <button
                              key={day}
                              type="button"
                              onClick={() => setDate(day)}
                              className={cn(
                                "flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs transition-colors hover:bg-muted",
                                day === date && "bg-muted",
                              )}
                            >
                              <span className="flex-1 truncate">
                                {formatDate(day)}
                              </span>
                              <span className="tabular-nums text-muted-foreground">
                                {counts.present}P · {counts.late}L ·{" "}
                                {counts.absent}A
                                {counts.away > 0 && ` · ${counts.away}N`}
                              </span>
                            </button>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

          {isTeacher && (
            <Card className="gap-4">
              <CardHeader className="px-5">
                <CardTitle className="text-base">Class list</CardTitle>
                <CardDescription>
                  Students who create an account with your class code appear
                  here on their own; add anyone else by name.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4 px-5">
                <form
                  onSubmit={handleAddStudent}
                  className="flex flex-col gap-3"
                >
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="add-student">Student name</Label>
                    <Input
                      id="add-student"
                      value={newStudent}
                      onChange={(event) => setNewStudent(event.target.value)}
                      placeholder="e.g. ananya"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={!newStudent.trim()}
                  >
                    <UserPlus />
                    Add to class list
                  </Button>
                </form>

                <div className="flex flex-col gap-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Added by hand
                  </p>
                  {addedNames.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                      Nobody added yet. Students who sign in and mark themselves
                      appear on the roll automatically.
                    </p>
                  ) : (
                    addedNames.map((name) => (
                      <div
                        key={name}
                        className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-background px-3 py-2"
                      >
                        <p className="truncate text-sm">{name}</p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${name} from the class list`}
                          onClick={() => void handleRemoveStudent(name)}
                        >
                          <X className="size-4" />
                        </Button>
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {!isTeacher && (
            <Card className="gap-4">
              <CardHeader className="px-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarCheck className="size-4 text-gold-foreground" />
                  Your month
                </CardTitle>
                <CardDescription>
                  {mySummary.total === 0
                    ? "Nothing marked for you yet this month."
                    : `${mySummary.total} class ${
                        mySummary.total === 1 ? "day" : "days"
                      } marked for you this month.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 px-5">
                {(
                  [
                    ["Present", mySummary.present],
                    ["Late", mySummary.late],
                    ["Not attending", mySummary.away],
                    ["Absent", mySummary.absent],
                  ] as const
                ).map(([label, value]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between rounded-lg border border-border/70 bg-background px-3 py-2"
                  >
                    <p className="text-sm">{label}</p>
                    <span className="text-sm font-semibold tabular-nums">
                      {value}
                    </span>
                  </div>
                ))}
                <p className="mt-1 text-xs text-muted-foreground">
                  {myMark?.status === "away"
                    ? `You've told the class you can't attend on ${formatDate(date)}.`
                    : myMark
                      ? `You are marked ${STATUS_LABEL[myMark.status].toLowerCase()} for ${formatDate(date)}.`
                      : `You haven't marked ${formatDate(date)} yet — pick Present, Late, or Not attending.`}
                </p>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
