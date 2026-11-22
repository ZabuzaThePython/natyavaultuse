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
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  Copy,
  Layers,
  Loader2,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

/**
 * The studio page — the school above the classes.
 *
 * Its owner can rename the school, share its join code with another teacher,
 * add a teacher by username, and take one out. Everybody's classes are listed
 * here with their member counts, because a studio is the one place that sees
 * the whole school.
 */
export default function Studio() {
  const overview = useQuery(api.studios.studioOverview);
  const renameStudio = useMutation(api.studios.renameStudio);
  const addTeacher = useMutation(api.studios.addTeacher);
  const removeTeacher = useMutation(api.studios.removeTeacher);

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [handle, setHandle] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  if (overview === undefined) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Opening your studio…
      </div>
    );
  }

  if (!overview.ok || overview.studio === null) {
    return (
      <div className="mx-auto w-full max-w-2xl p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle className="tracking-tight">Studio</CardTitle>
            <CardDescription>
              Only a studio's teachers can open this page.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  const studio = overview.studio;
  const draft = nameDraft ?? studio.name;

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingName) return;
    setSavingName(true);
    try {
      const result = await renameStudio({
        studioId: studio.id,
        name: draft.trim(),
      });
      if (!result.ok) {
        toast.error(result.error ?? "Could not rename the studio.");
        return;
      }
      toast.success("Studio renamed.");
      setNameDraft(null);
    } catch (error) {
      console.error("Renaming the studio failed:", error);
      toast.error("Could not rename the studio.");
    } finally {
      setSavingName(false);
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(studio.code);
      setCopied(true);
      toast.success("Studio code copied.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy — read the code off the card.");
    }
  };

  const submitTeacher = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (adding) return;
    const value = handle.trim();
    if (!value) return;
    setAdding(true);
    try {
      const result = await addTeacher({ username: value });
      if (!result.ok) {
        toast.error(result.error ?? "Could not add that teacher.");
        return;
      }
      toast.success(`${result.name ?? value} joined the studio.`);
      setHandle("");
    } catch (error) {
      console.error("Adding a teacher failed:", error);
      toast.error("Could not add that teacher.");
    } finally {
      setAdding(false);
    }
  };

  const dropTeacher = async (id: (typeof overview.teachers)[number]["id"], who: string) => {
    setRemoving(id);
    try {
      const result = await removeTeacher({ userId: id });
      if (!result.ok) {
        toast.error(result.error ?? "Could not remove that teacher.");
        return;
      }
      toast.success(`${who} left the studio.`);
    } catch (error) {
      console.error("Removing a teacher failed:", error);
      toast.error("Could not remove that teacher.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="tracking-tight">{studio.name}</CardTitle>
              <CardDescription>
                Owned by {studio.ownerName} · folder{" "}
                <span className="font-mono text-xs">{studio.folderName}</span>
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="font-mono text-sm">
                {studio.code}
              </Badge>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="cursor-pointer"
                onClick={copyCode}
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
                <span className="ml-1.5">Code</span>
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Another teacher joins your school with this code at sign-up, or you
            can add their username below.
          </p>
          {overview.isOwner ? (
            <form onSubmit={saveName} className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1 space-y-1.5">
                <Label htmlFor="studio-name">Studio name</Label>
                <Input
                  id="studio-name"
                  value={draft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  disabled={savingName}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                className="cursor-pointer"
                disabled={savingName || draft.trim() === studio.name}
              >
                {savingName ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  "Rename"
                )}
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base tracking-tight">
              <Users className="h-4 w-4 text-primary" />
              Teachers
            </CardTitle>
            <CardDescription>
              Everyone who can open this studio's classes.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <ul className="space-y-2">
              {overview.teachers.map((teacher) => (
                <li
                  key={teacher.id}
                  className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{teacher.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {teacher.role === "owner" ? "Owner" : "Teacher"}
                      {teacher.ownsClasses ? " · runs classes" : ""}
                    </p>
                  </div>
                  {overview.isOwner && teacher.role !== "owner" ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="cursor-pointer text-muted-foreground"
                      aria-label={`Remove ${teacher.name}`}
                      disabled={removing === teacher.id || teacher.ownsClasses}
                      onClick={() => dropTeacher(teacher.id, teacher.name)}
                    >
                      {removing === teacher.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>

            {overview.isOwner ? (
              <form onSubmit={submitTeacher} className="flex items-end gap-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Label htmlFor="teacher-handle">Add by username</Label>
                  <Input
                    id="teacher-handle"
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    placeholder="maya.iyer"
                    autoComplete="off"
                    disabled={adding}
                  />
                </div>
                <Button
                  type="submit"
                  className="cursor-pointer"
                  disabled={adding || handle.trim().length === 0}
                >
                  {adding ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="h-4 w-4" />
                  )}
                </Button>
              </form>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base tracking-tight">
              <Layers className="h-4 w-4 text-primary" />
              Classes
            </CardTitle>
            <CardDescription>
              {overview.classes.length === 0
                ? "No classes yet."
                : `${overview.classes.length} in this studio.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {overview.classes.map((row) => (
              <div
                key={row.code}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{row.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {row.ownerName} · {row.members}{" "}
                    {row.members === 1 ? "student" : "students"}
                  </p>
                </div>
                <Badge variant="outline" className="font-mono">
                  {row.code}
                </Badge>
              </div>
            ))}
            <Button
              asChild
              variant="outline"
              className="w-full cursor-pointer"
            >
              <Link to="/dashboard/classes">Manage classes</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
