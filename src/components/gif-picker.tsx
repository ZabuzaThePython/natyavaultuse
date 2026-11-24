import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import { useAction } from "convex/react";
import { ArrowLeft, Loader2, Search, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** A GIF picked in the dialog, ready to be sent as a chat message. */
export interface PickedGif {
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  alt: string;
}

interface SearchResult {
  ok: boolean;
  configured: boolean;
  gifs: PickedGif[];
  error: string | null;
}

/**
 * The chat's GIF picker: trending GIFs on open, then a GIPHY search as you
 * type.
 *
 * Tapping a GIF does not send it straight away — it opens the GIF at full size
 * with a Send button, because a thumbnail is not enough to tell what you are
 * about to put in the chat (least of all on a phone). Back returns to the same
 * results without searching again.
 *
 * The search runs on the deployment (convex/gifs.ts), so the GIPHY key stays
 * server-side.
 */
export function GifPickerDialog({
  open,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (gif: PickedGif) => void;
}) {
  const searchGifs = useAction(api.gifs.search);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by "Try again", so a transient failure can be retried in place.
  const [attempt, setAttempt] = useState(0);
  // The GIF being checked at full size, if any.
  const [picked, setPicked] = useState<PickedGif | null>(null);
  // Set when the large preview image itself refuses to load, so the reader
  // gets an explanation and a way out instead of an empty frame.
  const [previewFailed, setPreviewFailed] = useState(false);
  // Only the newest request may write its results, so fast typing can't show
  // an older search's GIFs.
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const id = ++latest.current;
    const delay = query.trim() ? 450 : 0;
    const timer = setTimeout(() => {
      setLoading(true);
      void searchGifs({ query })
        .then((response) => {
          if (latest.current === id) setResult(response);
        })
        .catch((error) => {
          console.error("GIF search failed:", error);
          if (latest.current === id) {
            setResult({
              ok: false,
              configured: true,
              gifs: [],
              error: "Couldn't search GIFs. Try again.",
            });
          }
        })
        .finally(() => {
          if (latest.current === id) setLoading(false);
        });
    }, delay);
    return () => clearTimeout(timer);
  }, [open, query, searchGifs, attempt]);

  // Closing the dialog clears the preview, so it always opens on the results.
  // Done in the close path rather than in an effect on `open`, which would be
  // a render the dialog does not need.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setPicked(null);
      setPreviewFailed(false);
    }
    onOpenChange(next);
  };

  const gifs = result?.gifs ?? [];
  const needsKey = result !== null && !result.configured;
  const failed = result !== null && result.ok === false && result.configured;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* A wide dialog is what makes the grid readable: at the old 576px
          width every tile was about 150px across, which is not enough to
          recognise a GIF before sending it. */}
      <DialogContent className="max-h-[calc(100dvh-1.5rem)] overflow-y-auto p-4 sm:max-w-3xl sm:p-6">
        <DialogHeader>
          <DialogTitle>{picked ? "Send this GIF?" : "Send a GIF"}</DialogTitle>
          <DialogDescription>
            {picked
              ? "Here it is at full size — send it, or go back to the results."
              : "Search GIPHY, then tap a GIF to see it full size before sending."}
          </DialogDescription>
        </DialogHeader>

        {picked ? (
          <div className="flex flex-col gap-3">
            {previewFailed ? (
              <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 px-4 py-8 text-center">
                <p className="text-sm font-medium">This GIF didn't load</p>
                <p className="max-w-sm text-xs text-muted-foreground">
                  GIPHY's image host couldn't be reached from this device. The
                  rest of the picker still works — try another GIF.
                </p>
                <Button asChild type="button" variant="outline" size="sm">
                  <a
                    href={picked.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Open it on GIPHY
                  </a>
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-center overflow-hidden rounded-xl border border-border/70 bg-muted/40">
                <img
                  src={picked.url}
                  alt={picked.alt}
                  width={picked.width}
                  height={picked.height}
                  onError={() => setPreviewFailed(true)}
                  className="h-auto max-h-[55dvh] w-full object-contain"
                />
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPicked(null);
                  setPreviewFailed(false);
                }}
              >
                <ArrowLeft className="size-4" />
                Back to results
              </Button>
              <Button
                type="button"
                onClick={() => {
                  const gif = picked;
                  setPicked(null);
                  setPreviewFailed(false);
                  onPick(gif);
                }}
              >
                <Send className="size-4" />
                Send GIF
              </Button>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {picked.alt}
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search GIPHY"
                className="pl-9"
                aria-label="Search GIPHY"
                autoFocus
              />
            </div>

            {needsKey ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm">
                <div>
                  <p className="font-medium">GIF search isn't set up yet</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The deployment is reporting no GIPHY key. Add a free key as{" "}
                    <code>GIPHY_API_KEY</code> in the Keys tab, then try again.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : failed ? (
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                <p>{result?.error ?? "Couldn't search GIFs."}</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Try again
                </Button>
              </div>
            ) : loading && gifs.length === 0 ? (
              <p className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {query.trim() ? "Searching GIFs…" : "Loading trending GIFs…"}
              </p>
            ) : gifs.length === 0 ? (
              <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                No GIFs for “{query.trim()}” — try another word.
              </p>
            ) : (
              // One GIF per row on a phone, two across in the wide dialog —
              // four or more tiles per row is what made every preview
              // unreadable. The grid has no scroll area of its own: the dialog
              // scrolls as one page, so a row is never clipped mid-GIF (a
              // nested scroller on a phone left half a GIF showing and was
              // hard to drag).
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {gifs.map((gif) => (
                  <button
                    key={gif.previewUrl}
                    type="button"
                    onClick={() => {
                      setPreviewFailed(false);
                      setPicked(gif);
                    }}
                    title={gif.alt}
                    className="flex items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/60 transition-colors hover:border-primary/60 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
                  >
                    {/* object-contain, never object-cover: GIFs are all
                        different shapes, and cropping them hid most of the
                        animation. */}
                    <img
                      src={gif.previewUrl}
                      alt={gif.alt}
                      loading="lazy"
                      width={gif.width}
                      height={gif.height}
                      className="h-auto max-h-[45dvh] w-full object-contain sm:max-h-72"
                    />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        <p className="text-center text-[11px] text-muted-foreground">
          Powered by GIPHY
        </p>
      </DialogContent>
    </Dialog>
  );
}
