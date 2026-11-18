import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useResolvedMediaSrc } from "@/lib/drive-url";
import { cn } from "@/lib/utils";
import {
  formatClock,
  formatDate,
  resolveSrc,
  timeAgo,
  type MediaItem,
} from "@/lib/vault";
import {
  AlertTriangle,
  Folder,
  Loader2,
  Music2,
  Pause,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/** Only one generated/uploaded track plays at a time. */
let activeAudio: HTMLAudioElement | null = null;

// ---------------------------------------------------------------- audio

export function AudioPlayer({
  src,
  driveFileId,
  className,
}: {
  src: string;
  driveFileId?: string;
  className?: string;
}) {
  const { url: driveUrl, loading: driveLoading } = useResolvedMediaSrc(
    driveFileId,
    "",
  );
  const url = useMemo(
    () => (driveFileId ? driveUrl : resolveSrc(src)),
    [driveFileId, driveUrl, src],
  );
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  // The URL that last failed to load. Keying the error by URL means a refreshed
  // Drive link (a new URL) clears a previous failure instead of the track
  // staying stuck on "unavailable".
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === url;

  const pct = duration > 0 ? (current / duration) * 100 : 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      activeAudio?.pause();
      activeAudio = el;
      void el.play().catch(() => setFailedSrc(url));
    } else {
      el.pause();
    }
  };

  // A Drive track has no URL for a moment while its link is fetched. Never
  // render an audio element with an empty src — that fires an error event and
  // would report the track as unavailable before the URL ever arrives.
  if (driveLoading && !url) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="size-3.5 animate-spin" />
        Loading track…
      </div>
    );
  }

  if (failed || !url) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground",
          className,
        )}
      >
        <AlertTriangle className="size-3.5" />
        Track unavailable
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full min-w-0 items-center gap-2 sm:w-56",
        className,
      )}
    >
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrent(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onError={() => setFailedSrc(url)}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause track" : "Play track"}
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 translate-x-px" />}
      </button>
      <input
        type="range"
        min={0}
        max={duration || 0}
        step={0.1}
        value={current}
        disabled={!duration}
        onChange={(e) => {
          const el = audioRef.current;
          if (!el) return;
          const next = Number(e.target.value);
          el.currentTime = next;
          setCurrent(next);
        }}
        aria-label="Seek track"
        className="nv-range min-w-0 flex-1"
        style={{
          background: `linear-gradient(to right, var(--primary) ${pct}%, var(--muted) ${pct}%)`,
        }}
      />
      <span className="w-[68px] shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {formatClock(current)} / {formatClock(duration)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- video

export function VideoDialog({
  item,
  open,
  onOpenChange,
  onEdit,
  onDelete,
  startAt = 0,
}: {
  item: MediaItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Rename/move the clip while it is open. */
  onEdit?: (item: MediaItem) => void;
  /** Remove the clip while it is open. */
  onDelete?: (item: MediaItem) => void;
  startAt?: number;
}) {
  if (!item) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="pr-8">{item.title}</DialogTitle>
          <DialogDescription>
            {[item.piece, formatDate(item.date)].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <VideoFrame
          key={item.id}
          src={resolveSrc(item.src)}
          driveFileId={item.driveFileId}
          open={open}
          startAt={startAt}
        />
        {(onEdit || onDelete) && (
          <div className="flex flex-wrap justify-end gap-2">
            {onEdit && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer"
                onClick={() => onEdit(item)}
              >
                <Pencil className="size-4" />
                Edit
              </Button>
            )}
            {onDelete && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="cursor-pointer text-destructive hover:text-destructive"
                onClick={() => onDelete(item)}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Inner player keyed by clip so its error/seek state resets per video. */
function VideoFrame({
  src: fallbackSrc,
  driveFileId,
  open,
  startAt,
}: {
  src: string;
  driveFileId?: string;
  open: boolean;
  startAt: number;
}) {
  const { url: driveUrl, loading: driveLoading } = useResolvedMediaSrc(
    driveFileId,
    "",
  );
  const src = driveFileId ? driveUrl : fallbackSrc;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (!open) {
      el.pause();
      return;
    }
    const apply = () => {
      if (startAt > 0) el.currentTime = startAt;
    };
    if (el.readyState >= 1) apply();
    else el.addEventListener("loadedmetadata", apply, { once: true });
    return () => el.removeEventListener("loadedmetadata", apply);
  }, [open, startAt]);

  if (!src && driveLoading) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-lg bg-muted text-sm text-muted-foreground">
        Loading from Google Drive…
      </div>
    );
  }

  if (failed || !src) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-lg bg-muted text-center">
        <AlertTriangle className="size-5 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          This preview clip could not load. Uploads from your device play here.
        </p>
      </div>
    );
  }

  return (
    <video
      ref={videoRef}
      src={src}
      controls
      playsInline
      preload="metadata"
      onError={() => setFailedSrc(src)}
      className="aspect-video w-full rounded-lg bg-black"
    />
  );
}

// ------------------------------------------------------------- thumbnails

