import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { maySeeEveryClass } from "./classes";

/**
 * Google Drive integration.
 *
 * Everything the app uploads is written into a "NatyaVault" folder inside the
 * signed-in user's own Drive, so the media belongs to them and survives a
 * browser wipe. The OAuth refresh token is stored server-side (driveTokens)
 * and is never sent to the client.
 *
 * Requires two deployment environment variables, set in the Convex dashboard
 * (Settings → Environment Variables):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 * plus the redirect URI registered on the OAuth client:
 *   <CONVEX_SITE_URL>/drive/callback
 */

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";

/** "Everything" scope: full read/write access to the user's Drive. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FOLDER_NAME = "NatyaVault";
/** Singleton key for the class archive's own Drive connection. */
const VAULT_KEY = "vault";

/**
 * Read a deployment env value, tolerating the wrapping quotes and whitespace a
 * dashboard paste often leaves behind. A client id stored as
 * `'1234.apps.googleusercontent.com` is sent to Google verbatim and rejected as
 * an unknown client — "The OAuth client was not found" (Error 401:
 * invalid_client) — so surrounding quotes are stripped as well as whitespace.
 */
function cleanEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]+|['"]+$/g, "").trim();
}

function clientId(): string | undefined {
  return cleanEnv(process.env.GOOGLE_CLIENT_ID);
}

function clientSecret(): string | undefined {
  return cleanEnv(process.env.GOOGLE_CLIENT_SECRET);
}

function redirectUri(): string {
  return `${cleanEnv(process.env.CONVEX_SITE_URL)}/drive/callback`;
}

function isConfigured(): boolean {
  return Boolean(clientId() && clientSecret());
}

/** Fetch with a hard timeout so a stalled Google call can't hang the action. */
async function timedFetch(
  url: string,
  init: RequestInit = {},
  ms = 20000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ storage

export const getTokens = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    await ctx.db
      .query("driveTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique(),
});

export const saveTokens = internalMutation({
  args: {
    userId: v.id("users"),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    scope: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("driveTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    const { userId, ...rest } = args;
    if (existing === null) {
      await ctx.db.insert("driveTokens", { userId, ...rest, updatedAt: Date.now() });
    } else {
      await ctx.db.patch(existing._id, { ...rest, updatedAt: Date.now() });
    }
  },
});

export const createState = internalMutation({
  args: {
    nonce: v.string(),
    userId: v.id("users"),
    returnTo: v.string(),
    origin: v.optional(v.string()),
    /** "vault" when this consent is for the class archive. */
    mode: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("driveStates", { ...args, createdAt: Date.now() });
  },
});

/** Look up (and consume) a one-time OAuth state row. */
export const consumeState = internalMutation({
  args: { nonce: v.string() },
  handler: async (
    ctx,
    { nonce },
  ): Promise<{
    userId: Id<"users">;
    returnTo: string;
    origin: string | null;
    mode: string | null;
  } | null> => {
    const row = await ctx.db
      .query("driveStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", nonce))
      .unique();
    if (row === null) return null;
    await ctx.db.delete(row._id);
    // Ignore anything older than 10 minutes.
    if (Date.now() - row.createdAt > 10 * 60 * 1000) return null;
    return {
      userId: row.userId,
      returnTo: row.returnTo,
      origin: row.origin ?? null,
      mode: row.mode ?? null,
    };
  },
});

/**
 * Read a pending OAuth state without consuming it.
 *
 * The callback runs before the exchange, so it can learn where to send the
 * browser even if the token exchange fails. Without this, a failed exchange
 * loses the only record of the app's origin (the state row is deleted by
 * `consumeState`) and the user is stranded on the Convex site rather than the
 * app. Ignores anything older than 10 minutes.
 */
