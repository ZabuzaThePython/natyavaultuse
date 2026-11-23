import { AddToHomeScreenDialog } from "@/components/AddToHomeScreenDialog";
import { AdminDiagnostics } from "@/components/admin-diagnostics";
import { FullNamePrompt } from "@/components/full-name-prompt";
import { StudioPrompt } from "@/components/studio-prompt";
import { NotificationsPrompt } from "@/components/notifications-prompt";
import { TourSpotlight } from "@/components/tour-spotlight";
import { Om } from "@/components/Om";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { useIsAdmin, lockAdmin } from "@/lib/admin";
import { useBuildWatcher } from "@/lib/build-watch";
import { recordDiagnosis, storageProbe } from "@/lib/admin-diagnostics";
import { forgetRoles } from "@/lib/role-memory";
import {
  markLocalPracticeImported,
  pendingLocalPractice,
} from "@/lib/practice";
import { cn } from "@/lib/utils";
import {
  classKey,
  useAllClasses,
  useClasses,
  useViewerIsStaff,
} from "@/lib/classes";
import {
  useActiveStudio,
  useMyStudio,
  useStudioName,
  useStudios,
} from "@/lib/studios";
import { rememberAccount } from "@/lib/last-account";
import { firstName } from "@/lib/display-name";
import {
  setActiveClass,
  setPracticeLogEnabled,
  setRole,
  useVault,
} from "@/lib/vault";
import { rearmInstallPrompt } from "@/lib/install";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  CalendarCheck,
  Disc3,
  GraduationCap,
  Layers,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquareText,
  Moon,
  NotebookPen,
  Sun,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";

