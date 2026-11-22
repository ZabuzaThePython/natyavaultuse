/**
 * Messages — the studio's chats.
 *
 * A teacher or the admin can start as many named group chats as they like and
 * a solo conversation with one person. The people picker lists every account,
 * so a chat can mix classes. Every class also has its own room, which is where
 * that class's thread lives.
 *
 * Threads are stored on the Convex deployment rather than in this browser, so
 * everyone in a chat sees the same messages on every device, and nothing
 * disappears when the app is redeployed.
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
import { CallDialog } from "@/components/call-room";
import { GifPickerDialog, type PickedGif } from "@/components/gif-picker";
import { NotificationsPrompt } from "@/components/notifications-prompt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import {
  shortChatTitle,
  shortName,
  shortNames,
} from "@/lib/display-name";
import { useViewerIsStaff } from "@/lib/classes";
import { useActiveStudio, useStudioName } from "@/lib/studios";
import { timeAgo, useVault } from "@/lib/vault";
import { useSearchParams } from "react-router";
import {
  ArrowLeft,
  Bell,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Info,
  Link2,
  Loader2,
  MessageSquarePlus,
  MessagesSquare,
  Music2,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  Search,
  Send,
  Trash2,
  UserPlus,
  Users,
  Video,
  X,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";

/** Files larger than this are refused (the bytes go to Convex file storage). */
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

interface PickedAttachment {
  storageId: Id<"_storage">;
  name: string;
  mimeType: string;
  size: number;
  /** Local object URL for the preview before the message is sent. */
  previewUrl: string;
}

interface ChatMessageView {
  id: Id<"chatMessages">;
  authorId: Id<"users">;
  authorName: string;
  authorIsStaff: boolean;
  text: string;
  createdAt: number;
  pinned: boolean;
  deletedBy: "author" | "staff" | null;
  deletedByName: string | null;
  attachment: {
    storageId: Id<"_storage">;
    name: string;
    mimeType: string;
    size: number;
  } | null;
  attachmentUrl: string | null;
  gif: {
    url: string;
    previewUrl: string;
    width: number;
    height: number;
    alt: string;
  } | null;
  isMine: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Initials for the small avatar dot beside a name. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "");
}

/** An attached file in a message: image, audio, video, or a download link. */
function AttachmentView({
  message,
  isOwn,
}: {
  message: ChatMessageView;
  isOwn: boolean;
}) {
  const attachment = message.attachment;
  const src = message.attachmentUrl;
  if (!attachment) return null;
  const tone = isOwn ? "text-primary-foreground" : "text-muted-foreground";

  if (!src) {
    return <p className={`text-xs italic ${tone}`}>Loading attachment…</p>;
  }
  if (attachment.mimeType.startsWith("image/")) {
    return (
      <a href={src} target="_blank" rel="noopener noreferrer" className="block">
        {/* object-contain, never object-cover: a GIF attached from the phone
            was being cropped to a strip, and the 14rem cap left it too small
            to watch. Contain shows the whole animation, at whatever height
            the screen can spare. */}
        <img
          src={src}
          alt={attachment.name}
          className="max-h-[60vh] w-full rounded-xl object-contain sm:max-h-80"
        />
      </a>
    );
  }
  if (attachment.mimeType.startsWith("audio/")) {
    return <audio src={src} controls className="w-full" />;
  }
  if (attachment.mimeType.startsWith("video/")) {
    return <video src={src} controls className="max-h-56 w-full rounded-xl" />;
  }
  return (
    <a
      href={src}
      download={attachment.name}
      className={`flex items-center gap-2 text-xs underline-offset-2 hover:underline ${tone}`}
    >
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </a>
  );
}

