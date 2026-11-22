/**
 * Classes — the classes a teacher runs.
 *
 * A teacher creates a class here and gets a six-character join code. Students
 * must enter that code when they create their account, which is what puts
 * them in the class: every class keeps its own media vault, folders, practice
 * log, messages, and attendance. Only the Google Drive connection is shared,
 * because it hangs off the account rather than the class.
 *
 * The classes themselves live on the Convex deployment (src/convex/classes.ts)
 * so a student on another laptop joins the same class; the content for each
 * class lives in this browser's vault, one bucket per join code.
 *
 * A teacher (and the admin) sees every class in the studio, not just their
 * own, so classes can be handed over or shared: the list below comes from
 * `classes.allClasses`. A student still only ever sees the class they joined.
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/convex/_generated/api";
import { useIsAdmin } from "@/lib/admin";
import { useActiveStudio } from "@/lib/studios";
import {
  formatClassCode,
  useAllClasses,
  useClasses,
  useViewerIsStaff,
  type ClassOverview,
} from "@/lib/classes";
import {
  adoptClasslessVault,
  forgetClass,
  setActiveClass,
  storedClassCodes,
  useVault,
} from "@/lib/vault";
import { useMutation } from "convex/react";
import {
  ArrowRight,
  Check,
  Copy,
  FolderInput,
  HardDrive,
  KeyRound,
  Layers,
  Loader2,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

/** "3 files, 2 practice entries" style summary of the pre-classes vault. */
function describeLegacy(counts: {
  media: number;
  logs: number;
  messages: number;
  attendance: number;
}): string {
  return [
    counts.media > 0
      ? `${counts.media} file${counts.media === 1 ? "" : "s"}`
      : null,
    counts.logs > 0
      ? `${counts.logs} practice ${counts.logs === 1 ? "entry" : "entries"}`
      : null,
    counts.messages > 0
      ? `${counts.messages} message${counts.messages === 1 ? "" : "s"}`
      : null,
    counts.attendance > 0
      ? `${counts.attendance} attendance mark${
          counts.attendance === 1 ? "" : "s"
        }`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
}

export default function Classes() {
  const vault = useVault();
  const isAdmin = useIsAdmin();
  const { joined, available, isLoading } = useClasses();
  // Every class in the studio — only teachers and the admin receive rows.
  const {
    classes: studioClasses,
    canSeeAll,
    isLoading: studioLoading,
  } = useAllClasses();
  // Which studio's classes these are, for the admin: the one picked in the
  // sidebar. A teacher's studio is decided by the deployment.
  const { studioId: activeStudioId } = useActiveStudio();
  const createClass = useMutation(api.classes.createClass);
  const joinClass = useMutation(api.classes.joinClass);
  const deleteClass = useMutation(api.classes.deleteClass);

  // A teacher runs their own classes; the admin can set one up for a studio.
  // Staff status comes from the deployment, not the role stored in this
  // browser (see classes.viewerRole).
  const { isStaff: viewerIsStaff } = useViewerIsStaff();
  const canCreate = viewerIsStaff || isAdmin;
  // A teacher (and the admin) sees every class in the studio; until that list
  // arrives — and for anyone else — fall back to the classes this account
  // owns or has joined.
  const rows: ClassOverview[] = canSeeAll
    ? studioClasses
    : available.map((entry) => ({
        ...entry,
        ownerName: "",
        members: 0,
        isMine: false,
        canDelete: false,
      }));
  const loadingList = isLoading || studioLoading;

  const [newClassName, setNewClassName] = useState("");
  const [creating, setCreating] = useState(false);
  const [joinCode, setJoinCode] = useState("");
  const [joining, setJoining] = useState(false);

  const localCodes = storedClassCodes();
  // Content this browser built up before classes existed: offer to move it in.
  const legacyCount =
    vault.classless.media +
    vault.classless.logs +
    vault.classless.messages +
    vault.classless.attendance;
  const activeName =
    rows.find((entry) => entry.code === vault.classCode)?.name ?? null;

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    const name = newClassName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      // A new class belongs to the studio on screen: for the platform admin
      // that is the one picked in the sidebar, for a teacher their own.
      const result = await createClass(
        activeStudioId ? { name, studioId: activeStudioId } : { name },
      );
      if (!result.ok || !result.code) {
        toast.error(result.error ?? "Could not create the class.");
        return;
      }
      // Open the new class straight away so the next upload lands in it.
      setActiveClass(result.code);
      setNewClassName("");
      toast.success(`“${result.name}” created — join code ${result.code}.`);
    } catch (caught) {
      console.error("Create class failed:", caught);
      toast.error("Could not create the class. Check your connection.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async (event: FormEvent) => {
    event.preventDefault();
    if (joining) return;
    if (joinCode.length !== 6) {
      toast.error("A class code is six characters.");
      return;
    }
    setJoining(true);
    try {
      const result = await joinClass({ code: joinCode });
      if (!result.ok || !result.code) {
        toast.error(result.error ?? "Could not join the class.");
        return;
      }
      setActiveClass(result.code);
      setJoinCode("");
      toast.success(`You're in “${result.name}”.`);
    } catch (caught) {
      console.error("Join class failed:", caught);
      toast.error("Could not join the class. Check your connection.");
    } finally {
      setJoining(false);
    }
  };

  const handleDelete = async (entry: ClassOverview) => {
    try {
      const result = await deleteClass({ code: entry.code });
      if (!result.ok) {
        toast.error(result.error ?? "Could not delete the class.");
        return;
      }
      // This browser's copy of the class's vault goes with it, so a deleted
      // class leaves no files or logs taking up storage here.
      forgetClass(entry.code);
      toast.success(`Deleted “${result.name ?? entry.name}”.`);
    } catch (caught) {
      console.error("Delete class failed:", caught);
      toast.error("Could not delete the class. Check your connection.");
    }
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(`Code ${code} copied.`);
    } catch {
      toast.error("Couldn't copy — note the code down instead.");
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header>
        <p className="text-sm font-medium text-muted-foreground">
          {canCreate
            ? canSeeAll
              ? "Every class in your studio"
              : "Classes you run"
            : "Your class"}
        </p>
        <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
          Classes
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every class is its own vault — separate folders, media, practice
          logs, messages, and attendance. Students join with the class code,
          and your Google Drive connection is shared across all of them.
        </p>
      </header>

      {legacyCount > 0 && (
        <Card className="gap-3 border-gold/40 bg-gold/5">
          <CardHeader className="px-5">
            <CardTitle className="flex items-center gap-2 text-base">
              <FolderInput className="size-4 text-gold-foreground" />
              Vault from before classes
            </CardTitle>
            <CardDescription>
              This browser still holds {describeLegacy(vault.classless)} from
              before your classes were split up. Move it into the class you
              have open — files and folders, practice entries, messages, and
              attendance all come along.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 px-5">
            <Button
              type="button"
              variant="outline"
              disabled={!vault.classCode}
              onClick={() => {
                if (!vault.classCode) return;
                adoptClasslessVault(vault.classCode);
                toast.success(
                  `Moved into ${activeName ?? "the class on screen"}.`,
                );
              }}
            >
              <FolderInput />
              Move into {activeName ?? "a class"}
            </Button>
            {!vault.classCode && (
              <p className="text-xs text-muted-foreground">
                Open a class first, then this content can move into it.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {canCreate ? (
        <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
          {/* ------------------------------------------- classes in the studio */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold tracking-tight">
                  <Layers className="size-4 text-gold-foreground" />
                  {canSeeAll ? "All classes" : "Your classes"}
                </h2>
                <p className="text-xs text-muted-foreground">
                  {canSeeAll
                    ? "Every class in the studio — switch into any of them, and keep your code to hand for your own students."
                    : "Share a code with a class — students enter it when they create their account."}
                </p>
              </div>
              {vault.classCode && (
                <Badge
                  variant="outline"
                  className="border-primary/30 bg-primary/5 text-primary"
                >
                  Showing {vault.classCode}
                </Badge>
              )}
            </div>

            <Card data-tour="classes-list" className="gap-0 py-0">
              <CardContent className="divide-y divide-border/70 p-0">
                {loadingList && (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    Loading your classes…
                  </p>
                )}
                {!loadingList && rows.length === 0 && (
                  <p className="px-4 py-6 text-center text-xs text-muted-foreground">
                    No classes yet — create your first one on the right.
                  </p>
                )}
                {rows.map((entry) => {
                  const active = vault.classCode === entry.code;
                  return (
                    <div
                      key={entry.code}
                      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Users className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {entry.name}
                          {active && (
                            <span className="ml-2 text-xs font-normal text-primary">
                              on screen
                            </span>
                          )}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          <span className="font-mono tracking-widest">
                            {entry.code}
                          </span>
                          {canSeeAll && (
                            <>
                              {" · "}
                              {entry.isMine
                                ? "yours"
                                : `run by ${entry.ownerName || "a teacher"}`}
                              {" · "}
                              {entry.members}{" "}
                              {entry.members === 1 ? "student" : "students"}
                            </>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => copyCode(entry.code)}
                        >
                          <Copy className="size-3.5" />
                          <span className="hidden sm:inline">Copy code</span>
                        </Button>
                        <Button
                          type="button"
                          variant={active ? "secondary" : "default"}
                          size="sm"
                          disabled={active}
                          onClick={() => {
                            setActiveClass(entry.code);
                            toast.success(`Now showing “${entry.name}”.`);
                          }}
                        >
                          {active ? (
                            <>
                              <Check className="size-3.5" />
                              Open
                            </>
                          ) : (
                            <>
                              Switch
                              <ArrowRight className="size-3.5" />
                            </>
                          )}
                        </Button>
                        {entry.canDelete && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="text-muted-foreground hover:text-destructive"
                                aria-label={`Delete ${entry.name}`}
                                title="Delete class"
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>
                                  Delete “{entry.name}”?
                                </AlertDialogTitle>
                                <AlertDialogDescription>
                                  This removes the class for everyone: its
                                  join code stops working, its {entry.members}{" "}
                                  {entry.members === 1 ? "student" : "students"}{" "}
                                  lose their class, and its attendance marks
                                  and chat room — messages included — are
                                  deleted on every device. This cannot be
                                  undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => void handleDelete(entry)}
                                >
                                  Delete class
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {localCodes.length > 0 && (
              <p className="text-xs text-muted-foreground">
                This browser holds vaults for{" "}
                <span className="font-mono">{localCodes.join(", ")}</span>.
              </p>
            )}
          </section>

          {/* ---------------------------------------------------- create form */}
          <aside className="flex flex-col gap-6">
            <Card data-tour="classes-new" className="gap-4">
              <CardHeader className="px-5">
                <CardTitle className="text-base">New class</CardTitle>
                <CardDescription>
                  Name it after the class — “Saturday juniors”, for instance.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-5">
                <form onSubmit={handleCreate} className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="class-name">Class name</Label>
                    <Input
                      id="class-name"
                      value={newClassName}
                      onChange={(event) => setNewClassName(event.target.value)}
                      placeholder="e.g. Saturday juniors"
                      maxLength={60}
                      disabled={creating}
                    />
                  </div>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={creating || !newClassName.trim()}
                  >
                    {creating ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Creating…
                      </>
                    ) : (
                      <>
                        <Plus />
                        Create class
                      </>
                    )}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    You get a six-character code to hand out. Every class keeps
                    its own vault; your Drive stays connected for all of them.
                  </p>
                </form>
              </CardContent>
            </Card>

            <Card className="gap-3">
              <CardHeader className="px-5">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HardDrive className="size-4 text-terracotta" />
                  One Drive, many classes
                </CardTitle>
                <CardDescription>
                  Google Drive is connected to your account, so every class
                  uploads to, and imports from, the same Drive.
                </CardDescription>
              </CardHeader>
            </Card>
          </aside>
        </div>
      ) : (
        /* ------------------------------------------------------- student */
        <div className="grid gap-6 lg:grid-cols-2">
          <Card className="gap-4">
            <CardHeader className="px-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4 text-gold-foreground" />
                Your class
              </CardTitle>
              <CardDescription>
                {joined
                  ? `You're in “${joined.name}”. Your vault, practice log, and attendance all belong to this class.`
                  : vault.classCode
                    ? "Setting your class up — it appears here as soon as the deployment confirms it, so there's no need to enter the code again."
                    : "You haven't joined a class yet — enter the code your teacher gave you."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-5">
              {joined && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 bg-background px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {joined.name}
                    </p>
                    <p className="font-mono text-xs tracking-widest text-muted-foreground">
                      {joined.code}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => copyCode(joined.code)}
                    >
                      <Copy className="size-3.5" />
                      Copy
                    </Button>
                    <Button
                      type="button"
                      variant={vault.classCode === joined.code ? "secondary" : "default"}
                      size="sm"
                      disabled={vault.classCode === joined.code}
                      onClick={() => {
                        setActiveClass(joined.code);
                        toast.success(`Now showing “${joined.name}”.`);
                      }}
                    >
                      {vault.classCode === joined.code ? (
                        <>
                          <Check className="size-3.5" />
                          Open
                        </>
                      ) : (
                        "Open"
                      )}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="gap-4">
            <CardHeader className="px-5">
              <CardTitle className="flex items-center gap-2 text-base">
                <KeyRound className="size-4 text-gold-foreground" />
                {joined
                  ? "Moved to another class?"
                  : vault.classCode
                    ? "Join a different class"
                    : "Join with a class code"}
              </CardTitle>
              <CardDescription>
                Enter the six-character code from your teacher to switch
                classes.
              </CardDescription>
            </CardHeader>
            <CardContent className="px-5">
              <form onSubmit={handleJoin} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="join-code">Class code</Label>
                  <Input
                    id="join-code"
                    value={joinCode}
                    onChange={(event) =>
                      setJoinCode(formatClassCode(event.target.value))
                    }
                    placeholder="e.g. K7M2QP"
                    maxLength={6}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono tracking-[0.25em] uppercase"
                    disabled={joining}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={joining || joinCode.length !== 6}
                >
                  {joining ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Joining…
                    </>
                  ) : (
                    <>
                      <ArrowRight />
                      Join class
                    </>
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
