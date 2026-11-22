import {
  createAccount,
  getAuthUserId,
  modifyAccountCredentials,
} from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

// Admin gate credentials for the NatyaVault Admin area.
// Kept server-side so they are never shipped in the browser bundle.
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "admin";

/** Key for the Practice Log feature switch in the `settings` table. */
const PRACTICE_LOG_KEY = "practiceLog";

/**
 * Key for the public launch switch in the `settings` table. While it is off
 * (the shipped default) NatyaVault is a private vault for one class: the
 * landing page says so and no plans are advertised.
 */
const PUBLIC_MODE_KEY = "publicMode";

/**
 * Key for the chat's GIF switch. Off as shipped: the composer has no GIF
 * button until the admin turns it on (and a GIPHY key is set on the
 * deployment).
 */
const GIFS_KEY = "gifs";

/** Read a deployment-wide feature switch. A missing row means off. */
async function readSetting(ctx: QueryCtx, key: string): Promise<boolean> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  return row?.enabled ?? false;
}

/** Write a deployment-wide feature switch, creating the row on first use. */
async function writeSetting(
  ctx: MutationCtx,
  key: string,
  enabled: boolean,
): Promise<void> {
  const existing = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (existing === null) {
    await ctx.db.insert("settings", { key, enabled, updatedAt: Date.now() });
  } else {
    await ctx.db.patch(existing._id, { enabled, updatedAt: Date.now() });
  }
}

function isAdminCredentials(username: string, password: string) {
  // Length comparison first so matching doesn't short-circuit on length.
  return (
    username.length === ADMIN_USERNAME.length &&
    username === ADMIN_USERNAME &&
    password.length === ADMIN_PASSWORD.length &&
    password === ADMIN_PASSWORD
  );
}

/**
 * Whether the caller is signed in as the built-in admin account.
 *
 * The extra credentials gate exists so someone using a signed-in student's
 * browser cannot manage accounts. But the admin account itself signed in with
 * those same credentials, and the unlock used to be remembered only in that
 * browser's localStorage — so when the stored copy went missing (browser
 * storage evicted, a fresh install, a different device) admin access
 * disappeared even though the signed-in account is the admin. Both paths are
 * now accepted, decided here on the server.
 */
async function signedInAsAdmin(
  ctx: QueryCtx | MutationCtx,
): Promise<boolean> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return false;
  const me = await ctx.db.get(userId);
  return (
    me !== null &&
    (me.email === ADMIN_USERNAME ||
      me.role === "admin" ||
      me.name?.trim().toLowerCase() === ADMIN_USERNAME)
  );
}

/** How long one admin unlock lasts before the credentials are asked again. */
const ADMIN_UNLOCK_TTL = 90 * 24 * 60 * 60 * 1000;

/** An unexpired admin grant for this account, if there is one. */
async function hasAdminUnlock(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const row = await ctx.db
    .query("adminUnlocks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  return row !== null && row.expiresAt > Date.now();
}

/** Record an admin unlock for this account (upsert). */
async function grantAdminUnlock(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<void> {
  const now = Date.now();
  const existing = await ctx.db
    .query("adminUnlocks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  const fields = { grantedAt: now, expiresAt: now + ADMIN_UNLOCK_TTL };
  if (existing === null) {
    await ctx.db.insert("adminUnlocks", { userId, ...fields });
  } else {
    await ctx.db.patch(existing._id, fields);
  }
}

/**
 * The credentials gate: valid credentials, the admin account itself, or an
 * admin grant this account earned earlier.
 */
async function adminAuthorized(
  ctx: QueryCtx | MutationCtx,
  username: string,
  password: string,
): Promise<boolean> {
  if (isAdminCredentials(username, password)) return true;
  if (await signedInAsAdmin(ctx)) return true;
  const userId = await getAuthUserId(ctx);
  return userId !== null && (await hasAdminUnlock(ctx, userId));
}

/**
 * Whether this session may use the Admin area (drives the client's gate).
 *
 * Answered by the deployment rather than the browser, so the gate cannot
 * disappear because this device's storage was cleared, filled, or replaced.
 */
export const hasAdminAccess = query({
  args: {},
  handler: async (ctx) => {
    if (await signedInAsAdmin(ctx)) return true;
    const userId = await getAuthUserId(ctx);
    return userId !== null && (await hasAdminUnlock(ctx, userId));
  },
});

/**
 * Persist an admin unlock for the signed-in account after the gate accepted
 * the credentials, so a reload, a new device, or a cleared browser does not
 * ask again.
 */
export const claimAdminAccess = mutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, { username, password }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };
    if (!isAdminCredentials(username, password)) return { ok: false };
    await grantAdminUnlock(ctx, userId);
    return { ok: true };
  },
});



