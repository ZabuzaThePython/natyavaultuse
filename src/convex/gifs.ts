/**
 * GIF search for the chat composer, proxied through the deployment so the
 * GIPHY key never reaches the browser.
 *
 * Set the key on the Convex deployment:
 *   npx convex env set GIPHY_API_KEY <your key>
 * Until then the picker shows a setup notice instead of failing.
 *
 * GIPHY's developer terms ask integrations to load media from the URLs the API
 * returns — so a sent GIF stores those URLs, not a copy of the animation.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { api } from "./_generated/api";
import { action } from "./_generated/server";
import { v } from "convex/values";

const GIPHY_API = "https://api.giphy.com/v1/gifs";
const RESULT_LIMIT = 24;

/** The parts of a GIPHY GIF object this app reads. */
interface GiphyRendition {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyGif {
  id?: string;
  title?: string;
  images?: Record<string, GiphyRendition | undefined>;
}

/** A GIF in the shape the composer and the message bubble use. */
export interface GifResult {
  id: string;
  /** The animation shown in the thread. */
  url: string;
  /** The smaller version shown in the picker's grid. */
  previewUrl: string;
  width: number;
  height: number;
  alt: string;
}

const dim = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
};

/** Only HTTPS URLs on GIPHY's own hosts are accepted as GIFs. */
export function isGiphyUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "giphy.com" || url.hostname.endsWith(".giphy.com"))
    );
  } catch {
    return false;
  }
}

export const search = action({
  args: { query: v.string() },
  handler: async (
    ctx,
    { query },
  ): Promise<{
    ok: boolean;
    configured: boolean;
    gifs: GifResult[];
    error: string | null;
  }> => {
    // The admin switch ships off. While it is off there is no picker in the
    // composer, and this action refuses too.
    const enabled = await ctx.runQuery(api.admin.gifsEnabled, {});
    if (!enabled) {
      return {
        ok: false,
        configured: true,
        gifs: [],
        error: "GIF search is turned off.",
      };
    }

    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return {
        ok: false,
        configured: true,
        gifs: [],
        error: "Sign in to search GIFs.",
      };
    }

    // Trimmed because a key pasted into the dashboard can carry a trailing
    // space or newline, which GIPHY rejects as unauthorized.
    const key = process.env.GIPHY_API_KEY?.trim();
    if (!key) {
      return {
        ok: false,
        configured: false,
        gifs: [],
        error: "GIF search isn't set up yet.",
      };
    }

    // An empty query shows trending GIFs, like the picker in Google Chat.
    const term = query.trim().replace(/\s+/g, " ").slice(0, 50);
    const url = new URL(`${GIPHY_API}/${term ? "search" : "trending"}`);
    url.searchParams.set("api_key", key);
    if (term) url.searchParams.set("q", term);
    url.searchParams.set("limit", String(RESULT_LIMIT));
    // Class-friendly, and never returns explicit content.
    url.searchParams.set("rating", "pg-13");
    url.searchParams.set("lang", "en");

    let response: Response;
    try {
      response = await fetch(url, {
        // Let the deployment's CDN reuse a query for a few minutes, so a class
        // typing the same search does not burn the key's hourly quota.
        headers: { Accept: "application/json" },
      });
    } catch (error) {
      console.error("GIF search request failed:", error);
      return {
        ok: false,
        configured: true,
        gifs: [],
        error: "Couldn't reach GIPHY. Check the connection and try again.",
      };
    }

    if (!response.ok) {
      if (response.status === 429) {
        return {
          ok: false,
          configured: true,
          gifs: [],
          error: "GIF search is busy right now — try again in a minute.",
        };
      }
      console.error("GIF search failed:", response.status, await response.text());
      return {
        ok: false,
        configured: true,
        gifs: [],
        error: "GIF search is unavailable right now.",
      };
    }

    const body = (await response.json()) as { data?: GiphyGif[] };
    const gifs: GifResult[] = [];
    for (const item of body.data ?? []) {
      const images = item.images ?? {};
      const full =
        images.fixed_height ??
        images.downsized_medium ??
        images.original;
      // The picker's tiles are up to ~350px wide, so the preview has to be the
      // full-quality 200px-tall rendition: the downsampled one (same height,
      // compressed) looked soft once the tiles stopped being thumbnails, and
      // `fixed_height_small` (100px) was worse. It is the same file as `full`
      // for most GIFs, so the tile a reader taps is already in the cache.
      const preview =
        images.fixed_height ?? images.fixed_width ?? full;
      if (!full?.url || !preview?.url) continue;
      if (!isGiphyUrl(full.url) || !isGiphyUrl(preview.url)) continue;
      gifs.push({
        id: item.id ?? full.url,
        url: full.url,
        previewUrl: preview.url,
        width: dim(full.width, 200),
        height: dim(full.height, 200),
        alt: (item.title ?? "").trim().slice(0, 120) || "GIF",
      });
    }

    return { ok: true, configured: true, gifs, error: null };
  },
});
