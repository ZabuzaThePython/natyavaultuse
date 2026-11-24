import { FeesPanel } from "@/components/fees-panel";
import { MediaRow, VideoDialog } from "@/components/media";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import {
  useClassAttendance,
  useClassSheet,
  useViewerIsStaff,
} from "@/lib/classes";
import { useClassPractice } from "@/lib/practice";
import { useStudioName } from "@/lib/studios";
import { getAdminCreds } from "@/lib/admin";
import {
  attendanceFor,
  attendanceSheetNames,
  formatDate,
  sortByRecency,
  useVault,
  type MediaItem,
} from "@/lib/vault";
import { firstName as firstNameOf, shortNames } from "@/lib/display-name";
import { cn } from "@/lib/utils";
import { vaultItems } from "@/lib/vault-shared";
import {
  ArrowRight,
  CalendarCheck,
  Clock3,
  FolderOpen,
  Music2,
  NotebookPen,
  Trophy,
  Upload,
  Users,
  Video,
} from "lucide-react";
import { useQuery } from "convex/react";
import { useMemo, useState } from "react";
import { Link } from "react-router";

export default function Dashboard() {
  const { user } = useAuth();
  const vault = useVault();
  // The studio on screen names the vault, instead of a generic label.
  const studioName = useStudioName();
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const practiceEnabled = vault.practiceLogEnabled;
  // The account's real role, from the deployment — a student signing in on a
  // browser a teacher used must not inherit the teacher's view.
  const {
    isStaff: isTeacher,
    isPlatformAdmin,
    isLoading: roleLoading,
  } = useViewerIsStaff();
  // The platform admin's accounts, on the page they land on: the same list the
  // Admin area manages. Leaving the Admin page used to leave no accounts list
  // anywhere they looked (the URL goes back to /dashboard), so it lives here
  // too; resetting and deleting stay in the Admin area, one click away.
  //
  // Deliberately deployment-wide, with no studio filter: this is the operator's
  // view of every account. Scoped to the studio picked in the shell, the list
  // changed — and looked empty — whenever that picker moved.
  const adminCreds = getAdminCreds() ?? { username: "", password: "" };
  const accounts = useQuery(
    api.admin.listAccounts,
    isPlatformAdmin
      ? { adminUsername: adminCreds.username, adminPassword: adminCreds.password }
      : "skip",
  );

  // The vault shelf is shared with the class (see convex/vault.ts), so recent
  // media here includes what dancemates uploaded, not only this browser.
  const sharedMedia = useQuery(api.vault.classMedia, {
    code: vault.classCode ?? "",
  });
  const allMedia = useMemo(
    () => vaultItems(vault.media, sharedMedia?.ok ? sharedMedia.items : []),
    [vault.media, sharedMedia],
  );

  const recentMedia = useMemo(() => sortByRecency(allMedia).slice(0, 6), [allMedia]);
  // Sessions come from the deployment (one log shared by the class), not from
  // this browser — see convex/practice.ts.
  const practice = useClassPractice(vault.classCode);
  const authorKey = user?.name ?? "You";
  // Teachers see every student's sessions; a student sees only their own.
  const visibleLogs = useMemo(
    () =>
      isTeacher
        ? practice.entries
        : practice.entries.filter((l) => l.mine),
    [practice.entries, isTeacher],
  );
  const recentLogs = useMemo(
    () =>
      [...visibleLogs]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 4),
    [visibleLogs],
  );
  const recentLogLabels = useMemo(
    () => shortNames(recentLogs.map((log) => log.author)),
    [recentLogs],
  );

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const minutesThisWeek = visibleLogs
    .filter((l) => new Date(`${l.date}T00:00:00`) >= weekAgo)
    .reduce((sum, l) => sum + l.minutes, 0);

  const audioCount = allMedia.filter((m) => m.kind === "audio").length;
  const videoCount = allMedia.filter((m) => m.kind === "video").length;
  const unfiledCount = allMedia.filter((m) => !m.folderId).length;

  // Attendance for today: the same class-wide sheet the Attendance page uses,
  // so the counts line up for the teacher and the students alike.
  const todayIso = new Date().toISOString().slice(0, 10);
  const sheet = useClassSheet(vault.classCode);
  const { marks, isLoading: marksLoading } = useClassAttendance(vault.classCode);
  // Staff names, the marks, and the viewer's own role come from the
  // deployment, so hold the count back until they answer — otherwise a
  // teacher could be counted as a student for a moment.
  const sheetReady =
    vault.classCode === null ||
    (!sheet.isLoading && !marksLoading && !roleLoading);
  const rosterNames = useMemo(
    () =>
      sheetReady
        ? attendanceSheetNames(vault, {
            accountName: authorKey,
            viewerIsTeacher: isTeacher,
            students: sheet.students,
            added: sheet.added,
            teachers: sheet.teachers,
          }).names
        : [],
    [
      vault,
      authorKey,
      isTeacher,
      sheet.students,
      sheet.added,
      sheet.teachers,
      sheetReady,
    ],
  );
  const presentToday = rosterNames.filter(
    (name) => attendanceFor(marks, todayIso, name)?.status === "present",
  ).length;
  const unmarkedToday = rosterNames.filter(
    (name) => attendanceFor(marks, todayIso, name) === null,
  ).length;

  // Minutes practised per person over the last 30 days, biggest first.
  const leaderboard = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const totals = new Map<string, number>();
    for (const log of practice.entries) {
      if (new Date(`${log.date}T00:00:00`) < cutoff) continue;
      totals.set(log.author, (totals.get(log.author) ?? 0) + log.minutes);
    }
    return [...totals.entries()]
      .map(([name, minutes]) => ({ name, minutes }))
      .sort((a, b) => b.minutes - a.minutes);
  }, [practice.entries]);
  const topMinutes = leaderboard[0]?.minutes ?? 0;
  const leaderboardLabels = useMemo(
    () => shortNames(leaderboard.map((row) => row.name)),
    [leaderboard],
  );

  const firstName = firstNameOf(user?.name ?? "dancer");

  const stats = [
    {
      label: "In the vault",
      value: `${allMedia.length}`,
      detail: `${audioCount} audio · ${videoCount} video`,
      icon: Music2,
      tint: "bg-gold/25 text-gold-foreground",
      edge: "border-l-gold",
    },
    {
      label: "Practiced this week",
      value: `${minutesThisWeek} min`,
      detail: "",
      icon: Clock3,
      tint: "bg-primary/10 text-primary",
      edge: "border-l-primary",
    },
    {
      label: "Folders",
      value: `${vault.folders.length}`,
      detail: `${unfiledCount} unfiled file${unfiledCount === 1 ? "" : "s"}`,
      icon: FolderOpen,
      tint: "bg-terracotta/15 text-terracotta",
      edge: "border-l-terracotta",
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {studioName ? `Namaste, ${firstName}` : "Personal vault"}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            {studioName ?? `Namaste, ${firstName}`}
          </h1>
        </div>
        <div className="flex flex-wrap gap-2" data-tour="dash-actions">
          {isTeacher ? (
            <Button type="button" variant="outline" asChild>
              <Link to="/dashboard/practice">
                <NotebookPen />
                Review practice
              </Link>
            </Button>
          ) : practiceEnabled ? (
            <Button type="button" variant="outline" asChild>
              <Link to="/dashboard/practice">
                <NotebookPen />
                Log practice
              </Link>
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled
              title="The Practice Log is disabled by the admin"
            >
              <NotebookPen />
              Log practice
            </Button>
          )}
          <Button type="button" variant="outline" asChild>
            <Link to="/dashboard/attendance">
              <CalendarCheck />
              Attendance
            </Link>
          </Button>
          <Button type="button" asChild>
            <Link to="/dashboard/vault">
              <Upload />
              Upload media
            </Link>
          </Button>
        </div>
      </header>

      <section
        data-tour="dash-stats"
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        {stats.map(({ label, value, detail, icon: Icon, tint, edge }) => (
          <Card key={label} className={`gap-3 border-l-4 py-4 ${edge}`}>
            <CardContent className="flex items-start gap-3 px-4">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tint}`}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
                <p className="text-xl font-semibold tracking-tight tabular-nums">
                  {value}
                </p>
                {detail && (
                  <p className="truncate text-xs text-muted-foreground">
                    {detail}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))}

        {/* attendance today — tap through to the class sheet */}
        <Link
          to="/dashboard/attendance"
          className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          aria-label="Open the attendance sheet"
        >
          <Card className="h-full gap-3 border-l-4 border-l-terracotta py-4 transition-colors hover:border-terracotta/60">
            <CardContent className="flex items-start gap-3 px-4">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-terracotta/15 text-terracotta">
                <CalendarCheck className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  Attendance today
                </p>
                <p className="text-xl font-semibold tracking-tight tabular-nums">
                  {presentToday}/{rosterNames.length}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {unmarkedToday === 0
                    ? "Everyone marked"
                    : `${unmarkedToday} still to mark`}
                </p>
              </div>
            </CardContent>
          </Card>
        </Link>
      </section>

      {/* The studio's accounts, for the operator. The Admin area is where they
          are managed; this is where they are seen. */}
      {isPlatformAdmin ? (
        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                <Users className="size-4 text-gold-foreground" />
                Accounts
              </h2>
              <p className="text-xs text-muted-foreground">
                Everyone who can sign in to NatyaVault, in every studio.
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" asChild>
              <Link to="/dashboard/admin">Manage accounts</Link>
            </Button>
          </div>
          <Card className="gap-0 py-0">
            <CardContent className="divide-y divide-border/70 p-0">
              {accounts === undefined ? (
                <p className="px-4 py-5 text-center text-xs text-muted-foreground">
                  Loading accounts…
                </p>
              ) : accounts.length === 0 ? (
                <p className="px-4 py-5 text-center text-xs text-muted-foreground">
                  No accounts to show.
                </p>
              ) : (
                accounts.map((account) => (
                  <div
                    key={account.id}
                    className="flex flex-wrap items-center gap-3 px-4 py-2.5"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
                      {account.username.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {account.username}
                      </p>
                      {account.fullName &&
                        account.fullName !== account.username && (
                          <p className="truncate text-xs text-muted-foreground">
                            {account.fullName}
                          </p>
                        )}
                    </div>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {account.isAdmin
                        ? "Admin"
                        : account.isTeacher
                          ? "Teacher"
                          : "Student"}
                    </span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      {/* Monthly fees: the teacher's ticks, or the student's own calendar. */}
      <FeesPanel names={rosterNames} ready={sheetReady} />

      {/* ------------------------------------------------------ leaderboard */}
      <section data-tour="dash-leaderboard" className="flex flex-col gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
            <Trophy className="size-4 text-gold-foreground" />
            Leaderboard
          </h2>
          <p className="text-xs text-muted-foreground">
            Minutes practised in the last 30 days
          </p>
        </div>

        {leaderboard.length === 0 ? (
          <Card className="py-8 text-center">
            <CardContent className="text-xs text-muted-foreground">
              No practice logged in the last 30 days yet.
            </CardContent>
          </Card>
        ) : (
          <Card className="gap-0 py-0">
            <CardContent className="divide-y divide-border/70 p-0">
              {leaderboard.map((row, index) => (
                <div
                  key={row.name}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <span
                    className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${
                      index === 0
                        ? "bg-gold/30 text-gold-foreground"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">
                        {leaderboardLabels.get(row.name) ?? row.name}
                      </p>
                      <span className="shrink-0 text-xs font-semibold tabular-nums">
                        {row.minutes} min
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gold"
                        style={{
                          width: `${
                            topMinutes
                              ? Math.max(
                                  4,
                                  Math.round((row.minutes / topMinutes) * 100),
                                )
                              : 0
                          }%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Recent media — the first thing on the screen */}
        <section
          data-tour="dash-recent"
          className="flex flex-col gap-3 lg:col-span-2"
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                Recent media
              </h2>
              <p className="text-xs text-muted-foreground">
                Your newest uploads and practice tracks, newest first
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" asChild>
              <Link to="/dashboard/vault">
                View all
                <ArrowRight />
              </Link>
            </Button>
          </div>

          {recentMedia.length === 0 ? (
            <Card className="items-center gap-3 py-10 text-center">
              <CardContent className="flex flex-col items-center gap-3 px-6">
                <span className="flex size-11 items-center justify-center rounded-full bg-muted">
                  <Video className="size-5 text-muted-foreground" />
                </span>
                <div>
                  <p className="text-sm font-medium">The vault is empty</p>
                  <p className="text-xs text-muted-foreground">
                    Upload the first practice track or dance clip to get started.
                  </p>
                </div>
                <Button type="button" size="sm" asChild>
                  <Link to="/dashboard/vault">Open media vault</Link>
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {recentMedia.map((item) => (
                <MediaRow key={item.id} item={item} onPlay={setPlaying} />
              ))}
            </div>
          )}
        </section>

        {/* Recent practice logs — greyed out while the admin has it disabled */}
        <section
          data-tour="dash-practice"
          aria-disabled={!practiceEnabled && !isTeacher}
          className={cn(
            "flex flex-col gap-3",
            !practiceEnabled &&
              !isTeacher &&
              "pointer-events-none opacity-50 select-none",
          )}
        >
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-base font-semibold tracking-tight">
                {isTeacher ? "Student practice" : "Practice log"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {isTeacher
                  ? "Latest sessions from your students"
                  : "Your latest practice sessions"}
              </p>
            </div>
            {practiceEnabled || isTeacher ? (
              <Button type="button" variant="ghost" size="sm" asChild>
                <Link to="/dashboard/practice">
                  Open
                  <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled
                title="The Practice Log is disabled by the admin"
              >
                Open
                <ArrowRight />
              </Button>
            )}
          </div>

          <Card className="gap-0 py-0">
            <CardContent className="divide-y divide-border/70 p-0">
              {recentLogs.length === 0 && (
                <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                  No practice logged yet.
                </p>
              )}
              {recentLogs.map((log) => (
                <div key={log.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium">{log.item}</p>
                    <span className="shrink-0 rounded-full bg-gold/25 px-2 py-0.5 text-[11px] font-medium text-gold-foreground tabular-nums">
                      {log.minutes} min
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {formatDate(log.date)}
                    {isTeacher &&
                      ` · ${recentLogLabels.get(log.author) ?? log.author}`}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      </div>

      <VideoDialog
        item={playing}
        open={playing !== null}
        onOpenChange={(open) => {
          if (!open) setPlaying(null);
        }}
      />
    </div>
  );
}