export const peekState = internalQuery({
  args: { nonce: v.string() },
  handler: async (
    ctx,
    { nonce },
  ): Promise<{
    userId: Id<"users">;
    returnTo: string;
    origin: string | null;
    mode: string | null;
  } | null> => {
    const row = await ctx.db
      .query("driveStates")
      .withIndex("by_nonce", (q) => q.eq("nonce", nonce))
      .unique();
    if (row === null) return null;
    if (Date.now() - row.createdAt > 10 * 60 * 1000) return null;
    return {
      userId: row.userId,
      returnTo: row.returnTo,
      origin: row.origin ?? null,
      mode: row.mode ?? null,
    };
  },
});

/** The class vault's stored Drive grant, if the admin has connected one. */
export const getVaultTokens = internalQuery({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("vaultDriveTokens")
      .withIndex("by_key", (q) => q.eq("key", VAULT_KEY))
      .unique(),
});

export const saveVaultTokens = internalMutation({
  args: {
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    scope: v.string(),
    email: v.optional(v.string()),
    connectedBy: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("vaultDriveTokens")
      .withIndex("by_key", (q) => q.eq("key", VAULT_KEY))
      .unique();
    if (existing === null) {
      await ctx.db.insert("vaultDriveTokens", {
        key: VAULT_KEY,
        ...args,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.patch(existing._id, { ...args, updatedAt: Date.now() });
    }
  },
});

export const clearVaultTokens = internalMutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db
      .query("vaultDriveTokens")
      .withIndex("by_key", (q) => q.eq("key", VAULT_KEY))
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
  },
});

/**
 * Whether this account may connect/disconnect the class vault: the admin or a
 * teacher, i.e. the same people who manage classes.
 */
export const viewerManagesClasses = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => await maySeeEveryClass(ctx, userId),
});

export const forgetTokens = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const tokens = await ctx.db
      .query("driveTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (tokens !== null) await ctx.db.delete(tokens._id);
    const files = await ctx.db
      .query("driveFiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const file of files) await ctx.db.delete(file._id);
  },
});

/** Forget a stored token without touching the files tracked against it. */
export const clearTokens = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const tokens = await ctx.db
      .query("driveTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (tokens !== null) await ctx.db.delete(tokens._id);
  },
});

export const listFiles = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    await ctx.db
      .query("driveFiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
});

export const recordFile = internalMutation({
  args: {
    userId: v.id("users"),
    fileId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("driveFiles", { ...args, createdAt: Date.now() });
  },
});

export const forgetFile = internalMutation({
  args: { userId: v.id("users"), fileId: v.string() },
  handler: async (ctx, { userId, fileId }) => {
    const rows = await ctx.db
      .query("driveFiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) {
      if (row.fileId === fileId) await ctx.db.delete(row._id);
    }
  },
});

// -------------------------------------------------------------------- oauth

/**
 * Whether Drive is usable on this deployment, and whether this browser's user
 * has connected their account yet.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);

    // The class archive is one connected account that holds every class
    // upload, so its state matters to everyone who reads this page.
    const vault = await ctx.db
      .query("vaultDriveTokens")
      .withIndex("by_key", (q) => q.eq("key", VAULT_KEY))
      .unique();
    const base = {
      configured: isConfigured(),
      connected: false,
      email: null as string | null,
      vaultConnected: vault !== null,
      vaultEmail: vault?.email ?? null,
      canManageVault: userId === null ? false : await maySeeEveryClass(ctx, userId),
    };
    if (userId === null) return base;

    const tokens = await ctx.db
      .query("driveTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      ...base,
      connected: tokens !== null,
      email: tokens?.email ?? null,
    };
  },
});

/**
 * Build the Google consent URL. `state` carries the page to return to and the
 * app origin (Google sends no referer on the redirect back, so the callback
 * needs to be told where the app lives).
 */
