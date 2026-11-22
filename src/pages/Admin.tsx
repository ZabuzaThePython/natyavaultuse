/**
 * Admin area — search, review, and delete content, check storage, manage the
 * account, and reset or clear the vault.
 */
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { Switch } from "@/components/ui/switch";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import { firstName } from "@/lib/display-name";
import { useAuth } from "@/hooks/use-auth";
import { getAdminCreds } from "@/lib/admin";
import { STORAGE_PLANS } from "@/lib/plans";
import { useClassPractice } from "@/lib/practice";
import {
  clearContent,
  formatDate,
  removeMedia,
  setPracticeLogEnabled,
  setPublicMode,
  useVault,
} from "@/lib/vault";
import { useAction, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Clapperboard,
  Globe,
  HardDrive,
  KeyRound,
  LogOut,
  Music2,
  NotebookPen,
  Search,
  Sticker,
  Trash2,
  TriangleAlert,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One row from the admin account list. */
type AdminAccount = FunctionReturnType<typeof api.admin.listAccounts>[number];

export default function Admin() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const vault = useVault();

  const [tab, setTab] = useState<"media" | "logs">("media");
  const [query, setQuery] = useState("");

  // Which accounts to show. Teacher accounts are the staff logins the admin
  // manages most often, so they get a one-click filter of their own.
  const [accountFilter, setAccountFilter] = useState<
    "all" | "teachers" | "students"
  >("all");

  // All sign-in accounts. The server accepts either the credentials that
  // unlocked this page or a session signed in as the admin account, so an
  // empty pair is sent when this browser no longer stores them — that is what
  // used to blank this page out whenever localStorage was lost.
  const adminCreds = getAdminCreds() ?? { username: "", password: "" };
  const accounts = useQuery(api.admin.listAccounts, {
    adminUsername: adminCreds.username,
    adminPassword: adminCreds.password,
  });
  const deleteAccount = useMutation(api.admin.deleteAccount);
  // The practice log lives on the deployment (convex/practice.ts), so this
  // page reviews the class's sessions rather than the browser's old copy.
  const practice = useClassPractice(vault.classCode);
  const removeEntry = useMutation(api.practice.removeEntry);
  const clearClassAttendance = useMutation(api.attendance.clearClassAttendance);
  const resetAccountPassword = useAction(api.admin.resetPassword);
  const setPracticeLogSetting = useMutation(api.admin.setPracticeLogEnabled);
  const setPublicModeSetting = useMutation(api.admin.setPublicMode);
  const setGifsSetting = useMutation(api.admin.setGifsEnabled);

  // Narrow the account list to teachers or students. Depends on whether they
  // can sign in as staff, not on a label the browser chose.
  const visibleAccounts =
    accounts === undefined
      ? undefined
      : accounts.filter((account) =>
          accountFilter === "all"
            ? true
            : accountFilter === "teachers"
              ? account.isTeacher
              : !account.isTeacher,
        );
  const teacherCount = accounts?.filter((a) => a.isTeacher).length ?? 0;

  // Password-reset dialog state. The admin enters the new password here; the
  // account's current password is never shown.
  const [resetAccount, setResetAccount] = useState<AdminAccount | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  // Mirror the deployment-wide Practice Log switch into the local vault state
  // so the sidebar nav, dashboard, and Practice Log page all gate on it.
  const practiceLogEnabled = useQuery(api.admin.practiceLogEnabled);
  useEffect(() => {
    if (typeof practiceLogEnabled === "boolean") {
      setPracticeLogEnabled(practiceLogEnabled);
    }
  }, [practiceLogEnabled]);

  // Mirror the deployment-wide public launch switch too, so this card and the
  // landing page always agree on what is live.
  const publicModeQuery = useQuery(api.admin.publicMode);
  useEffect(() => {
    if (typeof publicModeQuery === "boolean") {
      setPublicMode(publicModeQuery);
    }
  }, [publicModeQuery]);

  const handleTogglePracticeLog = async (enabled: boolean) => {
    try {
      const result = await setPracticeLogSetting({
        adminUsername: adminCreds.username,
        adminPassword: adminCreds.password,
        enabled,
      });
      if (result.ok) {
        setPracticeLogEnabled(enabled);
        toast.success(
          enabled
            ? "Practice Log enabled for everyone."
            : "Practice Log disabled for everyone.",
        );
      } else {
        toast.error(result.error ?? "Could not update the Practice Log.");
      }
    } catch (error) {
      console.error("Practice Log toggle error:", error);
      toast.error("Could not update the Practice Log.");
    }
  };

  // Off as shipped — the chat has no GIF button until this is switched on.
  const gifsEnabled = useQuery(api.admin.gifsEnabled) === true;

  const handleToggleGifs = async (enabled: boolean) => {
    try {
      const result = await setGifsSetting({
        adminUsername: adminCreds.username,
        adminPassword: adminCreds.password,
        enabled,
      });
      if (result.ok) {
        toast.success(
          enabled
            ? "GIF search turned on for the chat."
            : "GIF search turned off.",
        );
      } else {
        toast.error(result.error ?? "Could not update GIF search.");
      }
    } catch (error) {
      console.error("GIF toggle error:", error);
      toast.error("Could not update GIF search.");
    }
  };

  const handleTogglePublicMode = async (enabled: boolean) => {
    try {
      const result = await setPublicModeSetting({
        adminUsername: adminCreds.username,
        adminPassword: adminCreds.password,
        enabled,
      });
      if (result.ok) {
        setPublicMode(enabled);
        toast.success(
          enabled
            ? "NatyaVault is open to other dance schools."
            : "NatyaVault is private again.",
        );
      } else {
        toast.error(result.error ?? "Could not update the public launch.");
      }
    } catch (error) {
      console.error("Public launch toggle error:", error);
      toast.error("Could not update the public launch.");
    }
  };

  const handleDeleteAccount = async (
    account: NonNullable<typeof accounts>[number],
  ) => {
    try {
      const result = await deleteAccount({
        adminUsername: adminCreds.username,
        adminPassword: adminCreds.password,
        userId: account.id,
      });
      if (result.ok) {
        toast.success(`Deleted account \u201c${result.username}\u201d.`);
      } else {
        toast.error(result.error ?? "Could not delete the account.");
      }
    } catch (error) {
      console.error("Delete account error:", error);
      toast.error("Could not delete the account.");
    }
  };

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!resetAccount) return;
    if (!newPassword) {
      toast.error("Enter a new password.");
      return;
    }
    setResetting(true);
    try {
      const result = await resetAccountPassword({
        adminUsername: adminCreds.username,
        adminPassword: adminCreds.password,
        userId: resetAccount.id,
        newPassword,
      });
      if (result.ok) {
        toast.success(`Password updated for \u201c${result.username}\u201d.`);
        setResetAccount(null);
        setNewPassword("");
      } else {
        toast.error(result.error ?? "Could not update the password.");
      }
    } catch (error) {
      console.error("Reset password error:", error);
      toast.error("Could not update the password.");
    } finally {
      setResetting(false);
    }
  };

  const displayName = user?.name || "My Vault";
  const initials = displayName
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const storageBytes = useMemo(() => {
    try {
      return new Blob([JSON.stringify(vault)]).size;
    } catch {
      return 0;
    }
  }, [vault]);

  const audioCount = vault.media.filter((m) => m.kind === "audio").length;
  const videoCount = vault.media.filter((m) => m.kind === "video").length;

  const q = query.trim().toLowerCase();
  const matches = (...values: (string | undefined)[]) =>
    !q || values.some((v) => v?.toLowerCase().includes(q));

  const media = [...vault.media]
    .sort((a, b) => b.createdAt - a.createdAt)
    .filter((m) => matches(m.title, m.piece, m.talam, m.ragam));
  const logs = [...practice.entries]
    .sort((a, b) => b.date.localeCompare(a.date))
    .filter((l) => matches(l.item));

  const stats = [
    {
      label: "Media files",
      value: `${vault.media.length}`,
      detail: `${audioCount} audio · ${videoCount} video`,
      icon: Clapperboard,
      tint: "bg-primary/10 text-primary",
      edge: "border-l-primary",
    },
    {
      label: "Practice entries",
      value: `${practice.entries.length}`,
      detail: "sessions in this class",
      icon: NotebookPen,
      tint: "bg-gold/25 text-gold-foreground",
      edge: "border-l-gold",
    },
    {
      label: "Storage used",
      value: formatBytes(storageBytes),
      detail: "kept in this browser",
      icon: HardDrive,
      tint: "bg-[oklch(0.6_0.1_200)]/15 text-[oklch(0.5_0.1_200)]",
      edge: "border-l-[oklch(0.6_0.1_200)]",
    },
  ];

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">
          Admin
        </h1>            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Review everything you have posted, keep an eye on storage, and manage
          your account — all from one place.
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map(({ label, value, detail, icon: Icon, tint, edge }) => (
          <Card key={label} className={`gap-3 border-l-4 py-4 ${edge}`}>
            <CardContent className="flex items-start gap-3 px-4">
              <span
                className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${tint}`}
              >
                <Icon className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-muted-foreground">
                  {label}
                </p>
                <p className="text-xl font-semibold tracking-tight tabular-nums">
                  {value}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {detail}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>

      {/* -------------------------------------------------- feature switches */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <NotebookPen className="size-4" />
            Practice Log
          </CardTitle>
          <CardDescription>
            Turn the Practice Log on or off for everyone. While it is off, the
            page stays greyed out and unclickable for every user.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Allow practice logging</p>
              <p className="text-xs text-muted-foreground">
                {vault.practiceLogEnabled
                  ? "Users can open the Practice Log and post entries."
                  : "The Practice Log is hidden and disabled for all users."}
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={vault.practiceLogEnabled}
                onCheckedChange={(checked) => void handleTogglePracticeLog(checked)}
                aria-label="Enable the Practice Log for all users"
              />
              <span className="text-sm font-medium">
                {vault.practiceLogEnabled ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* --------------------------------------------------------- chat GIFs */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sticker className="size-4" />
            Chat GIFs
          </CardTitle>
          <CardDescription>
            Add a GIF button to the chat composer, backed by GIPHY. Off by
            default; turning it on needs a free GIPHY key on the deployment
            (<code>GIPHY_API_KEY</code>), otherwise the picker shows a setup
            notice.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Allow searching GIFs</p>
              <p className="text-xs text-muted-foreground">
                {gifsEnabled
                  ? "Everyone can send GIFs in chat."
                  : "The GIF button is hidden from every chat."}
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={gifsEnabled}
                onCheckedChange={(checked) => void handleToggleGifs(checked)}
                aria-label="Enable GIF search in chat"
              />
              <span className="text-sm font-medium">
                {gifsEnabled ? "Enabled" : "Disabled"}
              </span>
            </label>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------ public launch */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="size-4" />
            Public launch
          </CardTitle>
          <CardDescription>
            Open NatyaVault to other dance schools. While it is off, the app is
            a private vault for your own class and the landing page says so.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">Open to the public</p>
              <p className="text-xs text-muted-foreground">
                {vault.publicMode
                  ? "Other dance schools can sign up and pick a storage plan."
                  : "Invitation only — the landing page advertises no plans."}
              </p>
            </div>
            <label className="flex cursor-pointer items-center gap-2">
              <Switch
                checked={vault.publicMode}
                onCheckedChange={(checked) =>
                  void handleTogglePublicMode(checked)
                }
                aria-label="Open NatyaVault to other dance schools"
              />
              <span className="text-sm font-medium">
                {vault.publicMode ? "Live" : "Disabled"}
              </span>
            </label>
          </div>

          <div className="grid gap-2 sm:grid-cols-3">
            {STORAGE_PLANS.map((plan) => (
              <div
                key={plan.name}
                className="rounded-lg border border-border/70 px-3 py-2.5"
              >
                <p className="text-sm font-medium">{plan.name}</p>
                <p className="text-xs text-muted-foreground">
                  {plan.storage} · {plan.price} {plan.cadence}
                </p>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            These are the plans the public page lists. Card payments are not
            connected yet, so schools start on the free tier while billing is
            still to be wired up.
          </p>
        </CardContent>
      </Card>

      {/* -------------------------------------------------------- accounts */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" />
            Accounts
          </CardTitle>
          <CardDescription>
            Every sign-in account on this deployment, teachers included. Filter
            to the teacher accounts, then reset any password to set a new value
            — current passwords are never shown.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* Teacher / student filter — teachers are staff accounts the admin
              manages most often. */}
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                { key: "all", label: "All", count: accounts?.length ?? 0 },
                { key: "teachers", label: "Teachers", count: teacherCount },
                {
                  key: "students",
                  label: "Students",
                  count: (accounts?.length ?? 0) - teacherCount,
                },
              ] as const
            ).map(({ key, label, count }) => (
              <Button
                key={key}
                type="button"
                size="sm"
                variant={accountFilter === key ? "default" : "outline"}
                onClick={() => setAccountFilter(key)}
              >
                {label}
                <span className="tabular-nums text-xs opacity-70">{count}</span>
              </Button>
            ))}
          </div>

          {visibleAccounts === undefined ? (
            <EmptyLine message="Loading accounts\u2026" />
          ) : visibleAccounts.length === 0 ? (
            <EmptyLine
              message={
                accountFilter === "teachers"
                  ? "No teacher accounts on this deployment."
                  : accountFilter === "students"
                    ? "No student accounts on this deployment."
                    : "No accounts to show."
              }
            />
          ) : (
            visibleAccounts.map((account) => (
              <div
                key={account.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-border/70 px-3 py-2.5"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
                  {account.username.slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {account.username}
                  </p>
                  {account.fullName && account.fullName !== account.username && (
                    <p className="truncate text-xs font-medium">
                      {firstName(account.fullName)}
                    </p>
                  )}
                  <p className="truncate text-xs text-muted-foreground">
                    Joined{" "}
                    {formatDate(
                      new Date(account.createdAt).toISOString().slice(0, 10),
                    )}
                    {account.classes.length > 0 &&
                      ` \u00b7 ${account.classes.map((c) => c.name).join(", ")}`}
                    {account.providers.length > 0 &&
                      ` \u00b7 ${account.providers.join(", ")}`}
                  </p>
                </div>
                <Badge
                  variant={account.isTeacher ? "secondary" : "outline"}
                  className="gap-1"
                  title={
                    account.isAdmin
                      ? "Built-in admin account"
                      : account.isTeacher
                        ? "Teacher — can open every class in the school"
                        : "Student — sees only their own class"
                  }
                >
                  {account.isAdmin
                    ? "Admin"
                    : account.isTeacher
                      ? "Teacher"
                      : "Student"}
                </Badge>
                <Badge
                  variant="outline"
                  className="gap-1 text-muted-foreground"
                  title={
                    account.passwordSet
                      ? "A password is set — the value is never shown"
                      : "No password is set for this account"
                  }
                >
                  <KeyRound className="size-3 shrink-0" />
                  {account.passwordSet ? "Password set" : "No password"}
                </Badge>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setNewPassword("");
                    setResetAccount(account);
                  }}
                >
                  <KeyRound />
                  Reset password
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button type="button" variant="destructive" size="sm">
                      <Trash2 />
                      Delete
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete “{account.username}”?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes the account, its sessions, and its
                        credentials from the deployment — whoever owns it can
                        no longer sign in. This cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDeleteAccount(account)}
                      >
                        Delete account
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* -------------------------------------------------- content manager */}
      <Card className="gap-4">
        <CardHeader>
          <CardTitle className="text-base">Content manager</CardTitle>
          <CardDescription>
            Search, review, and remove anything in your vault.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search content…"
              className="pl-9"
              aria-label="Search content"
            />
          </div>

          <Tabs
            value={tab}
            onValueChange={(v) => setTab(v as typeof tab)}
            className="gap-4"
          >
            <TabsList>
              <TabsTrigger value="media" className="gap-1.5">
                <Clapperboard className="size-4" />
                Media
                <Badge variant="secondary" className="ml-1 px-1.5 tabular-nums">
                  {vault.media.length}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="logs" className="gap-1.5">
                <NotebookPen className="size-4" />
                Practice logs
                <Badge variant="secondary" className="ml-1 px-1.5 tabular-nums">
                  {practice.entries.length}
                </Badge>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="media" className="flex flex-col gap-2">
              {media.length === 0 && <EmptyLine message="No media matches." />}
              {media.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5"
                >
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
                      item.kind === "audio"
                        ? "bg-gold/25 text-gold-foreground"
                        : "bg-primary/10 text-primary"
                    }`}
                  >
                    {item.kind === "audio" ? (
                      <Music2 className="size-4" />
                    ) : (
                      <Clapperboard className="size-4" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{item.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[item.piece, formatDate(item.date), item.kind]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete ${item.title}`}
                    onClick={() => {
                      removeMedia(item.id);
                      toast.success(`Removed “${item.title}”.`);
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </TabsContent>

            <TabsContent value="logs" className="flex flex-col gap-2">
              {logs.length === 0 && (
                <EmptyLine message="No practice entries match." />
              )}
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="flex items-center gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gold/25 text-[11px] font-semibold text-gold-foreground tabular-nums">
                    {log.minutes}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{log.item}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {formatDate(log.date)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label="Delete practice entry"
                    onClick={() => {
                      void removeEntry({ id: log.id }).then((result) => {
                        if (result.ok) {
                          toast.success("Practice entry removed.");
                        } else {
                          toast.error(
                            result.error ?? "Could not remove that entry.",
                          );
                        }
                      });
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </TabsContent>

          </Tabs>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ------------------------------------------------------- account */}
        <Card className="gap-4">
          <CardHeader>
            <CardTitle className="text-base">Account</CardTitle>
            <CardDescription>
              The owner of this vault and its sign-in details.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {firstName(displayName)}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {user?.email ?? "Signed in on this device"}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={handleSignOut}
            >
              <LogOut />
              Sign out
            </Button>
          </CardContent>
        </Card>

        {/* ---------------------------------------------------- danger zone */}
        <Card className="gap-4 border-destructive/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-4 text-destructive" />
              Danger zone
            </CardTitle>
            <CardDescription>
              These actions rewrite your vault immediately and cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Delete all content</p>
                <p className="text-xs text-muted-foreground">
                  Clears every track, clip, log, and folder in the class you
                  are viewing.
                </p>
              </div>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button type="button" variant="destructive" size="sm">
                    <Trash2 />
                    Delete all
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete everything?</AlertDialogTitle>
                    <AlertDialogDescription>
                      All media, folders, practice entries, and attendance
                      marks of the class on screen will be removed — the
                      browser's copy and the class's shared roll. Other
                      classes keep theirs. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => {
                        clearContent();
                        // Attendance is shared now, so the class on screen is
                        // cleared on the deployment as well.
                        if (vault.classCode) {
                          void clearClassAttendance({
                            code: vault.classCode,
                          }).catch((caught) => {
                            console.error(
                              "Could not clear the shared roll:",
                              caught,
                            );
                          });
                        }
                        toast.success("All content deleted.");
                      }}
                    >
                      Delete everything
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* --------------------------------------------- reset password dialog */}
      <Dialog
        open={resetAccount !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResetAccount(null);
            setNewPassword("");
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset password</DialogTitle>
            <DialogDescription>
              Choose a new password for “{resetAccount?.username}”. Their
              current password is not shown. They can sign in with the new one
              right away.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleResetPassword} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="reset-password">New password</Label>
              <Input
                id="reset-password"
                type="text"
                autoComplete="off"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="New password"
                autoFocus
                required
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setResetAccount(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={resetting}>
                {resetting ? "Saving…" : "Update password"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyLine({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
      {message}
    </p>
  );
}