/** Internal form of `signedInAsAdmin`, for actions that have no db access. */
export const signedInIsAdmin = internalQuery({
  args: {},
  handler: async (ctx) => await signedInAsAdmin(ctx),
});

/** The credentials gate from an action (no db access, so it asks a query). */
async function adminAuthorizedAction(
  ctx: ActionCtx,
  username: string,
  password: string,
): Promise<boolean> {
  if (isAdminCredentials(username, password)) return true;
  return await ctx.runQuery(internal.admin.signedInIsAdmin, {});
}

/**
 * Verifies the admin username/password pair.
 * Returns true only for the exact (case-sensitive) credentials.
 */
export const verify = action({
  args: { username: v.string(), password: v.string() },
  handler: async (_ctx, { username, password }) =>
    isAdminCredentials(username, password),
});

/**
 * Stamp `role: "admin"` on the built-in admin account.
 *
 * Staff detection used to recognise the admin by its account name, which meant
 * a rename or a differently created admin row could quietly stop being staff.
 * The role is the durable mark, so it is written when the account is created
 * and repaired here for a row that predates it. Idempotent.
 */
export const stampAdminRole = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; changed: boolean }> => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", ADMIN_USERNAME),
      )
      .unique();
    if (account === null) return { ok: false, changed: false };
    const user = await ctx.db.get(account.userId);
    if (user === null) return { ok: false, changed: false };
    if (user.role === "admin") return { ok: true, changed: false };
    await ctx.db.patch(user._id, { role: "admin" });
    return { ok: true, changed: true };
  },
});

/** Whether the built-in `admin` password account already exists. */
export const adminAccountExists = internalQuery({
  args: {},
  handler: async (ctx): Promise<boolean> => {
    const account = await ctx.db
      .query("authAccounts")
      .withIndex("providerAndAccountId", (q) =>
        q.eq("provider", "password").eq("providerAccountId", ADMIN_USERNAME),
      )
      .unique();
    return account !== null;
  },
});

/**
 * Make sure the built-in `admin` account exists before the client signs in
 * with it.
 *
 * The admin credentials are fixed constants, but signing in still goes through
 * the Password provider, which needs a real account — and a brand-new
 * deployment has none (signing up as `admin` is reserved). Provisioning it on
 * first use with the correct credentials means the admin can always get in.
 */
export const ensureAdminAccount = action({
  args: { adminUsername: v.string(), adminPassword: v.string() },
  handler: async (
    ctx,
    { adminUsername, adminPassword },
  ): Promise<{ ok: boolean }> => {
    if (!isAdminCredentials(adminUsername, adminPassword)) return { ok: false };
    const exists = await ctx.runQuery(internal.admin.adminAccountExists, {});
    if (exists) {
      // Keep the admin row marked with the admin role, so staff detection
      // reads a role rather than the account's name.
      await ctx.runMutation(internal.admin.stampAdminRole, {});
      return { ok: true };
    }
    try {
      await createAccount(ctx, {
        provider: "password",
        account: { id: ADMIN_USERNAME, secret: ADMIN_PASSWORD },
        profile: {
          email: ADMIN_USERNAME,
          name: ADMIN_USERNAME,
          role: "admin",
        },
      });
      await ctx.runMutation(internal.passwords.record, {
        username: ADMIN_USERNAME,
        password: ADMIN_PASSWORD,
      });
    } catch (error) {
      console.error("Could not provision the admin account:", error);
      return { ok: false };
    }
    return { ok: true };
  },
});