const GRADIENTS = [
  "from-primary via-terracotta to-gold",
  "from-[oklch(0.38_0.09_25)] via-primary to-terracotta",
  "from-gold via-[oklch(0.62_0.12_45)] to-primary",
];

function gradientFor(seed: string): string {
  const sum = seed.split("").reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return GRADIENTS[sum % GRADIENTS.length];
}

export function VideoThumb({
  item,
  className,
  iconClassName,
}: {
  item: MediaItem;
  className?: string;
  iconClassName?: string;
}) {
  return (
    <div
      className={cn(
        "relative flex aspect-video w-full items-center justify-center overflow-hidden bg-gradient-to-br",
        gradientFor(item.title),
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgb(255_255_255/0.25),transparent_55%)]" />
      <span
        className={cn(
          "relative flex size-12 items-center justify-center rounded-full bg-black/25 text-white ring-1 ring-white/40 backdrop-blur-sm",
          iconClassName,
        )}
      >
        <Play className="size-5 translate-x-px" />
      </span>
      <span className="absolute bottom-2 left-2 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-white uppercase backdrop-blur-sm">
        Video
      </span>
    </div>
  );
}

// ------------------------------------------------------------------ rows

export function KindMeta({ item }: { item: MediaItem }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {item.piece && (
        <Badge variant="secondary" className="font-medium">
          {item.piece}
        </Badge>
      )}
      {item.talam && (
        <Badge variant="outline" className="text-muted-foreground">
          {item.talam} talam
        </Badge>
      )}
      {item.ragam && (
        <Badge variant="outline" className="text-muted-foreground">
          {item.ragam}
        </Badge>
      )}
    </div>
  );
}

/** Chronological list row used on the dashboard and in the vault. */
export function MediaRow({
  item,
  onPlay,
  onDelete,
  onEdit,
  folderLabel,
  dragHandle,
}: {
  item: MediaItem;
  onPlay: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
  onEdit?: (item: MediaItem) => void;
  /** Shown in the general area so it's clear which folder a file lives in. */
  folderLabel?: string;
  /** Optional grip shown at the start of the row, for dragging it in order. */
  dragHandle?: ReactNode;
}) {
  const isVideo = item.kind === "video";
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-3 shadow-[0_1px_2px_rgba(15,12,10,0.04)] transition-colors hover:border-border sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {dragHandle && <div className="flex shrink-0">{dragHandle}</div>}
        <div
          className={cn(
            "flex size-12 shrink-0 items-center justify-center rounded-lg",
            isVideo
              ? `bg-gradient-to-br ${gradientFor(item.title)} text-white`
              : "bg-gold/25 text-gold-foreground",
          )}
        >
          {isVideo ? (
            <Play className="size-5 translate-x-px" />
          ) : (
            <Music2 className="size-5" />
          )}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {formatDate(item.date)} · {timeAgo(item.createdAt)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <KindMeta item={item} />
            {folderLabel && (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Folder className="size-3" />
                {folderLabel}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {isVideo ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="cursor-pointer"
            onClick={() => onPlay(item)}
          >
            <Play className="size-4" />
            Play
          </Button>
        ) : (
          <AudioPlayer src={item.src} driveFileId={item.driveFileId} />
        )}
        {onEdit && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground"
            aria-label={`Edit ${item.title}`}
            onClick={() => onEdit(item)}
          >
            <Pencil className="size-4" />
          </Button>
        )}
        {onDelete && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            aria-label={`Delete ${item.title}`}
            onClick={() => onDelete(item)}
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** Grid card for the video gallery. */
export function VideoCard({
  item,
  onOpen,
  onDelete,
  onEdit,
  folderLabel,
  selected = false,
  dragHandle,
}: {
  item: MediaItem;
  onOpen: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
  onEdit?: (item: MediaItem) => void;
  /** Shown in the general area so it's clear which folder a file lives in. */
  folderLabel?: string;
  selected?: boolean;
  /** Optional grip over the thumbnail, for dragging the card in order. */
  dragHandle?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgba(15,12,10,0.04)] transition-colors",
        selected ? "border-primary ring-2 ring-primary/25" : "border-border/70 hover:border-border",
      )}
    >
      {dragHandle && <div className="absolute top-2 left-2 z-10">{dragHandle}</div>}
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="block w-full text-left focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
        aria-label={`Play ${item.title}`}
      >
        <VideoThumb item={item} />
        <div className="p-3.5">
          <p className="truncate text-sm font-medium">{item.title}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {formatDate(item.date)}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <KindMeta item={item} />
            {folderLabel && (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Folder className="size-3" />
                {folderLabel}
              </Badge>
            )}
          </div>
        </div>
      </button>
      {(onEdit || onDelete) && (
        <div className="absolute top-2 right-2 flex gap-1">
          {onEdit && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white"
              aria-label={`Edit ${item.title}`}
              onClick={() => onEdit(item)}
            >
              <Pencil className="size-4" />
            </Button>
          )}
          {onDelete && (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              className="bg-black/35 text-white backdrop-blur-sm hover:bg-black/55 hover:text-white"
              aria-label={`Delete ${item.title}`}
              onClick={() => onDelete(item)}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