export const authUrl = action({
  args: {
    returnTo: v.optional(v.string()),
    origin: v.optional(v.string()),
    /** "vault" connects the class archive; anything else is a personal Drive. */
    mode: v.optional(v.string()),
  },
  handler: async (ctx, { returnTo, origin, mode }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new Error("Sign in before connecting Google Drive.");
    }
    if (!isConfigured()) {
      throw new Error(
        "Google Drive is not configured yet — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the Convex deployment.",
      );
    }
    const vaultMode = mode === "vault";
    if (vaultMode) {
      // One account holds the whole class archive, so only the admin may point
      // it somewhere — otherwise any account could redirect the class's files
      // into a Drive of their choosing.
      const allowed = await ctx.runQuery(internal.drive.viewerManagesClasses, {
        userId,
      });
      if (!allowed) {
        throw new Error(
          "Only a teacher or the admin can connect the class Drive.",
        );
      }
    }
    const safeReturn =
      returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
        ? returnTo
        : "/dashboard/vault";
    const safeOrigin =
      origin && /^https?:\/\//.test(origin) ? origin.replace(/\/$/, "") : undefined;

    // The callback is an HTTP action without a session, so remember which user
    // started this flow (keyed by an unguessable nonce) instead of trusting
    // anything the browser sends back.
    const nonce = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
    await ctx.runMutation(internal.drive.createState, {
      nonce,
      userId,
      returnTo: safeReturn,
      mode: vaultMode ? "vault" : "personal",
      ...(safeOrigin ? { origin: safeOrigin } : {}),
    });

    const params = new URLSearchParams({
      client_id: clientId()!,
      redirect_uri: redirectUri(),
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      include_granted_scopes: "true",
      prompt: "consent",
      state: nonce,
    });
    return { url: `${AUTH_ENDPOINT}?${params.toString()}` };
  },
});

/** Exchange the authorization code for tokens and store them for the user. */
export const exchange = action({
  args: { code: v.string(), state: v.optional(v.string()) },
  handler: async (
    ctx,
    { code, state },
  ): Promise<{
    ok: boolean;
    returnTo: string;
    origin: string | null;
    mode: string | null;
  }> => {
    if (!isConfigured()) throw new Error("Google Drive is not configured yet.");

    // Identify the user from the one-time state row created by `authUrl`.
    const pending: {
      userId: Id<"users">;
      returnTo: string;
      origin: string | null;
      mode: string | null;
    } | null = state
      ? await ctx.runMutation(internal.drive.consumeState, { nonce: state })
      : null;
    if (pending === null) {
      throw new Error(
        "This Google Drive sign-in link has expired or was already used — start the connection again.",
      );
    }
    const userId = pending.userId;

    const body = new URLSearchParams({
      code,
      client_id: clientId()!,
      client_secret: clientSecret()!,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    });
    const response = await timedFetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (!response.ok || !json.access_token) {
      throw new Error(
        json.error_description ?? json.error ?? "Google rejected the sign-in.",
      );
    }
    if (!json.refresh_token) {
      throw new Error(
        "Google did not return a refresh token. Remove NatyaVault from your Google account's third-party access and connect again.",
      );
    }

    const email = await fetchDriveEmail(json.access_token);
    const stored = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope: json.scope ?? DRIVE_SCOPE,
      ...(email ? { email } : {}),
    };

    if (pending.mode === "vault") {
      // The class archive. Its token belongs to the deployment, not to the
      // admin's personal connection, so it is stored separately.
      await ctx.runMutation(internal.drive.saveVaultTokens, {
        ...stored,
        connectedBy: pending.userId,
      });
    } else {
      await ctx.runMutation(internal.drive.saveTokens, {
        userId,
        ...stored,
      });
    }

    return {
      ok: true,
      returnTo: pending.returnTo,
      origin: pending.origin,
      mode: pending.mode,
    };
  },
});

async function fetchDriveEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await timedFetch(
      `${DRIVE_API}/about?fields=user(emailAddress)`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!response.ok) return null;
    const json = (await response.json()) as {
      user?: { emailAddress?: string };
    };
    return json.user?.emailAddress ?? null;
  } catch {
    return null;
  }
}

/** Revoke the grant and forget the stored tokens + tracked files. */
export const disconnect = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };
    const tokens = await ctx.runQuery(internal.drive.getTokens, { userId });
    if (tokens !== null) {
      try {
        await timedFetch(
          `${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokens.refreshToken)}`,
          { method: "POST" },
        );
      } catch {
        // Revocation is best-effort; the local grant is cleared regardless.
      }
    }
    await ctx.runMutation(internal.drive.forgetTokens, { userId });
    return { ok: true };
  },
});

