/**
 * Google Drive client helpers.
 *
 * The OAuth dance happens server-side (convex/drive.ts); this module only
 * starts it, reads the connection status, and resolves playable URLs. Google's
 * media URLs embed a short-lived access token, so they are fetched on demand
 * and cached briefly rather than stored in the vault.
 */
import { api } from "@/convex/_generated/api";
import type { FunctionReturnType } from "convex/server";

export type DriveStatus = FunctionReturnType<typeof api.drive.status>;

/**
 * Where uploads are relayed through.
 *
 * The preview iframe's Content-Security-Policy only permits the Convex hosts,
 * so a direct browser PUT to Google Drive is blocked (it surfaces as "Failed
 * to fetch"). The Convex site relays the body to Drive instead.
 */
const CONVEX_SITE_URL = (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)
  ?.trim()
  .replace(/\/$/, "");

function proxiedUploadUrl(uploadUrl: string): string {
  const base = CONVEX_SITE_URL ?? "https://neat-sockeye-350.convex.site";
  return `${base}/drive/upload-proxy?uploadUrl=${encodeURIComponent(uploadUrl)}`;
}

export interface DriveUploadResult {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  /** Ready-to-play URL, when the server could mint one immediately. */
  url: string;
  /** Which Drive received the bytes (the class archive when connected). */
  target: "vault" | "uploader";
}

/**
 * One level of the user's Drive, for the folder picker (see drive.browse).
 */
export type DriveBrowse = FunctionReturnType<typeof api.drive.browse>;
export type DriveBrowseFolder = DriveBrowse["folders"][number];
export type DriveBrowseFile = DriveBrowse["files"][number];

/**
 * A whole Drive folder walked recursively (see drive.listSubtree). Folders and
 * files each carry the Drive folder id they live in (`null` = the folder the
 * walk started from), so the vault can recreate the same structure.
 */
export type DriveSubtree = FunctionReturnType<typeof api.drive.listSubtree>;
export type DriveSubtreeFolder = DriveSubtree["folders"][number];
export type DriveSubtreeFile = DriveSubtree["files"][number];

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|ogv)$/i;

/**
 * Whether a Drive file is audio or video, from its mime type (Drive can return
 * a generic `application/octet-stream`, so the file name is the fallback).
 */
export function driveKind(
  mimeType: string,
  name: string,
): "audio" | "video" {
  if (mimeType.startsWith("video")) return "video";
  if (mimeType.startsWith("audio")) return "audio";
  return VIDEO_EXT.test(name) ? "video" : "audio";
}

/**
 * Uploads a File to the user's Google Drive.
 *
 * The browser asks a Convex action to open a Drive resumable-upload session,
 * then PUTs the file straight to Google. The bytes never pass through a Convex
 * function, which is what previously ran out of memory (and why function
 * arguments were never an option either).
 */
export async function uploadFileToDrive(
  file: File,
  name: string,
  callbacks: {
    startUpload: (args: {
      name: string;
      mimeType: string;
      size: number;
      /** The class whose studio folder the file belongs in. */
      code?: string;
    }) => Promise<{ uploadUrl: string; target: "vault" | "uploader" }>;
    finishUpload: (args: {
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
    }) => Promise<Omit<DriveUploadResult, "target">>;
    cancelUpload?: (args: { uploadUrl: string }) => Promise<{ ok: boolean }>;
  },
  /** The class this upload belongs to, when it is a class upload. */
  classCode?: string | null,
): Promise<DriveUploadResult> {
  const mimeType = file.type || "application/octet-stream";
  const { uploadUrl, target } = await callbacks.startUpload({
    name,
    mimeType,
    size: file.size,
    ...(classCode ? { code: classCode } : {}),
  });

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: file,
    });
  } catch {
    // Direct call blocked (e.g. the preview iframe's CSP) — relay through the
    // Convex site, which is allowed to reach Google.
    try {
      response = await fetch(proxiedUploadUrl(uploadUrl), {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: file,
      });
    } catch (error) {
      // The session may have created a file; drop it so nothing is left behind.
      void callbacks.cancelUpload?.({ uploadUrl });
      throw error;
    }
  }

  if (!response.ok) {
    void callbacks.cancelUpload?.({ uploadUrl });
    throw new Error(`Google Drive upload failed with status ${response.status}`);
  }

  const json = (await response.json()) as {
    id?: string;
    name?: string;
    size?: string;
  };
  if (!json.id) throw new Error("Google Drive did not return a file id.");
  const size = json.size ? Number(json.size) : file.size;
  const finished = await callbacks.finishUpload({
    fileId: json.id,
    name: json.name ?? name,
    mimeType,
    size,
  });
  return { ...finished, target };
}

/** How long a resolved Drive URL is reused before asking for a fresh one. */
const URL_TTL_MS = 10 * 60 * 1000;

interface CachedUrl {
  url: string;
  at: number;
}

const urlCache = new Map<string, CachedUrl>();

export function cachedDriveUrl(fileId: string): string | null {
  const hit = urlCache.get(fileId);
  if (!hit) return null;
  if (Date.now() - hit.at > URL_TTL_MS) {
    urlCache.delete(fileId);
    return null;
  }
  return hit.url;
}

export function cacheDriveUrl(fileId: string, url: string) {
  urlCache.set(fileId, { url, at: Date.now() });
}

export function clearDriveUrlCache() {
  urlCache.clear();
}

/**
 * Open Google's consent screen in a top-level tab.
 *
 * Google refuses to render the consent page inside an embedded frame (the
 * Freebuff preview runs the app in one), which shows up as "We're sorry, but
 * you do not have access to this page". A real browser tab avoids that, and
 * the callback lands back in the app where the reactive status query picks the
 * connection up.
 */
export function connectDrive(authUrl: { url: string }) {
  const opened = window.open(authUrl.url, "_blank", "noopener,noreferrer");
  if (!opened) {
    // Popup blocked — fall back to navigating this frame.
    window.location.assign(authUrl.url);
  }
}

/** Read the `?drive=…` result the OAuth callback adds to the URL. */
export function readDriveResult(
  search: URLSearchParams,
): "connected" | "denied" | "error" | null {
  const value = search.get("drive");
  if (value === "connected" || value === "denied" || value === "error") {
    return value;
  }
  return null;
}

/** Remove the `?drive=…` flag once it has been reported to the user. */
export function stripDriveResult(url: URL): string {
  const next = new URL(url.toString());
  next.searchParams.delete("drive");
  return `${next.pathname}${next.search}${next.hash}`;
}