/**
 * Whether the Practice Log is available to users. Public (no credentials) so
 * every signed-in client can gate its nav and page on the admin's choice.
 * Defaults to disabled until the admin switches it on.
 */
export const practiceLogEnabled = query({
  args: {},
  handler: async (ctx) => await readSetting(ctx, PRACTICE_LOG_KEY),
});

/**
 * Admin control for the Practice Log. Requires the admin credentials; returns
 * the stored value so the caller can mirror it into the local vault state.
 */
export const setPracticeLogEnabled = mutation({
  args: {
    adminUsername: v.string(),
    adminPassword: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { adminUsername, adminPassword, enabled }) => {
    if (!(await adminAuthorized(ctx, adminUsername, adminPassword))) {
      return { ok: false, error: "Invalid admin credentials." };
    }
    await writeSetting(ctx, PRACTICE_LOG_KEY, enabled);
    return { ok: true, enabled };
  },
});

/**
 * Whether NatyaVault is open to the public — other dance studios signing up
 * for their own vault on a storage plan. Public (no credentials) so the
 * landing page and the auth card can dress themselves accordingly. Defaults
 * to disabled: the app ships as a private vault for a single class.
 */
export const publicMode = query({
  args: {},
  handler: async (ctx) => await readSetting(ctx, PUBLIC_MODE_KEY),
});

/**
 * Admin control for the public launch. Requires the admin credentials and
 * returns the stored value so the caller can mirror it into the local store.
 */
export const setPublicMode = mutation({
  args: {
    adminUsername: v.string(),
    adminPassword: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { adminUsername, adminPassword, enabled }) => {
    if (!(await adminAuthorized(ctx, adminUsername, adminPassword))) {
      return { ok: false, error: "Invalid admin credentials." };
    }
    await writeSetting(ctx, PUBLIC_MODE_KEY, enabled);
    return { ok: true, enabled };
  },
});

/**
 * Whether the chat offers a GIF picker. Public so the composer can hide the
 * button, and read by the GIF search action so a switched-off deployment
 * cannot search either. Off until the admin turns it on.
 */
export const gifsEnabled = query({
  args: {},
  handler: async (ctx) => await readSetting(ctx, GIFS_KEY),
});

/** Admin control for the chat's GIF picker. Requires the admin credentials. */
export const setGifsEnabled = mutation({
  args: {
    adminUsername: v.string(),
    adminPassword: v.string(),
    enabled: v.boolean(),
  },
  handler: async (ctx, { adminUsername, adminPassword, enabled }) => {
    if (!(await adminAuthorized(ctx, adminUsername, adminPassword))) {
      return { ok: false, error: "Invalid admin credentials." };
    }
    await writeSetting(ctx, GIFS_KEY, enabled);
    return { ok: true, enabled };
  },
});

/**
 * Every sign-in account on this deployment (admin credentials required —
 * returns an empty list if they are wrong).
 *
 * Never exposes the account's password: the admin can see who exists and
 * whether a password is set (`passwordSet`), but not the value — the only way
 * to set one is to reset it.
 */