// ------------------------------------------------------------------ helpers

/**
 * Whether Google has stopped accepting a token we still hold.
 *
 * Expiry alone can't be trusted: a grant revoked from the user's Google account
 * keeps its recorded `expiresAt`, so Drive answers 401 for the rest of that
 * hour and every call surfaces a raw "invalid authentication credentials"
 * error. One cheap request settles it. A 401 caused by our own client
 * configuration is not revocation and must not drop a working connection.
 */
async function tokenRevoked(accessToken: string): Promise<boolean> {
  let response: Response;
  try {
    response = await timedFetch(`${DRIVE_API}/about?fields=user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    // A network blip is not a revocation; let the real call report it.
    return false;
  }
  if (response.status !== 401) return false;
  // Drive answers with `error` as an object, the token endpoint with a string;
  // a broken client id shows up as the latter.
  const json = (await response.json().catch(() => null)) as {
    error?: string | { errors?: { reason?: string }[] };
  } | null;
  const reason =
    typeof json?.error === "string"
      ? json.error
      : json?.error?.errors?.[0]?.reason;
  return !(
    reason === "invalid_client" ||
    reason === "deleted_client" ||
    reason === "unauthorized_client"
  );
}

/**
 * A token Google still accepts, for one of the two Drive connections.
 *
 * A stored token is trusted only while it is unexpired *and* still accepted:
 * revoking a grant from the user's Google account leaves `expiresAt` an hour
 * in the future, so Drive answers 401 until the clock catches up and every call
 * surfaced a raw "invalid authentication credentials" error. A token that
 * fails that check is refreshed like an expiring one; if the refresh is refused
 * as well, the connection is cleared and the caller told to reconnect.
 */
async function driveToken(
  ctx: { runQuery: unknown; runMutation: unknown },
  store: {
    /** Internal query returning the stored tokens, or null. */
    read: unknown;
    readArgs: Record<string, unknown>;
    /** Internal mutation storing a refreshed token. */
    save: unknown;
    saveArgs: (token: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      scope: string;
    }) => Record<string, unknown>;
    /** Internal mutation forgetting the connection, keeping what it uploaded. */
    clear: unknown;
    clearArgs: Record<string, unknown>;
    notConnected: string;
    reconnect: string;
  },
): Promise<string> {
  const run = ctx as {
    runQuery: <T>(fn: unknown, args: unknown) => Promise<T>;
    runMutation: <T>(fn: unknown, args: unknown) => Promise<T>;
  };
  const tokens = await run.runQuery<{
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } | null>(store.read, store.readArgs);
  if (tokens === null) throw new Error(store.notConnected);
  if (
    tokens.expiresAt - Date.now() > 60_000 &&
    !(await tokenRevoked(tokens.accessToken))
  ) {
    return tokens.accessToken;
  }

  const response = await timedFetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId()!,
      client_secret: clientSecret()!,
      refresh_token: tokens.refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  const json = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!response.ok || !json.access_token) {
    await run.runMutation(store.clear, store.clearArgs);
    throw new Error(store.reconnect);
  }
  await run.runMutation(
    store.save,
    store.saveArgs({
      accessToken: json.access_token,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
      scope: DRIVE_SCOPE,
    }),
  );
  return json.access_token;
}

/** A valid access token for this user, refreshed when it is about to expire. */
export async function accessTokenFor(
  ctx: { runQuery: unknown; runMutation: unknown },
  userId: Id<"users">,
): Promise<string> {
  return driveToken(ctx, {
    read: internal.drive.getTokens,
    readArgs: { userId },
    save: internal.drive.saveTokens,
    saveArgs: (token) => ({ userId, ...token }),
    clear: internal.drive.clearTokens,
    clearArgs: { userId },
    notConnected: "Connect Google Drive first.",
    reconnect:
      "Your Google Drive access expired — connect it again from the Media Vault.",
  });
}

/**
 * A valid access token for the class archive, refreshed when needed.
 *
 * Throws when the admin has not connected one, so callers can fall back to the
 * uploader's own Drive (which is how uploads worked before the archive).
 */
export async function vaultAccessToken(ctx: {
  runQuery: unknown;
  runMutation: unknown;
}): Promise<string> {
  return driveToken(ctx, {
    read: internal.drive.getVaultTokens,
    readArgs: {},
    save: internal.drive.saveVaultTokens,
    saveArgs: (token) => token,
    clear: internal.drive.clearVaultTokens,
    clearArgs: {},
    notConnected: "The class Drive is not connected yet.",
    reconnect:
      "The class Drive connection expired — the admin needs to reconnect it from the Media Vault.",
  });
}

/**
 * Whether the class archive is connected. Used to decide where an upload goes
 * and which stored credential plays a class file back.
 */
export async function vaultIsConnected(ctx: {
  runQuery: unknown;
  runMutation: unknown;
}): Promise<boolean> {
  const run = ctx as {
    runQuery: <T>(fn: unknown, args: unknown) => Promise<T>;
  };
  const tokens = await run.runQuery<unknown>(internal.drive.getVaultTokens, {});
  return tokens !== null;
}

/** The NatyaVault folder in the user's Drive, created on first use. */
async function ensureFolder(accessToken: string): Promise<string> {
  const query = encodeURIComponent(
    `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const found = await timedFetch(
    `${DRIVE_API}/files?q=${query}&spaces=drive&fields=files(id)`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (found.ok) {
    const json = (await found.json()) as { files?: { id: string }[] };
    const existing = json.files?.[0]?.id;
    if (existing) return existing;
  }
  const created = await timedFetch(`${DRIVE_API}/files?fields=id`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: FOLDER_NAME,
      mimeType: "application/vnd.google-apps.folder",
    }),
  });
  const json = (await created.json()) as { id?: string; error?: unknown };
  if (!created.ok || !json.id) {
    throw new Error("Could not create the NatyaVault folder in your Drive.");
  }
  return json.id;
}

