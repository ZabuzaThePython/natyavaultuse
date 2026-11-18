import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * Upload relay.
 *
 * The preview runs the app inside an iframe whose Content-Security-Policy only
 * allows the Convex hosts, so the browser cannot PUT straight to Google Drive.
 * This route streams the request body on to the Drive upload session instead,
 * so the bytes are never buffered here (which is what ran the isolate out of
 * memory when the upload went through a Convex function).
 */
const GOOGLE_UPLOAD_PREFIX = "https://www.googleapis.com/upload/";

const uploadCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "3600",
};

http.route({
  path: "/drive/upload-proxy",
  method: "OPTIONS",
  handler: httpAction(async () =>
    new Response(null, { status: 204, headers: uploadCors }),
  ),
});

http.route({
  path: "/drive/upload-proxy",
  method: "PUT",
  handler: httpAction(async (_ctx, request) => {
    const target = new URL(request.url).searchParams.get("uploadUrl");
    // Only ever relay to Google's own upload endpoint — never an arbitrary host.
    if (!target || !target.startsWith(GOOGLE_UPLOAD_PREFIX)) {
      return new Response("Invalid upload URL", {
        status: 400,
        headers: uploadCors,
      });
    }
    const contentType =
      request.headers.get("Content-Type") ?? "application/octet-stream";
    try {
      const upstream = await fetch(target, {
        method: "PUT",
        headers: { "Content-Type": contentType },
        body: request.body,
        // Required by runtimes that accept streamed request bodies.
        // @ts-expect-error duplex is not in the DOM RequestInit type
        duplex: "half",
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "Content-Type": "application/json", ...uploadCors },
      });
    } catch (error) {
      return new Response(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        }),
        { status: 502, headers: { "Content-Type": "application/json", ...uploadCors } },
      );
    }
  }),
});

/**
 * Drive media relay.
 *
 * Playback runs in an `<audio>`/`<video>` element, which can only authenticate
 * with a URL — and Google rejects the `access_token` query parameter on Drive
 * downloads (403) while accepting the same token as an `Authorization` header.
 * The browser streams the file from here instead and this route adds the
 * header, so playback works again (and, being a Convex host, it is not blocked
 * by the preview iframe's Content-Security-Policy either).
 *
 * Range requests are forwarded untouched so seeking and progressive playback
 * keep working, and 206/Content-Range are relayed back.
 */
const GOOGLE_MEDIA_PREFIX = "https://www.googleapis.com/drive/v3/files/";

async function relayDriveMedia(ctx: ActionCtx, request: Request) {
  const params = new URL(request.url).searchParams;
  let fileId = params.get("fileId");
  let accessToken = params.get("access_token");

  // Class uploads play through an opaque, expiring link: the stored Drive
  // token (class archive or uploader) is resolved here, so no Google access
  // token ever appears in a page.
  const grant = params.get("grant");
  if (grant) {
    const resolved = await ctx.runMutation(internal.drive.grantFor, {
      token: grant,
    });
    if (resolved === null) {
      return new Response("This media link has expired", { status: 410 });
    }
    fileId = resolved.fileId;
    try {
      const minted = await ctx.runAction(internal.drive.tokenForGrant, {
        ...(resolved.ownerUserId ? { ownerUserId: resolved.ownerUserId } : {}),
      });
      accessToken = minted.accessToken;
    } catch {
      return new Response("The Drive for this file is not connected", {
        status: 503,
      });
    }
  }

  if (!fileId || !accessToken) {
    return new Response("Missing fileId or access token", { status: 400 });
  }
  const headers = new Headers({ Authorization: `Bearer ${accessToken}` });
  const range = request.headers.get("Range");
  if (range) headers.set("Range", range);

  const upstream = await fetch(
    `${GOOGLE_MEDIA_PREFIX}${encodeURIComponent(fileId)}?alt=media`,
    { headers },
  );
  const passthrough = new Headers({ "Access-Control-Allow-Origin": "*" });
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) passthrough.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: passthrough,
  });
}

http.route({
  path: "/drive/media-proxy",
  method: "GET",
  handler: httpAction(async (ctx, request) => relayDriveMedia(ctx, request)),
});

/**
 * Google Drive OAuth redirect target. Google sends the user back here with
 * `code` + `state`; we exchange the code for tokens server-side, then bounce
 * the browser into the app.
 *
 * Register this exact URL on the OAuth client:
 *   <CONVEX_SITE_URL>/drive/callback
 */
http.route({
  path: "/drive/callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? undefined;
    const error = url.searchParams.get("error");

    // The exchange consumes (deletes) the one-time state row, so read it first
    // to learn where the browser should land. Otherwise any failure — a denied
    // consent, an expired code — would leave us with no app origin and drop the
    // user on the Convex site, which serves no app.
    let returnTo = "/dashboard/vault";
    let origin = appOrigin(request);
    if (state) {
      const pending = await ctx.runQuery(internal.drive.peekState, {
        nonce: state,
      });
      if (pending) {
        returnTo = pending.returnTo;
        if (pending.origin) origin = pending.origin;
      }
    }

    if (error || !code || !state) {
      const target = new URL(returnTo, `${origin}/`);
      target.searchParams.set("drive", error ? "denied" : "error");
      return Response.redirect(target.toString(), 302);
    }

    let result: "connected" | "error" = "error";
    try {
      const exchanged = await ctx.runAction(api.drive.exchange, { code, state });
      returnTo = exchanged.returnTo;
      if (exchanged.origin) origin = exchanged.origin;
      result = "connected";
    } catch (caught) {
      console.error("Drive OAuth exchange failed:", caught);
    }

    const target = new URL(returnTo, `${origin}/`);
    target.searchParams.set("drive", result);
    return Response.redirect(target.toString(), 302);
  }),
});

/** Where the app is served: APP_ORIGIN env → referer → the Convex site URL. */
function appOrigin(request: Request): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      // fall through
    }
  }
  return process.env.CONVEX_SITE_URL ?? "http://localhost:5173";
}

export default http;