const NAV_ITEMS = [
  { path: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { path: "/dashboard/practice", label: "Practice Log", icon: NotebookPen },
  { path: "/dashboard/attendance", label: "Attendance", icon: CalendarCheck },
  { path: "/dashboard/vault", label: "Media Vault", icon: Disc3 },
  { path: "/dashboard/messages", label: "Messages", icon: MessageSquareText },
];

/** Only teachers and an unlocked admin see class management in the nav. */
const CLASSES_ITEM = {
  path: "/dashboard/classes",
  label: "Classes",
  icon: Layers,
};

/** The studio above the classes: its teachers, join code and class list. */
const STUDIO_ITEM = {
  path: "/dashboard/studio",
  label: "Studio",
  icon: GraduationCap,
};

/**
 * Which class is on screen. A teacher running several classes switches here;
 * a student just sees which one they belong to.
 */
function ClassSwitcher({
  classes,
  activeCode,
}: {
  classes: { code: string; name: string; isMine?: boolean }[];
  activeCode: string | null;
}) {
  if (classes.length === 0) {
    // The browser can already know which class it is in — a student who has
    // just signed up, before the deployment reports the membership — so show
    // that instead of asking for the code all over again.
    if (activeCode) {
      return (
        <div
          data-tour="sidebar-class"
          className="mx-1 mb-1 rounded-lg border border-sidebar-border px-2.5 py-2"
        >
          <p className="text-[10px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
            Your class
          </p>
          <p className="font-mono text-[11px] tracking-widest text-sidebar-foreground/60">
            {activeCode}
          </p>
        </div>
      );
    }
    return (
      <SidebarMenu className="px-1">
        <SidebarMenuItem>
          <SidebarMenuButton asChild tooltip="Join a class with your code">
            <NavLink to="/dashboard/classes">
              <Layers />
              <span className="truncate text-xs">Enter your class code</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }

  if (classes.length === 1) {
    const only = classes[0];
    return (
      <div
        data-tour="sidebar-class"
        className="mx-1 mb-1 rounded-lg border border-sidebar-border px-2.5 py-2"
      >
        <p className="text-[10px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
          Your class
        </p>
        <p className="truncate text-xs font-medium text-sidebar-foreground">
          {only.name}
        </p>
        <p className="font-mono text-[11px] tracking-widest text-sidebar-foreground/60">
          {only.code}
        </p>
      </div>
    );
  }

  return (
    <div
      data-tour="sidebar-class"
      className="mx-1 mb-1 flex flex-col gap-1.5"
    >
      <span className="px-0.5 text-[10px] font-medium tracking-wide text-sidebar-foreground/60 uppercase">
        Your class
      </span>
      <Select
        value={activeCode ?? undefined}
        onValueChange={(code) => setActiveClass(code)}
      >
        <SelectTrigger size="sm" className="w-full">
          <SelectValue placeholder="Pick a class" />
        </SelectTrigger>
        <SelectContent>
          {classes.map((entry) => (
            <SelectItem key={entry.code} value={entry.code}>
              <span className="flex items-center gap-2">
                <span className="truncate">{entry.name}</span>
                {entry.isMine && (
                  <span className="text-[10px] text-muted-foreground">yours</span>
                )}
                <span className="font-mono text-[10px] text-muted-foreground">
                  {entry.code}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function NavItems({
  items,
  activePath,
  practiceEnabled,
}: {
  items: typeof NAV_ITEMS;
  activePath: string;
  practiceEnabled: boolean;
}) {
  return (
    <SidebarMenu data-tour="nav">
      {items.map(({ path, label, icon: Icon }) => {
        // The Practice Log is greyed out and unclickable until the admin
        // switches it on for everyone.
        const locked = path === "/dashboard/practice" && !practiceEnabled;
        // The guided tour spotlights the live link, so each one is findable by
        // a stable name (see src/components/tour-spotlight.tsx).
        const tourTarget = `nav-${path.split("/").filter(Boolean).pop() ?? "dashboard"}`;
        return (
          <SidebarMenuItem key={path}>
            <SidebarMenuButton
              asChild
              isActive={activePath === path}
              tooltip={
                locked
                  ? "Practice Log is disabled by the admin"
                  : label
              }
              className={cn(
                "data-[active=true]:text-gold",
                locked && "cursor-not-allowed opacity-40",
              )}
            >
              {locked ? (
                <div
                  aria-disabled="true"
                  data-tour={tourTarget}
                  className="flex w-full items-center gap-2 [&>svg]:size-4 [&>svg]:shrink-0"
                >
                  <Icon />
                  <span className="truncate">{label}</span>
                </div>
              ) : (
                <NavLink
                  to={path}
                  end={path === "/dashboard"}
                  data-tour={tourTarget}
                >
                  <Icon />
                  <span>{label}</span>
                </NavLink>
              )}
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

// A compact shortcut to Messages that lives beside the account chip and
// carries a live unread count, so a reply is never missed.
function MessagesShortcut({ count }: { count: number }) {
  const label =
    count > 0
      ? `${count} unread message${count === 1 ? "" : "s"}`
      : "Messages";
  return (
    <NavLink
      to="/dashboard/messages"
      aria-label={label}
      title={label}
      className="relative flex size-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-card text-foreground/80 shadow-xs transition-colors hover:border-primary/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
    >
      <MessageSquareText className="size-4" />
      {count > 0 && (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground ring-2 ring-background">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </NavLink>
  );
}

// A phone shows the navigation in a drawer. Once a link in it has been tapped
// the drawer must get out of the way, or it covers the page it just opened.
function CloseMobileNavOnNavigate() {
  const { isMobile, setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);
  return null;
}

// A deliberately loud mobile menu button — the old icon-only trigger was easy
// to miss, so this is a filled, labelled pill with a comfortable tap target.
function MobileMenuButton() {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <Button
      type="button"
      onClick={() => setOpenMobile(!openMobile)}
      aria-label={openMobile ? "Close menu" : "Open menu"}
      aria-expanded={openMobile}
      data-tour="nav"
      className="h-10 gap-2 rounded-full bg-primary px-3.5 text-primary-foreground shadow-sm hover:bg-primary/90 md:hidden"
    >
      <Menu className="size-5" />
      <span className="text-sm font-semibold">Menu</span>
    </Button>
  );
}

/**
 * The light/dark switch, just above the credits in the menu footer. The choice
 * is remembered in this browser (next-themes, set up in main.tsx), so a reload
 * or a return visit keeps the room as dim as it was left.
 */
function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/25 px-2.5 py-2">
      <span className="flex items-center gap-2 text-[11px] font-medium text-sidebar-foreground/70">
        {isDark ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
        Dark mode
      </span>
      <Switch
        checked={isDark}
        onCheckedChange={(on) => setTheme(on ? "dark" : "light")}
        aria-label="Toggle dark mode"
        className="data-[state=checked]:bg-gold data-[state=unchecked]:bg-sidebar-foreground/25"
      />
    </div>
  );
}

export function BrandMark({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-lg bg-red-800 ring-1 ring-white/10",
        size === "md" ? "size-9" : "size-7",
      )}
    >
      <Om
        className={cn(
          "text-yellow-300",
          size === "md" ? "text-2xl" : "text-lg",
        )}
      />
    </span>
  );
}

export default function AppShell() {
  const { user, signOut } = useAuth();
  const isAdmin = useIsAdmin();
  // A tab left open should not keep running an older build after a publish —
  // it offers a reload instead of silently going stale.
  useBuildWatcher();
  // Whether this account is staff, decided by the deployment — not by the role
  // this browser happens to have stored (see convex/classes.ts viewerRole).
  const {
    isStaff: viewerIsStaff,
    isPlatformAdmin,
    isLoading: roleLoading,
  } = useViewerIsStaff();
  const vault = useVault();
  const navigate = useNavigate();
  const location = useLocation();
  const { available: myClasses, isLoading: classesLoading } = useClasses();
  // Teachers and the admin may open any class in the studio, so their list is
  // the whole studio; a student keeps seeing only the class they joined.
  const {
    classes: studioClasses,
    canSeeAll,
    isLoading: allClassesLoading,
  } = useAllClasses();

  // The platform admin looks at one studio at a time: the picker below the
  // Studio heading chooses it, and the class list follows. A teacher's studio
  // is their own, and a student never sees this control at all.
  const { studioId: activeStudioId, setStudioId } = useActiveStudio();
  const { studios, isLoading: studiosLoading } = useStudios();
  const myStudio = useMyStudio();
  // The studio the shell is looking at, named at the top of the menu.
  const studioName = useStudioName();
  useEffect(() => {
    if (!isPlatformAdmin || studios.length === 0) return;
    if (
      activeStudioId &&
      studios.some((studio) => studio.id === activeStudioId)
    ) {
      return;
    }
    setStudioId(studios[0].id);
  }, [isPlatformAdmin, studios, activeStudioId, setStudioId]);

  // A deployment that has no studio yet (everything predates studios) is one
  // click away from having one: the backfill puts every class and account into
  // a single studio and adopts the archive folder already in the Drive.
  const backfillStudios = useMutation(api.migrations.studiosBackfill);
  const [backfilling, setBackfilling] = useState(false);
  const runBackfill = async () => {
    setBackfilling(true);
    try {
      const result = await backfillStudios({});
      if (!result.ok) {
        toast.error(result.error ?? "Could not set up studios.");
        return;
      }
      toast.success(
        `${result.studio}: ${result.classes} classes, ${result.teachers} teachers, ${result.students} students.`,
      );
    } catch (error) {
      console.error("Studio backfill failed:", error);
      toast.error("Could not set up studios.");
    } finally {
      setBackfilling(false);
    }
  };

  // The practice log moved from this browser to the deployment. Sessions an
  // older build kept here are handed over once, per class, for the signed-in
  // account only — otherwise a browser the whole class used would credit
  // everyone's practice to whoever signed in next.
  const importLocalPractice = useMutation(api.practice.importLocal);
  const practiceImportTried = useRef<string | null>(null);
  useEffect(() => {
    const code = vault.classCode;
    const name = user?.name;
    if (!code || !name) return;
    const key = `${code}:${name}`;
    if (practiceImportTried.current === key) return;
    practiceImportTried.current = key;

    const entries = pendingLocalPractice(code, name, vault.logs);
    if (entries.length === 0) {
      markLocalPracticeImported(code);
      return;
    }
    void importLocalPractice({ code, entries })
      .then((result) => {
        if (!result.ok) return;
        markLocalPracticeImported(code);
        if (result.imported > 0) {
          toast.success(
            `${result.imported} practice ${
              result.imported === 1 ? "session" : "sessions"
            } moved into your class log.`,
          );
        }
      })
      .catch((error) => {
        // Left unmarked, so the next visit tries again.
        console.error("Practice log import failed:", error);
      });
  }, [vault.classCode, vault.logs, user?.name, importLocalPractice]);

  // The admin's Practice Log switch is authoritative on the Convex
  // deployment; mirror it into the local vault state so the nav, dashboard,
  // and Practice Log page all gate on the same value.
  const practiceLogEnabled = useQuery(api.admin.practiceLogEnabled);
  useEffect(() => {
    if (typeof practiceLogEnabled === "boolean") {
      setPracticeLogEnabled(practiceLogEnabled);
    }
  }, [practiceLogEnabled]);

  // Keep the browser's stored role in step with the deployment's answer, so
  // everything that still reads it (the role a new message is sent as, the
  // attendance wording) is right too. Sign-in deliberately never rewrites the
  // stored role, so without this a student on a machine a teacher used stays
  // labelled as the teacher.
  useEffect(() => {
    if (roleLoading) return;
    const role = viewerIsStaff ? "teacher" : "student";
    if (vault.role !== role) setRole(role);
  }, [viewerIsStaff, roleLoading, vault.role]);

  // The account this browser is signed in as is the one it should come back
  // to, even when the session was restored from storage rather than typed in
  // just now (see src/lib/last-account.ts).
  useEffect(() => {
    if (user?.name) rememberAccount(user.name);
  }, [user?.name]);

  // A teacher — or an unlocked admin — manages the classes, so they get the
  // Classes entry. A student's class is decided by the code they signed up
  // with, so the entry would only be noise for them.
  const canManageClasses = isAdmin || viewerIsStaff;
  const navItems = canManageClasses
    ? [...NAV_ITEMS, CLASSES_ITEM, STUDIO_ITEM]
    : NAV_ITEMS;

  // A record of the admin controls appearing and disappearing, so the next
  // time they vanish the answers that caused it can be read instead of guessed
  // at (see lib/admin-diagnostics). Nothing here changes what is rendered.
  const pickerVisible = isPlatformAdmin && studios.length > 0;
  const previousAdminView = useRef<{ picker: boolean; nav: boolean } | null>(
    null,
  );
  useEffect(() => {
    const current = { picker: pickerVisible, nav: canManageClasses };
    const previous = previousAdminView.current;
    previousAdminView.current = current;
    const snapshot = () => ({
      path: location.pathname,
      online: navigator.onLine,
      account: user?.email ?? null,
      studios: studios.length,
      studiosLoading,
      roleLoading,
      isAdmin,
      isStaff: viewerIsStaff,
      isPlatformAdmin,
      storage: storageProbe(),
    });
    if (previous === null) {
      recordDiagnosis("shell", {
        event: "first paint",
        ...snapshot(),
        ...current,
      });
      return;
    }
    const vanished =
      (previous.picker && !current.picker) ||
      (previous.nav && !current.nav);
    const restored =
      (!previous.picker && current.picker) ||
      (!previous.nav && current.nav);
    if (!vanished && !restored) return;
    recordDiagnosis(
      "shell",
      { ...snapshot(), before: previous, after: current },
      vanished ? { vanished: true } : { restored: true },
    );
  }, [
    pickerVisible,
    canManageClasses,
    location.pathname,
    user?.email,
    studios.length,
    studiosLoading,
    roleLoading,
    isAdmin,
    viewerIsStaff,
    isPlatformAdmin,
  ]);

  // What can be opened from the switcher: the whole studio for a teacher or
  // the admin, otherwise just this account's own classes.
  const switchableClasses = canSeeAll ? studioClasses : myClasses;

  // Follow the account's class as soon as the deployment tells us about it: a
  // student opens the class they joined, a teacher their first own class. The
  // local vault keeps one bucket of content per class, so this switches which
  // vault is on screen.
  //
  // A class already on screen is left alone while the deployment's answer is
  // still on its way in (`loadingClasses`), so a student who picked a class
  // (or switched to another) is never bounced back by a late response. Once
  // the list has arrived, a class that really isn't in it is replaced.
  const switchableKey = classKey(switchableClasses);
  const loadingClasses = classesLoading || allClassesLoading;
  useEffect(() => {
    if (switchableClasses.length === 0) {
      // The deployment answered and there is nothing to open — a studio with no
      // classes, or an account that joined none yet. Drop the class on screen
      // rather than leaving another studio's media and logs on display.
      if (!loadingClasses && vault.classCode) setActiveClass(null);
      return;
    }
    if (
      vault.classCode &&
      (loadingClasses ||
        switchableClasses.some((entry) => entry.code === vault.classCode))
    ) {
      return;
    }
    const preferred = myClasses[0] ?? switchableClasses[0];
    setActiveClass(preferred.code);
  }, [
    switchableKey,
    switchableClasses,
    myClasses,
    vault.classCode,
    loadingClasses,
  ]);

  const activePath = navItems.reduce(
    (best, item) =>
      location.pathname === item.path ||
      (item.path !== "/dashboard" && location.pathname.startsWith(item.path))
      ? item.path
      : best,
    "/dashboard",
  );
  const activeLabel =
    navItems.find((i) => i.path === activePath)?.label ?? "Dashboard";

  // The sidebar's account block keeps the full name; the header pill next to
  // the avatar shows only the first name (see lib/display-name).
  const displayName = user?.name || "My Vault";
  const shortDisplayName = firstName(displayName);

  // Accounts made before sign-up asked for a full name still go by their
  // username, so they are asked once here (see convex/names.ts). "Later"
  // silences the card for this visit only.
  const needsFullName = useQuery(api.names.needsFullName);
  const [nameAskedLater, setNameAskedLater] = useState(false);
  const showNamePrompt = needsFullName === true && !nameAskedLater;

  // A teacher from before studios has classes that belong to no studio yet:
  // one card asks them to name their studio, and the server moves their classes
  // and their students into it when they do (convex/studios.ts → createStudio).
  const [studioAskedLater, setStudioAskedLater] = useState(false);
  const showStudioPrompt =
    !roleLoading &&
    viewerIsStaff &&
    !isPlatformAdmin &&
    !myStudio.isLoading &&
    myStudio.studio === null &&
    !studioAskedLater;

  // A brand-new account gets the walkthrough once, straight after sign-up
  // (see convex/tour.ts). The deployment clears the flag, so it never returns.
  // It waits for the role, because a teacher's tour has more pages than a
  // student's and the step count must not change mid-walkthrough.
  //
  // `?tour=1` replays it on demand — the walkthrough is the best way to see
  // what a section does, and an account that has already finished it otherwise
  // has no way back in. The replay is kept in state, not in the URL, so the
  // tour's own page navigation cannot drop it mid-way.
  const tourPending = useQuery(api.tour.pending);
  const [tourClosed, setTourClosed] = useState(false);
  const [replayTour, setReplayTour] = useState(
    () => new URLSearchParams(window.location.search).get("tour") === "1",
  );
  const showTour = (tourPending === true || replayTour) && !tourClosed && !roleLoading;
  // Both first-run cards are decided by the deployment, and those answers
  // arrive a beat after the dashboard first paints. Until they are in, the
  // add-to-home-screen steps wait: opening underneath the walkthrough both hid
  // them and let a tap on the walkthrough count as waving them away.
  const firstRunSettled =
    needsFullName !== undefined && tourPending !== undefined && !roleLoading;
  // Unread messages come from the deployment (see convex/chats.ts), which
  // counts what arrived in every chat since this account last opened it.
  const unreadMessages =
    useQuery(
      api.chats.unreadTotal,
      activeStudioId ? { studioId: activeStudioId } : {},
    ) ?? 0;
  const initials = displayName
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const handleSignOut = async () => {
    // Clear this browser's copy of the unlock and the remembered role. The
    // deployment keeps the account's admin grant (see convex/admin.ts), so
    // signing back in does not mean losing admin features or re-entering the
    // credentials — but the next person on this device starts as themselves.
    lockAdmin();
    forgetRoles();
    await signOut();
    navigate("/");
  };

  return (
    <SidebarProvider>
      <CloseMobileNavOnNavigate />
      <Sidebar collapsible="offcanvas">
        <SidebarHeader className="gap-3 px-3 pt-4 pb-3">
          <div className="flex items-center gap-2.5 px-1">
            <BrandMark />
            <div className="min-w-0">
              <p className="truncate font-samarkan text-xl leading-tight text-sidebar-foreground">
                NatyaVault
              </p>
              <p className="truncate text-[11px] text-sidebar-foreground/60">
                {studioName ?? "Bharatanatyam archive"}
              </p>
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel className="truncate">
              {studioName ?? "Studio"}
            </SidebarGroupLabel>
            {isPlatformAdmin ? (
              <div className="px-1 pb-2">
                {studios.length > 0 ? (
                  <>
                    <Select
                      value={activeStudioId ?? studios[0].id}
                      onValueChange={(value) => setStudioId(value)}
                    >
                      <SelectTrigger
                        id="studio-picker"
                        aria-label="Choose a studio to view"
                        className="h-8 w-full cursor-pointer text-xs"
                      >
                        <SelectValue placeholder="Pick a studio" />
                      </SelectTrigger>
                      <SelectContent>
                        {studios.map((studio) => (
                          <SelectItem
                            key={studio.id}
                            value={studio.id}
                            className="cursor-pointer text-xs"
                          >
                            {studio.name}
                            {studio.suspended ? (
                              <span className="ml-1.5 text-destructive">suspended</span>
                            ) : null}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                ) : studiosLoading ? (
                  // A quiet studios query must not look like "no studio yet":
                  // the group-into-one-studio button is for a deployment that
                  // really has none.
                  <p className="px-1 py-1.5 text-xs text-sidebar-foreground/60">
                    Loading studios…
                  </p>
                ) : (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 w-full cursor-pointer text-xs"
                    onClick={runBackfill}
                    disabled={backfilling}
                    title="Puts every existing class in one studio named NatyaVault. Teachers without a studio are asked to name their own instead."
                  >
                    {backfilling ? "Setting up…" : "Group into one studio"}
                  </Button>
                )}
              </div>
            ) : null}
            <ClassSwitcher
              classes={switchableClasses}
              activeCode={vault.classCode}
            />
            <NavItems
              items={navItems}
              activePath={activePath}
              practiceEnabled={vault.practiceLogEnabled}
            />
          </SidebarGroup>
        </SidebarContent>

        {/* Same inset as the footer's cards below, so the rule lines up with
            them instead of sitting a few pixels to one side. */}
        <SidebarSeparator className="mx-3" />

        <SidebarFooter className="gap-3 p-3">
          <ThemeToggle />
          {/* Who built it and where to get help. Kept small and low-contrast so
              the account row below stays the loudest thing down here. */}
          <div className="rounded-lg border border-sidebar-border/60 bg-sidebar-accent/25 px-2.5 py-2">
            <p className="text-[9px] font-medium tracking-[0.14em] text-sidebar-foreground/40 uppercase">
              Developed by
            </p>
            <p className="truncate text-[11px] leading-snug text-sidebar-foreground/70">
              Benish Agasthya Mutha
            </p>
            <p className="mt-1.5 text-[9px] font-medium tracking-[0.14em] text-sidebar-foreground/40 uppercase">
              Support
            </p>
            <a
              href="mailto:muthabenish@gmail.com"
              title="Email support"
              className="block truncate text-[11px] leading-snug text-sidebar-foreground/70 underline-offset-2 transition-colors hover:text-sidebar-foreground hover:underline"
            >
              muthabenish@gmail.com
            </a>
            {/* What the deployment answered about admin access, for when the
                studio picker or the Classes/Studio entries go missing. */}
            <AdminDiagnostics />
          </div>
          <div className="flex items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-gold/20 text-xs font-semibold text-gold ring-1 ring-white/10">
              {initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-sidebar-foreground">
                {displayName}
              </p>
              <p className="truncate text-[11px] text-sidebar-foreground/60">
                {user?.email ?? "Signed in on this device"}
              </p>
            </div>
          </div>
          {/* Named rather than an icon on its own, so the way out of the
              vault is obvious on a shared studio device. */}
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                type="button"
                data-tour="logout"
                tooltip="Sign out"
                onClick={handleSignOut}
                className="text-sidebar-foreground/75 hover:bg-destructive/10 hover:text-destructive"
              >
                <LogOut />
                <span>Sign out</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-border/80 bg-background/85 px-4 backdrop-blur sm:gap-3 md:px-6">
          <MobileMenuButton />
          <div className="flex min-w-0 items-center gap-2.5 md:hidden">
            {/* On the narrowest phones the wordmark is the useful part — the
                square Om mark would squeeze it out of the header. */}
            <span className="hidden sm:block">
              <BrandMark size="sm" />
            </span>
            <span className="truncate font-samarkan text-xl leading-tight">
              NatyaVault
            </span>
          </div>
          <p className="hidden truncate text-sm font-medium text-muted-foreground md:block">
            {activeLabel}
          </p>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <MessagesShortcut count={unreadMessages} />
            {isAdmin ? (
              <NavLink
                to="/dashboard/admin"
                data-tour="account"
                className="flex items-center gap-2 rounded-full border border-border/70 bg-card py-1 pr-3 pl-1 shadow-xs transition-colors hover:border-primary/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                aria-label="Open admin area"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                  {initials}
                </span>
                <span className="hidden text-xs font-medium sm:inline">
                  {shortDisplayName}
                </span>
              </NavLink>
            ) : (
              <div
                data-tour="account"
                className="flex items-center gap-2 rounded-full border border-border/70 bg-card py-1 pr-3 pl-1 shadow-xs"
                aria-label={`Signed in as ${displayName}`}
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                  {initials}
                </span>
                <span className="hidden text-xs font-medium sm:inline">
                  {shortDisplayName}
                </span>
              </div>
            )}
          </div>
        </header>

        <div className="flex-1 p-4 md:p-6 lg:p-8">
          <Outlet />
        </div>
      </SidebarInset>

      {/* The walkthrough for a new account — once, on any device. It spotlights
          one real element per stop rather than describing it. */}
      <TourSpotlight
        open={showTour}
        onDone={() => {
          setTourClosed(true);
          setReplayTour(false);
          // Its last page is about putting NatyaVault on the home screen, so
          // those steps follow straight after the walkthrough.
          rearmInstallPrompt();
        }}
      />
      {/* Asked once to any account that predates the full-name field. */}
      <FullNamePrompt
        open={showNamePrompt}
        currentName={user?.name ?? ""}
        username={user?.email ?? ""}
        onClose={() => setNameAskedLater(true)}
      />
      <StudioPrompt
        open={showStudioPrompt}
        onClose={() => setStudioAskedLater(true)}
      />
      {/* Offered to an account that was just created. It stops offering
          itself once the app is installed, or once the steps have been waved
          away twice (see src/lib/install.ts). Held back while the name card is
          on screen so two first-run popups never stack. */}
      <AddToHomeScreenDialog
        suppressed={showNamePrompt || showTour || showStudioPrompt}
        ready={firstRunSettled}
      />
      {/* Offered straight after those steps (or on launch of the installed
          app), then only from the bell in Messages. */}
      <NotificationsPrompt autoOpen />
    </SidebarProvider>
  );
}