// -------------------------------------------------------------------- files

/**
 * Opens a Google Drive resumable upload session.
 *
 * The browser then PUTs the file straight to Google, so the bytes never pass
 * through a Convex function — reading a whole audio/video file into an isolate
 * runs out of memory, and function arguments have a far smaller size limit.
 * Only the resulting file id comes back to us, to record it.
 */
export const startUpload = action({
  args: { name: v.string(), mimeType: v.string(), size: v.number() },
  handler: async (ctx, { name, mimeType, size }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");

    // Everything the class uploads belongs in the class archive, so that one
    // account's Drive is used whenever it is connected. Only when it isn't
    // does an upload fall back to the uploader's own Drive.
    let accessToken: string;
    let target: "vault" | "uploader" = "uploader";
    try {
      accessToken = await vaultAccessToken(ctx);
      target = "vault";
    } catch {
      accessToken = await accessTokenFor(ctx, userId);
    }
    const folderId = await ensureFolder(accessToken);

    const response = await timedFetch(
      `${DRIVE_UPLOAD_API}/files?uploadType=resumable&fields=id,name,size`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mimeType,
          "X-Upload-Content-Length": String(size),
        },
        body: JSON.stringify({ name, parents: [folderId] }),
      },
    );
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(detail?.error?.message ?? "Could not start the Drive upload.");
    }
    const uploadUrl = response.headers.get("Location");
    if (!uploadUrl) throw new Error("Google did not return an upload URL.");
    return { uploadUrl, target };
  },
});

/**
 * Record a file the browser uploaded straight to Drive (no bytes here).
 */
