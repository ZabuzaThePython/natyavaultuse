/**
 * Resolves Google Drive file ids to playable URLs.
 *
 * Google's media URLs carry a short-lived access token, so they can't be
 * stored in the vault — they are fetched from the Convex action on demand and
 * cached for a few minutes (see src/lib/drive.ts).
 */
import { api } from "@/convex/_generated/api";
import { cachedDriveUrl, cacheDriveUrl } from "@/lib/drive";
import { useAction } from "convex/react";
import { useEffect, useState } from "react";

export interface ResolvedMediaSrc {
  /** A playable URL, or "" while it is still being resolved / unavailable. */
  url: string;
  /** True while a Drive link for this file is still being fetched. */
  loading: boolean;
}

/**
 * Resolve a media source to a playable URL.
 *
 * Non-Drive sources (`data:`/`blob:`/`synth:`) are returned as-is. A Drive id
 * has to be exchanged for a short-lived Google URL first, so `loading` is true
 * until that settles — callers must show a loader rather than treat the empty
 * `url` as a broken track. Feeding an empty `src` to a media element fires its
 * error event, which is what made Drive-backed tracks read as "unavailable"
 * before the URL ever arrived.
 */
export function useResolvedMediaSrc(
  driveFileId: string | undefined,
  fallbackSrc: string,
): ResolvedMediaSrc {
  const fileUrl = useAction(api.drive.fileUrl);
  const [resolved, setResolved] = useState<{
    id: string;
    url: string | null;
  } | null>(null);

  useEffect(() => {
    if (!driveFileId) return;
    // A fresh URL may already be cached (e.g. right after an upload).
    if (cachedDriveUrl(driveFileId)) return;
    let cancelled = false;
    void fileUrl({ fileId: driveFileId })
      .then((result) => {
        if (cancelled) return;
        if (result) cacheDriveUrl(driveFileId, result.url);
        setResolved({ id: driveFileId, url: result?.url ?? null });
      })
      .catch(() => {
        // Leave it unresolved; the player shows its own error state.
        if (!cancelled) setResolved({ id: driveFileId, url: null });
      });
    return () => {
      cancelled = true;
    };
  }, [driveFileId, fileUrl]);

  if (!driveFileId) return { url: fallbackSrc, loading: false };
  const cached = cachedDriveUrl(driveFileId);
  if (cached) return { url: cached, loading: false };
  if (resolved?.id === driveFileId) {
    return { url: resolved.url ?? "", loading: false };
  }
  return { url: "", loading: true };
}