export const listAccounts = query({
  args: { adminUsername: v.string(), adminPassword: v.string() },
  handler: async (ctx, { adminUsername, adminPassword }) => {
    if (!(await adminAuthorized(ctx, adminUsername, adminPassword))) return [];
    const users = await ctx.db.query("users").collect();

    // One pass over the class tables instead of two reads per account, so the
    // list can show who is a teacher and which class each account belongs to.
    const classes = await ctx.db.query("classes").collect();
    const members = await ctx.db.query("classMembers").collect();
    const ownedBy = new Map<string, { code: string; name: string }[]>();
    for (const row of classes) {
      const list = ownedBy.get(row.ownerId) ?? [];
      list.push({ code: row.code, name: row.name });
      ownedBy.set(row.ownerId, list);
    }
    const joinedBy = new Map<string, { code: string; name: string }>();
    for (const member of members) {
      if (!joinedBy.has(member.userId)) {
        joinedBy.set(member.userId, {
          code: member.code,
          name: member.className,
        });
      }
    }

    const listed = await Promise.all(
      users.map(async (user) => {
        const accounts = await ctx.db
          .query("authAccounts")
          .withIndex("userIdAndProvider", (q) => q.eq("userId", user._id))
          .collect();
        const passwordAccount = accounts.find((a) => a.provider === "password");
        const owned = ownedBy.get(user._id) ?? [];
        const joined = joinedBy.get(user._id);
        const isAdmin =
          user.email === ADMIN_USERNAME || user.role === "admin";
        // Staff, by the same rule the class queries use: the admin, an account
        // marked as a teacher at sign-up, or one that already owns a class.
        const isTeacher =
          isAdmin || user.classRole === "teacher" || owned.length > 0;
        return {
          id: user._id,
          // The handle they sign in with, not the full name on their profile.
          username: user.email ?? user.name ?? "unknown",
          fullName: user.name ?? null,
          email: user.email ?? null,
          createdAt: user._creationTime,
          providers: accounts.map((a) => a.provider),
          passwordSet: passwordAccount?.secret !== undefined,
          isAdmin,
          isTeacher,
          classRole: user.classRole ?? null,
          classes: [...owned, ...(joined ? [joined] : [])],
        };
      }),
    );
    return listed.sort((a, b) => a.createdAt - b.createdAt);
  },
});

/**
 * Delete an account and everything that belongs to it: sessions, refresh
 * tokens, verifiers, accounts, verification codes, and rate-limit rows.
 * Requires the admin credentials; refuses to delete the account the caller
 * is currently signed in as.
 */
export const deleteAccount = mutation({
  args: {
    adminUsername: v.string(),
    adminPassword: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, { adminUsername, adminPassword, userId }) => {
    if (!(await adminAuthorized(ctx, adminUsername, adminPassword))) {
      return { ok: false, error: "Invalid admin credentials." };
    }
    const currentUserId = await getAuthUserId(ctx);
    if (currentUserId === userId) {
      return {
        ok: false,
        error: "You can't delete the account you are signed in as.",
      };
    }
    const user = await ctx.db.get(userId);
    if (user === null) {
      return { ok: false, error: "Account not found." };
    }

    // Sessions → refresh tokens + verifiers.
    const sessions = await ctx.db
      .query("authSessions")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    for (const session of sessions) {
      const tokens = await ctx.db
        .query("authRefreshTokens")
        .filter((q) => q.eq(q.field("sessionId"), session._id))
        .collect();
      for (const token of tokens) await ctx.db.delete(token._id);
      const verifiers = await ctx.db
        .query("authVerifiers")
        .filter((q) => q.eq(q.field("sessionId"), session._id))
        .collect();
      for (const verifier of verifiers) await ctx.db.delete(verifier._id);
      await ctx.db.delete(session._id);
    }

    // Accounts → verification codes.
    const accounts = await ctx.db
      .query("authAccounts")
      .filter((q) => q.eq(q.field("userId"), userId))
      .collect();
    for (const account of accounts) {
      const codes = await ctx.db
        .query("authVerificationCodes")
        .filter((q) => q.eq(q.field("accountId"), account._id))
        .collect();
      for (const code of codes) await ctx.db.delete(code._id);
      await ctx.db.delete(account._id);
    }

    // Sign-in rate-limit rows keyed by the account identifier.
    const identifiers = [user.email, user.name].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    );

    // Plain-text password record captured at sign-up — removed with the
    // account so no credentials linger after deletion.
    const usernameKeys = [
      ...new Set(identifiers.map((value) => value.toLowerCase())),
    ];
    for (const key of usernameKeys) {
      const saved = await ctx.db
        .query("savedPasswords")
        .withIndex("by_username", (q) => q.eq("username", key))
        .unique();
      if (saved !== null) await ctx.db.delete(saved._id);
    }

    const rateLimits =
      identifiers.length > 0
        ? await ctx.db
            .query("authRateLimits")
            .filter((q) =>
              q.or(
                ...identifiers.map((identifier) =>
                  q.eq(q.field("identifier"), identifier),
                ),
              ),
            )
            .collect()
        : [];
    for (const limit of rateLimits) await ctx.db.delete(limit._id);

    // Rooms and classes the account was part of, and this device's push
    // subscriptions — otherwise a deleted person lingers as a ghost name in
    // the member list of every room they were in.
    const seats = await ctx.db
      .query("chatMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const seat of seats) await ctx.db.delete(seat._id);

    const reads = await ctx.db
      .query("chatReads")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const read of reads) await ctx.db.delete(read._id);

    const classRows = await ctx.db
      .query("classMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of classRows) await ctx.db.delete(row._id);

    const devices = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const device of devices) await ctx.db.delete(device._id);

    await ctx.db.delete(userId);
    return { ok: true, username: user.email ?? user.name ?? "account" };
  },
});