export const finishUpload = action({
  args: {
    fileId: v.string(),
    name: v.string(),
    mimeType: v.string(),
    size: v.number(),
  },
  handler: async (ctx, { fileId, name, mimeType, size }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    // No Drive token is needed here: the browser already uploaded the bytes,
    // and playback mints a media link later (see `fileUrl`). A student whose
    // upload went to the class archive may have no Drive of their own at all.
    await ctx.runMutation(internal.drive.recordFile, {
      userId,
      fileId,
      name,
      mimeType,
      size,
    });
    return { fileId, name, mimeType, size, url: "" };
  },
});

/**
 * Register an upload the browser started but could not confirm (e.g. the
 * response was lost) so it is not left untracked in the user's Drive.
 */
export const cancelUpload = action({
  args: { uploadUrl: v.string() },
  handler: async (ctx, { uploadUrl }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };
    let accessToken: string;
    try {
      accessToken = await vaultAccessToken(ctx);
    } catch {
      accessToken = await accessTokenFor(ctx, userId);
    }
    try {
      await timedFetch(uploadUrl, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // Best effort — the session expires on its own.
    }
    return { ok: true };
  },
});

function mediaUrl(fileId: string, accessToken: string): string {
  // A media element can only authenticate by URL, but Google rejects the
  // `access_token` query parameter on Drive downloads (403) while accepting the
  // same token as an `Authorization` header. So playback goes through the
  // Convex site, which adds the header — see /drive/media-proxy in http.ts.
  const site = cleanEnv(process.env.CONVEX_SITE_URL)?.replace(/\/$/, "");
  if (site) {
    return `${site}/drive/media-proxy?fileId=${encodeURIComponent(
      fileId,
    )}&access_token=${encodeURIComponent(accessToken)}`;
  }
  return `${DRIVE_API}/files/${fileId}?alt=media&access_token=${encodeURIComponent(
    accessToken,
  )}`;
}

// ------------------------------------------------------------ media grants

/** How long a playback link works before a fresh one has to be minted. */
const GRANT_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Mint an opaque, expiring link token for one file.
 *
 * A media element authenticates by URL, but putting a Google access token in
 * that URL would hand the class archive's full credentials to anyone who saw
 * the link (a screenshot, a shared page). So the URL carries one of these
 * instead; the Convex site resolves it to a stored token server-side.
 */
export const createGrant = internalMutation({
  args: {
    fileId: v.string(),
    /** Omitted for class-archive files, which use the vault's token. */
    ownerUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, { fileId, ownerUserId }) => {
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(
      /-/g,
      "",
    );
    const now = Date.now();
    await ctx.db.insert("mediaGrants", {
      token,
      fileId,
      ...(ownerUserId ? { ownerUserId } : {}),
      expiresAt: now + GRANT_TTL_MS,
      createdAt: now,
    });
    return { token };
  },
});

/** Resolve (and expire) a media link token. */
export const grantFor = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query("mediaGrants")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (row === null) return null;
    if (row.expiresAt < Date.now()) {
      await ctx.db.delete(row._id);
      return null;
    }
    return { fileId: row.fileId, ownerUserId: row.ownerUserId ?? null };
  },
});

/** A Drive token for whatever store owns the file behind a grant. */
export const tokenForGrant = internalAction({
  args: { ownerUserId: v.optional(v.id("users")) },
  handler: async (ctx, { ownerUserId }) => {
    const accessToken = ownerUserId
      ? await accessTokenFor(ctx, ownerUserId)
      : await vaultAccessToken(ctx);
    return { accessToken };
  },
});

/** The Convex-site URL a grant is played through. */
function grantMediaUrl(fileId: string, token: string): string | null {
  const site = cleanEnv(process.env.CONVEX_SITE_URL)?.replace(/\/$/, "");
  if (!site) return null;
  return `${site}/drive/media-proxy?fileId=${encodeURIComponent(
    fileId,
  )}&grant=${encodeURIComponent(token)}`;
}

/**
 * Delete a Drive file using the token of the account that owns it.
 *
 * Class uploads in the class archive are deleted with the archive's token;
 * uploads from before it was connected live in the uploader's Drive, so their
 * credential does it.
 */