/** A GIF sent from the picker: the animation plus its GIPHY credit. */
function GifView({
  gif,
  isOwn,
}: {
  gif: NonNullable<ChatMessageView["gif"]>;
  isOwn: boolean;
}) {
  const tone = isOwn ? "text-primary-foreground/80" : "text-muted-foreground";
  return (
    <div className="flex flex-col gap-1">
      <a
        href={gif.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block w-full overflow-hidden rounded-lg"
        aria-label={gif.alt}
      >
        {/* Fill the bubble's width and let tall (portrait) GIFs use the
            screen: the old 16rem cap left them a narrow strip on a phone. */}
        <img
          src={gif.url}
          alt={gif.alt}
          width={gif.width}
          height={gif.height}
          className="h-auto max-h-[60vh] w-full max-w-full rounded-lg object-contain sm:max-h-80"
        />
      </a>
      <a
        href="https://giphy.com"
        target="_blank"
        rel="noopener noreferrer"
        className={`text-[10px] underline-offset-2 hover:underline ${tone}`}
      >
        via GIPHY
      </a>
    </div>
  );
}

function MessageRow({
  message,
  members,
  canPin,
  canDelete,
  onPin,
  onDelete,
}: {
  message: ChatMessageView;
  /** Everyone in the chat, so a shared first name gains its last initial. */
  members: string[];
  canPin: boolean;
  canDelete: boolean;
  onPin: (message: ChatMessageView) => void;
  onDelete: (message: ChatMessageView) => void;
}) {
  const deleted = Boolean(message.deletedBy);
  return (
    <div
      className={`flex flex-col gap-1 ${
        // A GIF is the message: it gets more of the width to itself, so it is
        // actually watchable on a phone. Text keeps the narrower column.
        message.gif ? "max-w-[92%]" : "max-w-[85%]"
      } ${message.isMine ? "self-end items-end" : "self-start items-start"}`}
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span
          className={`flex size-6 items-center justify-center rounded-full text-[10px] font-semibold ${
            message.authorIsStaff
              ? "bg-terracotta/15 text-terracotta"
              : "bg-primary/10 text-primary"
          }`}
        >
          {initials(message.authorName)}
        </span>
        <span className="font-medium text-foreground">
          {message.isMine ? "You" : shortName(message.authorName, members)}
        </span>
        {message.authorIsStaff && (
          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tracking-wide uppercase">
            teacher
          </span>
        )}
        <span>·</span>
        <span>{timeAgo(message.createdAt)}</span>
      </div>

      {deleted ? (
        <div className="rounded-2xl border border-dashed border-border/70 bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground italic">
          This message was deleted
          {message.deletedByName
            ? ` by ${shortName(message.deletedByName, members)}`
            : message.deletedBy === "author"
              ? " by its author"
              : " by a teacher"}
          .
        </div>
      ) : (
        <div
          className={`flex flex-col gap-2 rounded-2xl px-3.5 py-2.5 text-sm leading-6 ${
            message.isMine
              ? "bg-primary text-primary-foreground"
              : "border border-border/70 bg-card text-foreground"
          } ${message.pinned ? "ring-2 ring-gold" : ""}`}
        >
          <AttachmentView message={message} isOwn={message.isMine} />
          {message.gif && <GifView gif={message.gif} isOwn={message.isMine} />}
          {message.text && (
            <p className="whitespace-pre-wrap break-words">{message.text}</p>
          )}
        </div>
      )}

      {!deleted && (message.pinned || canPin || canDelete) && (
        <div className="flex items-center gap-1">
          {message.pinned && (
            <Badge
              variant="outline"
              className="gap-1 border-gold/40 bg-gold/15 text-gold-foreground"
            >
              <Pin className="size-3" />
              Pinned
            </Badge>
          )}
          {canPin && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground"
              onClick={() => onPin(message)}
              title={message.pinned ? "Unpin message" : "Pin message"}
            >
              {message.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
              {message.pinned ? "Unpin" : "Pin"}
            </Button>
          )}
          {canDelete && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={() => onDelete(message)}
              title="Delete message"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The searchable, class-grouped list of people with a checkbox each. Shared by
 * the "new chat" and "add people" pickers.
 */
function PeoplePicker({
  groups,
  selected,
  toggle,
  search,
  setSearch,
  emptyText,
  idPrefix,
}: {
  groups: {
    label: string;
    people: { id: Id<"users">; name: string; role: string }[];
  }[];
  selected: Id<"users">[];
  toggle: (id: Id<"users">) => void;
  search: string;
  setSearch: (value: string) => void;
  emptyText: string;
  /** Keeps the checkbox ids apart when two pickers share a page. */
  idPrefix: string;
}) {
  // Shortened from the people on screen, so two of the same first name pick up
  // their last initial here too (see lib/display-name).
  const labels = shortNames(
    groups.flatMap((group) => group.people.map((person) => person.name)),
  );

  return (
    <>
      <Input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search people…"
        aria-label="Search people"
      />

      <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70">
        {groups.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            {emptyText}
          </p>
        ) : (
          groups.map((groupBlock) => (
            <div key={groupBlock.label}>
              <p className="sticky top-0 z-10 bg-muted/80 px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                {groupBlock.label}
              </p>
              {groupBlock.people.map((person) => (
                <label
                  key={person.id}
                  htmlFor={`${idPrefix}-${person.id}`}
                  className="flex cursor-pointer items-center gap-3 border-t border-border/50 px-3 py-2.5 text-sm hover:bg-accent/50"
                >
                  <Checkbox
                    id={`${idPrefix}-${person.id}`}
                    checked={selected.includes(person.id)}
                    onCheckedChange={() => toggle(person.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {labels.get(person.name) ?? person.name}
                  </span>
                  {person.role === "teacher" && (
                    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                      teacher
                    </span>
                  )}
                </label>
              ))}
            </div>
          ))
        )}
      </div>
    </>
  );
}

/** The "new chat" picker: everyone in the studio, grouped by class. */
function NewChatDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (chatId: Id<"chats">) => void;
}) {
  // Only the people of the studio on screen: the platform admin otherwise gets
  // every account on the deployment.
  const { studioId } = useActiveStudio();
  const people = useQuery(
    api.chats.people,
    open ? (studioId ? { studioId } : {}) : "skip",
  );
  const createChat = useMutation(api.chats.createChat);
  const [title, setTitle] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"users">[]>([]);
  const [creating, setCreating] = useState(false);

  // A closed dialog always reopens empty, so a previous pick is never sent.
  const changeOpen = (next: boolean) => {
    if (!next) {
      setTitle("");
      setSearch("");
      setSelected([]);
      setCreating(false);
    }
    onOpenChange(next);
  };

  const query = search.trim().toLowerCase();
  const groups = (people?.groups ?? [])
    .map((group) => ({
      label: group.label,
      people: group.people.filter(
        (person) => !query || person.name.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.people.length > 0);

  const toggle = (id: Id<"users">) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  const solo = selected.length === 1;
  const group = selected.length > 1;

  const create = async () => {
    if (selected.length === 0) return;
    setCreating(true);
    try {
      const result = await createChat({
        title: group ? title.trim() : undefined,
        memberIds: selected,
      });
      if (!result.ok || result.chatId === null) {
        toast.error(result.error ?? "Couldn't start that chat.");
        return;
      }
      toast.success(solo ? "Conversation opened." : "Group chat created.");
      changeOpen(false);
      onCreated(result.chatId);
    } catch (error) {
      console.error("Create chat failed:", error);
      toast.error("Couldn't start that chat. Try again.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New chat</DialogTitle>
          <DialogDescription>
            Pick anyone from the studio — students from different classes can
            share a chat. One person starts a private conversation; two or more
            start a group.
          </DialogDescription>
        </DialogHeader>

        {!people?.ok ? (
          <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
            {people === undefined
              ? "Loading people…"
              : "Only a teacher or the admin can start a chat."}
          </p>
        ) : (
          <>
            <PeoplePicker
              groups={groups}
              selected={selected}
              toggle={toggle}
              search={search}
              setSearch={setSearch}
              emptyText="No one matches that search."
              idPrefix="pick"
            />

            {group && (
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Group name (optional)"
                maxLength={80}
                aria-label="Group name"
              />
            )}

            <p className="text-xs text-muted-foreground">
              {selected.length === 0
                ? "Nobody selected yet."
                : solo
                  ? "Private conversation — only the two of you can read it."
                  : `${selected.length} people — this will be a group chat.`}
            </p>
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void create()}
            disabled={!people?.ok || selected.length === 0 || creating}
          >
            {creating ? <Loader2 className="animate-spin" /> : <Plus />}
            {solo ? "Start conversation" : "Create group"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "New call": choose the people first, then start the call with them.
 *
 * A call needs a chat behind it — that is what carries membership, the
 * notification and the "call in progress" banner — so this creates (or reuses)
 * the conversation with the people picked, then opens the call in it.
 */
function NewCallDialog({
  open,
  onOpenChange,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (chatId: Id<"chats">) => void;
}) {
  const { studioId } = useActiveStudio();
  const people = useQuery(
    api.chats.people,
    open ? (studioId ? { studioId } : {}) : "skip",
  );
  const createChat = useMutation(api.chats.createChat);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"users">[]>([]);
  const [starting, setStarting] = useState(false);

  // A closed dialog always reopens empty, so a previous pick is never called.
  const changeOpen = (next: boolean) => {
    if (!next) {
      setSearch("");
      setSelected([]);
      setStarting(false);
    }
    onOpenChange(next);
  };

  const everyone = (people?.groups ?? []).flatMap((group) => group.people);
  const query = search.trim().toLowerCase();
  const groups = (people?.groups ?? [])
    .map((group) => ({
      label: group.label,
      people: group.people.filter(
        (person) => !query || person.name.toLowerCase().includes(query),
      ),
    }))
    .filter((group) => group.people.length > 0);

  const toggle = (id: Id<"users">) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  const start = async () => {
    if (selected.length === 0) return;
    setStarting(true);
    try {
      // One pick reuses the private conversation with that person; more make a
      // group named after everyone who was invited.
      const result = await createChat({ memberIds: selected });
      if (!result.ok || result.chatId === null) {
        toast.error(result.error ?? "Couldn't start that call.");
        return;
      }
      changeOpen(false);
      onStarted(result.chatId);
    } catch (error) {
      console.error("Start call failed:", error);
      toast.error("Couldn't start that call. Try again.");
    } finally {
      setStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New call</DialogTitle>
          <DialogDescription>
            Search for the people you want on the call — anyone, from any class.
            They get a notification, and the call opens for you straight away.
          </DialogDescription>
        </DialogHeader>

        {!people?.ok ? (
          <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
            {people === undefined
              ? "Loading people…"
              : "Only a teacher or the admin can start a call."}
          </p>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search people…"
                aria-label="Search people"
                className="pl-9"
                autoFocus
              />
            </div>

            {selected.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {selected.map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggle(id)}
                    className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] text-primary transition-colors hover:bg-primary/20"
                    title="Remove from the call"
                  >
                    {shortName(
                      everyone.find((person) => person.id === id)?.name ??
                        "Selected",
                      everyone.map((person) => person.name),
                    )}
                    <X className="size-3" />
                  </button>
                ))}
              </div>
            )}

            <div className="max-h-72 overflow-y-auto rounded-lg border border-border/70">
              {groups.length === 0 ? (
                <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No one matches that search.
                </p>
              ) : (
                groups.map((groupBlock) => (
                  <div key={groupBlock.label}>
                    <p className="sticky top-0 z-10 bg-muted/80 px-3 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                      {groupBlock.label}
                    </p>
                    {groupBlock.people.map((person) => (
                      <label
                        key={person.id}
                        htmlFor={`call-${person.id}`}
                        className="flex cursor-pointer items-center gap-3 border-t border-border/50 px-3 py-2.5 text-sm hover:bg-accent/50"
                      >
                        <Checkbox
                          id={`call-${person.id}`}
                          checked={selected.includes(person.id)}
                          onCheckedChange={() => toggle(person.id)}
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {shortName(
                            person.name,
                            groups.flatMap((group) =>
                              group.people.map((entry) => entry.name),
                            ),
                          )}
                        </span>
                        {person.role === "teacher" && (
                          <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                            teacher
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                ))
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              {selected.length === 0
                ? "Search for someone, or scroll the list, then tick who you want."
                : `${selected.length} ${
                    selected.length === 1 ? "person" : "people"
                  } on the call.`}
            </p>
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="gap-2"
            onClick={() => void start()}
            disabled={!people?.ok || selected.length === 0 || starting}
          >
            {starting ? <Loader2 className="animate-spin" /> : <Video />}
            Start call
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ChatMediaItem {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  url: string | null;
  authorName: string;
  createdAt: number;
}

function MediaItemCard({
  item,
  authorLabel,
}: {
  item: ChatMediaItem;
  authorLabel: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-card p-2.5">
      <div className="flex items-center gap-2">
        {item.mimeType.startsWith("video/") ? (
          <Video className="size-3.5 shrink-0 text-muted-foreground" />
        ) : item.mimeType.startsWith("audio/") ? (
          <Music2 className="size-3.5 shrink-0 text-muted-foreground" />
        ) : item.mimeType.startsWith("image/") ? (
          <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-xs font-medium underline-offset-2 hover:underline"
          >
            {item.name}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
            {item.name} (unavailable)
          </span>
        )}
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
          {formatBytes(item.size)}
        </span>
      </div>

      {item.url && item.mimeType.startsWith("video/") && (
        <video
          src={item.url}
          controls
          preload="metadata"
          className="mt-2 max-h-40 w-full rounded-md"
        />
      )}
      {item.url && item.mimeType.startsWith("audio/") && (
        <audio src={item.url} controls preload="metadata" className="mt-2 w-full" />
      )}
      {item.url && item.mimeType.startsWith("image/") && (
        <a href={item.url} target="_blank" rel="noopener noreferrer">
          <img
            src={item.url}
            alt={item.name}
            className="mt-2 max-h-40 w-full rounded-md object-cover"
          />
        </a>
      )}

      <p className="mt-1.5 text-[10px] text-muted-foreground">
        {authorLabel} · {timeAgo(item.createdAt)}
      </p>
    </div>
  );
}

/** "Add people": everyone in the studio who isn't in this chat yet. */
function AddMembersDialog({
  chatId,
  existing,
  open,
  onOpenChange,
}: {
  chatId: Id<"chats">;
  /** Accounts already in the chat, so they are not offered again. */
  existing: Id<"users">[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The room's class decides who may join, so the picker asks from its side;
  // the studio on screen narrows an open group chat to its own people.
  const { studioId } = useActiveStudio();
  const people = useQuery(
    api.chats.people,
    open ? (studioId ? { chatId, studioId } : { chatId }) : "skip",
  );
  const addMembers = useMutation(api.chats.addMembers);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Id<"users">[]>([]);
  const [adding, setAdding] = useState(false);

  // A closed dialog always reopens empty, so a previous pick is never sent.
  const changeOpen = (next: boolean) => {
    if (!next) {
      setSearch("");
      setSelected([]);
      setAdding(false);
    }
    onOpenChange(next);
  };

  const query = search.trim().toLowerCase();
  const groups = (people?.groups ?? [])
    .map((group) => ({
      label: group.label,
      people: group.people.filter(
        (person) =>
          !existing.includes(person.id) &&
          (!query || person.name.toLowerCase().includes(query)),
      ),
    }))
    .filter((group) => group.people.length > 0);

  const toggle = (id: Id<"users">) => {
    setSelected((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  const add = async () => {
    if (selected.length === 0) return;
    setAdding(true);
    try {
      const result = await addMembers({ chatId, memberIds: selected });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't add them to the chat.");
        return;
      }
      if (result.added === 0) {
        toast.error("No one was added — they aren't in this class's room.");
        return;
      }
      if (result.skipped > 0) {
        toast.error(`${result.skipped} skipped — not in this class's room.`);
      }
      toast.success(
        result.added === 1 ? "Added to the chat." : `${result.added} people added.`,
      );
      changeOpen(false);
    } catch (error) {
      console.error("Add members failed:", error);
      toast.error("Couldn't add them to the chat. Try again.");
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add people</DialogTitle>
          <DialogDescription>
            Pick who joins this chat. A class room only takes that class's
            students and its teachers.
          </DialogDescription>
        </DialogHeader>

        {!people?.ok ? (
          <p className="rounded-lg border border-border/70 bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground">
            {people === undefined
              ? "Loading people…"
              : "Only a teacher or the admin can add people."}
          </p>
        ) : (
          <>
            <PeoplePicker
              groups={groups}
              selected={selected}
              toggle={toggle}
              search={search}
              setSearch={setSearch}
              emptyText="Everyone is already in this chat."
              idPrefix="add"
            />

            <p className="text-xs text-muted-foreground">
              {selected.length === 0
                ? "Nobody selected yet."
                : `${selected.length} to add.`}
            </p>
          </>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => changeOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={() => void add()}
            disabled={!people?.ok || selected.length === 0 || adding}
          >
            {adding ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The chat's details: who is in it, every video/recording/photo/file anyone has
 * sent (grouped by kind), and every link posted, so they can be found again
 * without scrolling the thread. Staff can name the chat here too.
 */
function ChatDetailsDialog({
  chatId,
  open,
  onOpenChange,
  isStaff,
}: {
  chatId: Id<"chats"> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isStaff: boolean;
}) {
  const details = useQuery(
    api.chats.details,
    open && chatId ? { chatId } : "skip",
  );
  const renameChat = useMutation(api.chats.rename);
  const removeChat = useMutation(api.chats.remove);
  const removeMember = useMutation(api.chats.removeMember);
  const [savingName, setSavingName] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [addingOpen, setAddingOpen] = useState(false);

  const saveName = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!chatId) return;
    const title = String(new FormData(event.currentTarget).get("title") ?? "");
    setSavingName(true);
    try {
      const result = await renameChat({ chatId, title });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't name this chat.");
        return;
      }
      toast.success("Chat name saved.");
    } catch (error) {
      console.error("Rename failed:", error);
      toast.error("Couldn't name this chat. Try again.");
    } finally {
      setSavingName(false);
    }
  };

  const remove = async () => {
    if (!chatId) return;
    setDeleting(true);
    try {
      const result = await removeChat({ chatId });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't delete this chat.");
        return;
      }
      toast.success(
        result.global
          ? "Chat deleted for everyone."
          : "Chat deleted from your list.",
      );
      onOpenChange(false);
    } catch (error) {
      console.error("Delete chat failed:", error);
      toast.error("Couldn't delete this chat. Try again.");
    } finally {
      setDeleting(false);
    }
  };

  /** Take somebody out of the chat; they lose access to it and its history. */
  const kick = async (userId: Id<"users">, name: string) => {
    if (!chatId) return;
    try {
      const result = await removeMember({ chatId, userId });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't remove them from the chat.");
        return;
      }
      toast.success(`${shortName(name)} was removed from the chat.`);
    } catch (error) {
      console.error("Remove member failed:", error);
      toast.error("Couldn't remove them from the chat. Try again.");
    }
  };

  const media: ChatMediaItem[] = details?.media ?? [];
  const videos = media.filter((item) => item.mimeType.startsWith("video/"));
  const recordings = media.filter((item) => item.mimeType.startsWith("audio/"));
  const photos = media.filter((item) => item.mimeType.startsWith("image/"));
  const files = media.filter(
    (item) =>
      !item.mimeType.startsWith("video/") &&
      !item.mimeType.startsWith("audio/") &&
      !item.mimeType.startsWith("image/"),
  );

  const detailMembers = (details?.members ?? []).map((member) => member.name);
  const memberLabels = shortNames(detailMembers);
  // Staff can change who is in a group chat, unless the room is frozen
  // (history only).
  const canManage =
    isStaff && details?.readOnly !== true && details?.chat?.kind === "group";
  const authorLabels = shortNames([
    ...detailMembers,
    ...(details?.media ?? []).map((item) => item.authorName),
    ...(details?.links ?? []).map((link) => link.authorName),
  ]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-3 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="truncate">
            {details?.chat
              ? shortChatTitle(details.chat.title, detailMembers)
              : "Chat details"}
          </DialogTitle>
          <DialogDescription>
            {details?.chat?.isClassChat
              ? "Class room"
              : details?.chat?.kind === "solo"
                ? "Private conversation"
                : "Group chat"}
            {details?.chat?.createdByName
              ? ` · started by ${shortName(
                  details.chat.createdByName,
                  detailMembers,
                )}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {details === undefined ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            Loading chat…
          </p>
        ) : !details.ok || !details.chat ? (
          <p className="px-2 py-8 text-center text-sm text-muted-foreground">
            This chat isn't available to you.
          </p>
        ) : (
          <>
            {!details.readOnly && (
              <form onSubmit={saveName} className="flex items-center gap-2">
                <Input
                  key={`${details.chat.id}-${details.chat.name}`}
                  name="title"
                  defaultValue={details.chat.name}
                  placeholder={
                    details.chat.kind === "solo"
                      ? "Name this conversation (optional)"
                      : "Name this group"
                  }
                  aria-label="Chat name"
                  maxLength={80}
                />
                <Button
                  type="submit"
                  variant="outline"
                  className="shrink-0"
                  disabled={savingName}
                >
                  {savingName ? <Loader2 className="size-4 animate-spin" /> : "Save"}
                </Button>
              </form>
            )}

            <Tabs defaultValue="members" className="min-h-0">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="members">
                  Members {details.members.length}
                </TabsTrigger>
                <TabsTrigger value="media">
                  Media {details.media.length}
                </TabsTrigger>
                <TabsTrigger value="links">
                  Links {details.links.length}
                </TabsTrigger>
              </TabsList>

              <div className="max-h-[46vh] overflow-y-auto pr-1">
                <TabsContent value="members" className="mt-2 flex flex-col gap-0.5">
                  {canManage && (
                    <Button
                      type="button"
                      variant="outline"
                      className="mb-1 h-8 justify-start gap-2 text-xs"
                      onClick={() => setAddingOpen(true)}
                    >
                      <UserPlus className="size-3.5" />
                      Add people
                    </Button>
                  )}
                  {details.members.map((member) => (
                    <div
                      key={member.id}
                      className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-accent/40"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                        {initials(member.name)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {memberLabels.get(member.name) ?? member.name}
                      </span>
                      {member.isMe && (
                        <Badge variant="secondary" className="text-[10px]">
                          you
                        </Badge>
                      )}
                      {!member.isMe && canManage && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                              aria-label={`Remove ${member.name} from this chat`}
                              title="Remove from chat"
                            >
                              <X className="size-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>
                                Remove{" "}
                                {memberLabels.get(member.name) ?? member.name}?
                              </AlertDialogTitle>
                              <AlertDialogDescription>
                                They leave this chat and lose access to its
                                messages. You can add them back later.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => void kick(member.id, member.name)}
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  ))}
                  {details.chat && (
                    <AddMembersDialog
                      chatId={details.chat.id}
                      existing={details.members.map((member) => member.id)}
                      open={addingOpen}
                      onOpenChange={setAddingOpen}
                    />
                  )}
                </TabsContent>

                <TabsContent value="media" className="mt-2 flex flex-col gap-4">
                  {media.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      Nothing has been sent in this chat yet.
                    </p>
                  ) : (
                    <>
                      {videos.length > 0 && (
                        <section className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Videos · {videos.length}
                          </p>
                          {videos.map((item) => (
                            <MediaItemCard
                              key={item.id}
                              item={item}
                              authorLabel={
                                authorLabels.get(item.authorName) ??
                                item.authorName
                              }
                            />
                          ))}
                        </section>
                      )}
                      {recordings.length > 0 && (
                        <section className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Audio · {recordings.length}
                          </p>
                          {recordings.map((item) => (
                            <MediaItemCard
                              key={item.id}
                              item={item}
                              authorLabel={
                                authorLabels.get(item.authorName) ??
                                item.authorName
                              }
                            />
                          ))}
                        </section>
                      )}
                      {photos.length > 0 && (
                        <section className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Photos · {photos.length}
                          </p>
                          {photos.map((item) => (
                            <MediaItemCard
                              key={item.id}
                              item={item}
                              authorLabel={
                                authorLabels.get(item.authorName) ??
                                item.authorName
                              }
                            />
                          ))}
                        </section>
                      )}
                      {files.length > 0 && (
                        <section className="flex flex-col gap-2">
                          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                            Files · {files.length}
                          </p>
                          {files.map((item) => (
                            <MediaItemCard
                              key={item.id}
                              item={item}
                              authorLabel={
                                authorLabels.get(item.authorName) ??
                                item.authorName
                              }
                            />
                          ))}
                        </section>
                      )}
                    </>
                  )}
                </TabsContent>

                <TabsContent value="links" className="mt-2 flex flex-col gap-2">
                  {details.links.length === 0 ? (
                    <p className="py-8 text-center text-sm text-muted-foreground">
                      No links have been posted in this chat.
                    </p>
                  ) : (
                    details.links.map((link) => (
                      <a
                        key={`${link.url}-${link.createdAt}`}
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-2 rounded-lg border border-border/70 bg-card p-2.5 hover:bg-accent/40"
                      >
                        <Link2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs font-medium underline-offset-2 hover:underline">
                            {link.url}
                          </span>
                          <span className="block text-[10px] text-muted-foreground">
                            {authorLabels.get(link.authorName) ??
                              link.authorName}{" "}
                            · {timeAgo(link.createdAt)}
                          </span>
                        </span>
                        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                      </a>
                    ))
                  )}
                </TabsContent>
              </div>
            </Tabs>

            <div className="flex flex-col gap-1.5 border-t border-border/70 pt-3">
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    className="gap-2 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                    {isStaff
                      ? "Delete chat for everyone"
                      : "Delete chat for me"}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {isStaff
                        ? "Delete this chat for everyone?"
                        : "Delete this chat for you?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {isStaff
                        ? "Every message and file in it goes for everybody in the chat. This can't be undone."
                        : "It leaves your list and your history. Everyone else keeps chatting, and it comes back if somebody posts again."}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={() => void remove()}
                      disabled={deleting}
                    >
                      {deleting ? "Deleting…" : "Delete"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <p className="text-[11px] text-muted-foreground">
                {isStaff
                  ? "As a teacher or the admin, this deletes the chat for the whole studio."
                  : "This only removes the chat from your side."}
              </p>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function Messages() {
  const { user } = useAuth();
  const vault = useVault();
  const { isStaff } = useViewerIsStaff();
  // The platform admin looks at one studio at a time: the picker in the shell
  // decides whose class rooms and people are in this list.
  const { studioId: activeStudioId } = useActiveStudio();
  // The studio name the teacher gave, shown above the title.
  const studioName = useStudioName();
  // Ships off: the admin turns GIFs on from the Admin area.
  const gifsEnabled = useQuery(api.admin.gifsEnabled) === true;

  const chats = useQuery(
    api.chats.myChats,
    activeStudioId ? { studioId: activeStudioId } : {},
  );
  const ensureClassChat = useMutation(api.chats.ensureClassChat);
  const ensureAllClassChats = useMutation(api.chats.ensureAllClassChats);
  const markRead = useMutation(api.chats.markRead);
  const sendMessage = useMutation(api.chats.send);
  const setPinned = useMutation(api.chats.setPinned);
  const removeMessage = useMutation(api.chats.removeMessage);
  const createUploadUrl = useMutation(api.chats.uploadUrl);

  const [selectedId, setSelectedId] = useState<Id<"chats"> | null>(null);
  // On a phone only one pane fits: this says which one is on screen.
  const [showList, setShowList] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [gifOpen, setGifOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [newCallOpen, setNewCallOpen] = useState(false);
  // A chat just created by "New call", waiting to appear in the list before
  // the call opens in it.
  const [pendingCallId, setPendingCallId] = useState<Id<"chats"> | null>(null);
  const [notifyOpen, setNotifyOpen] = useState(false);
  // A notification tap opens /dashboard/messages?chat=<id>.
  const [searchParams] = useSearchParams();
  const chatFromUrl = searchParams.get("chat");
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<PickedAttachment | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const ensuredFor = useRef<string | null>(null);

  // Each class has one room. A teacher sees every class's room in their studio,
  // and the admin those of the studio they are viewing, so all of them are
  // opened (and joined) on arrival; a student only gets the room of the class
  // they joined. Switching studio opens the rooms of the new one.
  useEffect(() => {
    const key = isStaff ? `staff:${activeStudioId ?? ""}` : vault.classCode;
    if (!key || ensuredFor.current === key) return;
    ensuredFor.current = key;
    const opening = isStaff
      ? ensureAllClassChats(activeStudioId ? { studioId: activeStudioId } : {})
      : ensureClassChat({ code: vault.classCode ?? "" });
    void opening.catch((error) => {
      // Let the next render try again.
      ensuredFor.current = null;
      console.error("Could not open the class rooms:", error);
    });
  }, [
    isStaff,
    vault.classCode,
    activeStudioId,
    ensureClassChat,
    ensureAllClassChats,
  ]);

  const list = chats ?? [];
  const selected =
    list.find((chat) => chat.id === selectedId) ??
    list.find((chat) => chat.id === chatFromUrl) ??
    list[0] ??
    null;
  const selectedChatId = selected?.id ?? null;
  const thread = useQuery(
    api.chats.thread,
    selectedChatId ? { chatId: selectedChatId } : "skip",
  );

  const messages = thread?.messages ?? [];
  // A class room the account has moved on from: history only (see chatAccess).
  const readOnly = thread?.readOnly === true;
  // Everyone in the open chat. Names are stored whole and shortened only on
  // screen, so a shared first name can pick up its last initial
  // (see lib/display-name).
  const memberNames = selected?.members ?? [];
  const shortMembers = shortNames(memberNames);

  // A call in this chat that somebody is still in. It follows the heartbeat
  // each participant sends (see convex/callState.ts), so it disappears when
  // the call really does.
  const liveCall = useQuery(
    api.callState.live,
    selectedChatId ? { chatId: selectedChatId } : "skip",
  );

  // "New call" creates the conversation first, so the call only opens once
  // that chat is in the list — otherwise it would open in whatever chat
  // happened to be selected a moment earlier.
  const pendingCallReady =
    pendingCallId !== null && list.some((chat) => chat.id === pendingCallId);
  const callChatId = pendingCallReady ? pendingCallId : selectedChatId;
  const callChat =
    list.find((chat) => chat.id === callChatId) ?? selected ?? null;

  // Opening a chat (or a new message landing in the open one) marks it read.
  useEffect(() => {
    if (!selectedChatId) return;
    void markRead({ chatId: selectedChatId }).catch(() => {});
  }, [selectedChatId, messages.length, markRead]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [messages.length, selectedChatId]);

  const clearAttachment = () => {
    if (attachment) URL.revokeObjectURL(attachment.previewUrl);
    setAttachment(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  // A different chat starts with an empty composer, so nothing is sent to the
  // wrong thread.
  const openChat = (chatId: Id<"chats"> | null) => {
    setDraft("");
    clearAttachment();
    setDetailsOpen(false);
    setGifOpen(false);
    setShowList(false);
    setSelectedId(chatId);
  };

  const pickAttachment = async (file: File) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      toast.error(`Files up to ${formatBytes(MAX_ATTACHMENT_BYTES)} only.`);
      return;
    }
    setAttachBusy(true);
    try {
      const uploadUrl = await createUploadUrl({});
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status})`);
      const { storageId } = (await response.json()) as {
        storageId: Id<"_storage">;
      };
      if (attachment) URL.revokeObjectURL(attachment.previewUrl);
      setAttachment({
        storageId,
        name: file.name || "attachment",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        previewUrl: URL.createObjectURL(file),
      });
    } catch (error) {
      console.error("Attachment upload failed:", error);
      toast.error("Couldn't upload that file. Try again.");
    } finally {
      setAttachBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  /** A picked GIF is sent on its own, like Google Chat does. */
  const sendGif = async (gif: PickedGif) => {
    if (!selected) return;
    setGifOpen(false);
    setSending(true);
    try {
      // Send only the fields chats.send validates. The search result also
      // carries GIPHY's `id`, and Convex rejects an object with an extra
      // field ("Object contains extra field `id`"), which failed the send.
      const result = await sendMessage({
        chatId: selected.id,
        text: "",
        gif: {
          url: gif.url,
          previewUrl: gif.previewUrl,
          width: gif.width,
          height: gif.height,
          alt: gif.alt,
        },
      });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't send that GIF.");
      }
    } catch (error) {
      console.error("GIF send failed:", error);
      toast.error("Couldn't send that GIF. Try again.");
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (!selected) return;
    const text = draft.trim();
    if (!text && !attachment) return;
    setSending(true);
    try {
      const result = await sendMessage({
        chatId: selected.id,
        text,
        ...(attachment
          ? {
              attachment: {
                storageId: attachment.storageId,
                name: attachment.name,
                mimeType: attachment.mimeType,
                size: attachment.size,
              },
            }
          : {}),
      });
      if (!result.ok) {
        toast.error(result.error ?? "Couldn't send that message.");
        return;
      }
      setDraft("");
      clearAttachment();
    } catch (error) {
      console.error("Send failed:", error);
      toast.error("Couldn't send that message. Try again.");
    } finally {
      setSending(false);
    }
  };

  const togglePin = async (message: ChatMessageView) => {
    try {
      const result = await setPinned({
        messageId: message.id,
        pinned: !message.pinned,
      });
      if (!result.ok) toast.error("Only a teacher can pin messages.");
    } catch (error) {
      console.error("Pin failed:", error);
      toast.error("Couldn't update that message.");
    }
  };

  const deleteMessage = async (message: ChatMessageView) => {
    try {
      const result = await removeMessage({ messageId: message.id });
      if (!result.ok) toast.error("You can't delete that message.");
    } catch (error) {
      console.error("Delete failed:", error);
      toast.error("Couldn't delete that message.");
    }
  };

  const canDelete = (message: ChatMessageView) => message.isMine || isStaff;
  // Same fallbacks the server uses, so "You:" lines up with what was stored.
  const chatName = user?.name ?? user?.email ?? "Member";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-muted-foreground">
            {studioName ?? "Your studio"}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">
            Messages
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your class room and any conversations you're part of.
          </p>
        </div>
        <div
          data-tour="messages-actions"
          className="flex flex-wrap items-center gap-2"
        >
          <Button
            type="button"
            variant="outline"
            className="h-10 gap-2"
            onClick={() => setNotifyOpen(true)}
          >
            <Bell className="size-4" />
            <span className="hidden sm:inline">Notifications</span>
            <span className="sr-only sm:hidden">Notifications</span>
          </Button>
          {isStaff && (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-10 gap-2"
                onClick={() => setNewCallOpen(true)}
              >
                <Video className="size-4" />
                <span className="hidden sm:inline">New call</span>
                <span className="sr-only sm:hidden">New call</span>
              </Button>
              <Button
                type="button"
                className="h-10 gap-2"
                onClick={() => setNewChatOpen(true)}
              >
                <MessageSquarePlus className="size-4" />
                New chat
              </Button>
            </>
          )}
        </div>
      </header>

      <div className="grid gap-3 md:grid-cols-[minmax(0,19rem)_1fr]">
        {/* Conversation list */}
        <Card
          data-tour="messages-list"
          className={`flex h-[calc(100dvh-12rem)] min-h-[22rem] max-h-[46rem] flex-col gap-0 overflow-hidden py-0 sm:min-h-[26rem] ${
            showList || !selected ? "flex" : "hidden md:flex"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border/70 px-3 py-2.5">
            <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              Chats
            </p>
            <Badge variant="secondary">{list.length}</Badge>
          </div>
          <div className="flex-1 overflow-y-auto">
            {chats === undefined ? (
              <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                Loading chats…
              </p>
            ) : list.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <MessagesSquare className="size-7 text-muted-foreground" />
                <p className="text-sm font-medium">No chats yet</p>
                <p className="text-xs text-muted-foreground">
                  {isStaff
                    ? "Start a group with anyone in the studio, or a private conversation with one person."
                    : "Your teacher can start a group or private chat with you."}
                </p>
              </div>
            ) : (
              list.map((chat) => {
                const active = chat.id === selected?.id;
                return (
                  <button
                    key={chat.id}
                    type="button"
                    onClick={() => openChat(chat.id)}
                    className={`flex w-full items-start gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors ${
                      active ? "bg-accent/70" : "hover:bg-accent/40"
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full ${
                        chat.isClassChat
                          ? "bg-terracotta/15 text-terracotta"
                          : "bg-primary/10 text-primary"
                      }`}
                    >
                      {chat.kind === "solo" ? (
                        <MessagesSquare className="size-4" />
                      ) : (
                        <Users className="size-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {shortChatTitle(chat.title, chat.members ?? [])}
                        </span>
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {chat.lastMessageText ? timeAgo(chat.lastMessageAt) : ""}
                        </span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {chat.lastMessageText
                            ? `${
                                chat.lastMessageAuthor === chatName
                                  ? "You"
                                  : shortName(
                                      chat.lastMessageAuthor,
                                      chat.members ?? [],
                                    )
                              }: ${chat.lastMessageText}`
                            : chat.isClassChat
                              ? "Class room — say hello"
                              : "No messages yet"}
                        </span>
                        {chat.unread > 0 && !active && (
                          <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground">
                            {chat.unread > 9 ? "9+" : chat.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </Card>

        {/* Thread */}
        <Card
          data-tour="messages-thread"
          className={`flex h-[calc(100dvh-12rem)] min-h-[22rem] max-h-[46rem] flex-col gap-0 overflow-hidden py-0 sm:min-h-[26rem] ${
            showList || !selected ? "hidden md:flex" : "flex"
          }`}
        >
          {!selected ? (
            <CardContent className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <MessagesSquare className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">Pick a chat</p>
              <p className="max-w-xs text-xs text-muted-foreground">
                {isStaff
                  ? "Choose a conversation on the left, or start a new one."
                  : "Choose a conversation on the left."}
              </p>
              {isStaff && (
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 gap-2"
                  onClick={() => setNewChatOpen(true)}
                >
                  <MessageSquarePlus className="size-4" />
                  New chat
                </Button>
              )}
            </CardContent>
          ) : (
            <>
              <div className="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="md:hidden"
                  aria-label="Back to chats"
                  onClick={() => setShowList(true)}
                >
                  <ArrowLeft className="size-4" />
                </Button>
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
                    <span className="truncate">
                      {shortChatTitle(selected.title, memberNames)}
                    </span>
                    {selected.isClassChat && (
                      <Badge
                        variant="outline"
                        className="border-terracotta/40 bg-terracotta/10 text-[10px] text-terracotta"
                      >
                        Class room
                      </Badge>
                    )}
                    {selected.kind === "solo" && (
                      <Badge
                        variant="outline"
                        className="shrink-0 text-[10px]"
                      >
                        Private
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {selected.kind === "solo"
                      ? "Only the two of you can read this conversation."
                      : `${selected.memberCount} people: ${memberNames
                          .slice(0, 4)
                          .map((name) => shortMembers.get(name) ?? name)
                          .join(", ")}${
                          memberNames.length > 4
                            ? ` +${memberNames.length - 4}`
                            : ""
                        }`}
                  </p>
                </div>
                {!readOnly && (
                  <Button
                    type="button"
                    variant={liveCall ? "default" : "ghost"}
                    size="icon-sm"
                    aria-label={
                      liveCall ? "Join the call" : "Start an audio or video call"
                    }
                    title={liveCall ? "Join the call" : "Start a call"}
                    onClick={() => setCallOpen(true)}
                  >
                    <Video className="size-4" />
                  </Button>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Chat details"
                  title="Members, media and links"
                  onClick={() => setDetailsOpen(true)}
                >
                  <Info className="size-4" />
                </Button>
              </div>

              {readOnly && (
                <div className="border-b border-border/70 bg-muted/60 px-3 py-2 text-[11px] text-muted-foreground">
                  You changed class, so this room stops where you left it. The
                  history is still here; new messages and calls don't reach you.
                </div>
              )}

              {liveCall && !callOpen && (
                <div className="flex items-center gap-2 border-b border-emerald-600/30 bg-emerald-500/10 px-3 py-2 text-xs">
                  <span className="relative flex size-2 shrink-0">
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  <p className="min-w-0 flex-1 truncate">
                    <span className="font-medium">Call in progress</span>
                    {liveCall.isMine
                      ? " · you started it"
                      : ` · started by ${shortName(
                          liveCall.startedByName,
                          memberNames,
                        )}`}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    className="h-7 shrink-0 gap-1"
                    onClick={() => setCallOpen(true)}
                  >
                    <Video className="size-3.5" />
                    Join
                  </Button>
                </div>
              )}

              <div
                ref={listRef}
                className="flex flex-1 flex-col gap-4 overflow-y-auto p-4"
              >
                {thread === undefined ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    Loading messages…
                  </p>
                ) : thread.chat === null ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    This chat isn't available to you.
                  </p>
                ) : messages.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    No messages yet — say hello.
                  </p>
                ) : (
                  messages.map((message) => (
                    <MessageRow
                      key={message.id}
                      message={message}
                      members={memberNames}
                      canPin={isStaff}
                      canDelete={canDelete(message)}
                      onPin={(row) => void togglePin(row)}
                      onDelete={(row) => void deleteMessage(row)}
                    />
                  ))
                )}
              </div>

              <div
                data-tour="messages-composer"
                className={`flex flex-col gap-2 border-t border-border/70 p-3 ${
                  readOnly ? "hidden" : ""
                }`}
              >
                {attachment && (
                  <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-muted/50 px-3 py-2 text-xs">
                    {attachment.mimeType.startsWith("image/") ? (
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.name}
                        className="size-14 shrink-0 rounded-md border border-border/60 bg-muted object-cover sm:size-12"
                      />
                    ) : attachment.mimeType.startsWith("audio/") ? (
                      <Music2 className="size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <FileText className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {attachment.name}
                    </span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">
                      {formatBytes(attachment.size)}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Remove attachment"
                      onClick={clearAttachment}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )}

                <div className="flex items-end gap-2">
                  <input
                    ref={fileRef}
                    type="file"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void pickAttachment(file);
                    }}
                  />
                  {gifsEnabled && (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-10 w-10 shrink-0 text-[10px] font-bold tracking-wide"
                      aria-label="Send a GIF"
                      title="Send a GIF"
                      disabled={sending}
                      onClick={() => setGifOpen(true)}
                    >
                      GIF
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="h-10 w-10 shrink-0"
                    aria-label="Attach a file"
                    title="Attach a file"
                    disabled={attachBusy}
                    onClick={() => fileRef.current?.click()}
                  >
                    {attachBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Paperclip className="size-4" />
                    )}
                  </Button>
                  <Textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void send();
                      }
                    }}
                    placeholder="Write a message…"
                    rows={1}
                    className="max-h-32 min-h-10 flex-1 resize-none"
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-10 shrink-0 gap-1 px-2.5 sm:px-3"
                    aria-label="Send message"
                    onClick={() => void send()}
                    disabled={(!draft.trim() && !attachment) || sending}
                  >
                    {sending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send />
                    )}
                    <span className="hidden sm:inline">Send</span>
                  </Button>
                </div>
              </div>
            </>
          )}
        </Card>
      </div>

      {gifsEnabled && (
        <GifPickerDialog
          open={gifOpen}
          onOpenChange={setGifOpen}
          onPick={(gif) => void sendGif(gif)}
        />
      )}

      <CallDialog
        open={callOpen || pendingCallReady}
        onOpenChange={(next) => {
          setCallOpen(next);
          // The ad-hoc call from "New call" is finished with once it closes.
          if (!next) setPendingCallId(null);
        }}
        chatId={callChatId}
        chatTitle={callChat?.title ?? ""}
      />

      <NewCallDialog
        open={newCallOpen}
        onOpenChange={setNewCallOpen}
        onStarted={(chatId) => {
          openChat(chatId);
          setPendingCallId(chatId);
        }}
      />

      <NotificationsPrompt open={notifyOpen} onOpenChange={setNotifyOpen} />

      <NewChatDialog
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        onCreated={openChat}
      />

      <ChatDetailsDialog
        chatId={selectedChatId}
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        isStaff={isStaff}
      />
    </div>
  );
}