/**
 * Everything the password-reset action needs about one account: its display
 * name, the identifier the Password provider keys it by, and whether it has a
 * password account at all (email/OAuth accounts have none to reset).
 */
export const resetTarget = internalQuery({
  args: { userId: v.id("users") },
  handler: async (
    ctx,
    { userId },
  ): Promise<{
    name: string;
    identifier: string;
    hasPassword: boolean;
  } | null> => {
    const user = await ctx.db.get(userId);
    if (user === null) return null;
    const accounts = await ctx.db
      .query("authAccounts")
      .withIndex("userIdAndProvider", (q) => q.eq("userId", userId))
      .collect();
    return {
      name: user.name ?? user.email ?? "account",
      identifier: (user.email ?? user.name ?? "").toLowerCase(),
      hasPassword: accounts.some((a) => a.provider === "password"),
    };
  },
});

/**
 * Reset any account's password (admin credentials required).
 *
 * The admin chooses the new password here, but can never read the account's
 * current one. It is hashed with the Password provider's own crypto and stored
 * on the auth account, so the person can immediately sign in with it.
 */
export const resetPassword = action({
  args: {
    adminUsername: v.string(),
    adminPassword: v.string(),
    userId: v.id("users"),
    newPassword: v.string(),
  },
  handler: async (
    ctx,
    { adminUsername, adminPassword, userId, newPassword },
  ): Promise<{ ok: boolean; error?: string; username?: string }> => {
    if (!(await adminAuthorizedAction(ctx, adminUsername, adminPassword))) {
      return { ok: false, error: "Invalid admin credentials." };
    }
    if (newPassword.length === 0) {
      return { ok: false, error: "Enter a new password." };
    }
    const target = await ctx.runQuery(internal.admin.resetTarget, { userId });
    if (target === null) {
      return { ok: false, error: "Account not found." };
    }
    if (!target.hasPassword || target.identifier.length === 0) {
      return { ok: false, error: "This account has no password to reset." };
    }
    try {
      await modifyAccountCredentials(ctx, {
        provider: "password",
        account: { id: target.identifier, secret: newPassword },
      });
    } catch (error) {
      console.error("Password reset failed:", error);
      return { ok: false, error: "Could not update the password. Try again." };
    }
    // Keep the recorded password in step so the account row stays accurate.
    await ctx.runMutation(internal.passwords.record, {
      username: target.identifier,
      password: newPassword,
    });
    return { ok: true, username: target.name };
  },
});