export const removeForOwner = internalAction({
  args: {
    fileId: v.string(),
    uploaderId: v.id("users"),
    owner: v.optional(v.union(v.literal("vault"), v.literal("uploader"))),
  },
  handler: async (ctx, { fileId, uploaderId, owner }) => {
    let accessToken: string | null = null;
    if (owner === "vault") {
      accessToken = await vaultAccessToken(ctx);
    } else {
      try {
        accessToken = await accessTokenFor(ctx, uploaderId);
      } catch {
        accessToken = null;
      }
    }
    if (accessToken === null) {
      throw new Error("No Drive connection can delete this file.");
    }

    const response = await timedFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Google Drive delete failed with status ${response.status}`);
    }
    await ctx.runMutation(internal.drive.forgetFile, {
      userId: uploaderId,
      fileId,
    });
    return { ok: true };
  },
});

/**
 * A playable URL for a Drive file.
 *
 * Class uploads are authorised by class membership here and then played
 * through an expiring link, so a dancemate needs no Google account of their
 * own — the class archive (or the uploader's) stored token does the reading.
 * Anything else is a file in the caller's own Drive.
 */
export const fileUrl = action({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const shared = await ctx.runQuery(internal.vault.byDriveFile, { fileId });
    if (shared !== null) {
      if (
        !(await ctx.runQuery(internal.vault.memberFor, {
          userId,
          code: shared.code,
        }))
      ) {
        return null;
      }

      // A file uploaded before the class archive existed lives in a personal
      // Drive, so that account's token reads it instead.
      const vaultOwned = shared.owner === "vault";
      if (vaultOwned && !(await vaultIsConnected(ctx))) return null;
      const grant = await ctx.runMutation(internal.drive.createGrant, {
        fileId,
        ...(vaultOwned ? {} : { ownerUserId: shared.uploaderId }),
      });
      const url = grantMediaUrl(fileId, grant.token);
      return url === null ? null : { url };
    }

    const accessToken = await accessTokenFor(ctx, userId);
    return { url: mediaUrl(fileId, accessToken) };
  },
});

/** Revoke and forget the class archive connection (admin only). */
export const disconnectVault = action({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };
    if (
      !(await ctx.runQuery(internal.drive.viewerManagesClasses, { userId }))
    ) {
      return { ok: false };
    }
    const tokens = await ctx.runQuery(internal.drive.getVaultTokens, {});
    if (tokens !== null) {
      try {
        await timedFetch(
          `${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokens.refreshToken)}`,
          { method: "POST" },
        );
      } catch {
        // Revocation is best-effort; the local grant is cleared regardless.
      }
    }
    await ctx.runMutation(internal.drive.clearVaultTokens, {});
    return { ok: true };
  },
});

/** Delete a file this app uploaded (and forget it locally). */
export const remove = action({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };
    const accessToken = await accessTokenFor(ctx, userId);
    const response = await timedFetch(`${DRIVE_API}/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    // 404 means it is already gone — treat that as success.
    if (!response.ok && response.status !== 404) {
      return { ok: false };
    }
    await ctx.runMutation(internal.drive.forgetFile, { userId, fileId });
    return { ok: true };
  },
});

interface DriveEntry {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  /** Present when the entry is a Drive shortcut (see `resolveEntry`). */
  shortcutDetails?: { targetId: string; targetMimeType: string };
}

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

/**
 * Follow a Drive shortcut to the file or folder it points at.
 *
 * A shortcut is its own entry (`application/vnd.google-apps.shortcut`) whose
 * `shortcutDetails` name the target. Left alone it would be mistaken for a
 * regular file — and, being neither audio nor video, classified as audio — so
 * every listing swaps in the target's id and mime type. This is what makes a
 * "folder" the user added as a Drive shortcut (`Add shortcut to Drive`) behave
 * like the folder it points at, both in the picker and when importing.
 */
function resolveEntry(entry: DriveEntry): DriveEntry {
  const target = entry.shortcutDetails;
  if (entry.mimeType === DRIVE_SHORTCUT_MIME && target) {
    return { ...entry, id: target.targetId, mimeType: target.targetMimeType };
  }
  return entry;
}

/** Read one level of a Drive folder (folders and non-folder files). */
async function listChildren(
  accessToken: string,
  parent: string,
): Promise<DriveEntry[]> {
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false`);
  const fields = encodeURIComponent(
    "files(id,name,mimeType,size,modifiedTime,shortcutDetails)",
  );
  const response = await timedFetch(
    `${DRIVE_API}/files?q=${q}&spaces=drive&fields=${fields}&orderBy=folder,name&pageSize=200`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const json = (await response.json().catch(() => null)) as {
    files?: DriveEntry[];
    error?: { message?: string };
  } | null;
  if (!response.ok || json === null) {
    throw new Error(
      json?.error?.message ?? "Could not read that folder on Google Drive.",
    );
  }
  return json.files ?? [];
}

/**
 * One level of the signed-in user's Google Drive, for the folder picker.
 *
 * No `folderId` (or `"root"`) means the top of their My Drive, so any folder
 * they already keep on Drive can be browsed to — not just the app's own
 * NatyaVault folder. Each top-level folder is opened in a fresh call, so the
 * tree is never walked further than the user actually looks at.
 */
export const browse = action({
  args: { folderId: v.optional(v.string()) },
  handler: async (ctx, { folderId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    const accessToken = await accessTokenFor(ctx, userId);

    const parent = folderId && folderId !== "root" ? folderId : "root";
    const entries = await listChildren(accessToken, parent);

    const folders: { id: string; name: string }[] = [];
    const files: {
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      modifiedTime: string | null;
    }[] = [];
    for (const entry of entries.map(resolveEntry)) {
      if (entry.mimeType === DRIVE_FOLDER_MIME) {
        folders.push({ id: entry.id, name: entry.name });
      } else {
        files.push({
          fileId: entry.id,
          name: entry.name,
          mimeType: entry.mimeType,
          size: entry.size ? Number(entry.size) : 0,
          modifiedTime: entry.modifiedTime ?? null,
        });
      }
    }

    return {
      id: folderId && folderId !== "root" ? folderId : null,
      folders,
      files,
    };
  },
});

/**
 * Every folder and file beneath a Drive folder (recursively), each tagged with
 * the folder it lives in (`parentId`: the Drive folder id, or null for the
 * folder the walk started from).
 *
 * Folders are returned before their contents (breadth-first) so a client can
 * recreate the structure one level at a time. Called only when a folder is
 * actually being imported, which is what lets the vault pull in a whole folder
 * and all its subfolders in one go without walking the entire Drive up front.
 */
export const listSubtree = action({
  args: { folderId: v.string() },
  handler: async (ctx, { folderId: startId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    const accessToken = await accessTokenFor(ctx, userId);

    const folders: { id: string; name: string; parentId: string | null }[] = [];
    const files: {
      fileId: string;
      name: string;
      mimeType: string;
      size: number;
      modifiedTime: string | null;
      parentId: string | null;
    }[] = [];

    // Breadth-first walk from the chosen folder. The bound keeps a huge Drive
    // from running the action out of time.
    const queue: string[] = [startId];
    let scanned = 0;
    while (queue.length > 0 && scanned < 300) {
      const current = queue.shift()!;
      scanned++;
      const parentId = current === startId ? null : current;
      for (const entry of (await listChildren(accessToken, current)).map(
        resolveEntry,
      )) {
        if (entry.mimeType === DRIVE_FOLDER_MIME) {
          folders.push({ id: entry.id, name: entry.name, parentId });
          queue.push(entry.id);
        } else {
          files.push({
            fileId: entry.id,
            name: entry.name,
            mimeType: entry.mimeType,
            size: entry.size ? Number(entry.size) : 0,
            modifiedTime: entry.modifiedTime ?? null,
            parentId,
          });
        }
      }
    }

    return { folders, files };
  },
});

/** Files this app has uploaded for the signed-in user. */
export const files = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("driveFiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
  },
});
