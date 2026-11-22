import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findClass } from "./classes";
import { classAccess } from "./studios";

/**
 * The practice log, per class, on the deployment.
 *
 * Sessions used to live in each browser's localStorage, which meant a teacher
 * could never see a student's practice on another device, the leaderboard was
 * whatever that browser happened to hold, and clearing the browser wiped the
 * history. Rows here are keyed by the class's join code, so everyone in a
 * class reads the same log anywhere.
 *
 * Who may do what:
 *  - any member of the class (or staff, who may open every class) may read the
 *    class's sessions — the leaderboard already shows everyone's minutes;
 *  - a member may log their own session, and the admin's Practice Log switch is
 *    enforced here, not only in the UI;
 *  - a session may be deleted by the account that logged it, or by staff.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_MINUTES = 600;
const MAX_ITEM = 80;
/** Ceiling on a one-time import, so a bad client can't post forever. */
const MAX_IMPORT = 200;

/** A class day, or null when it isn't a real `YYYY-MM-DD` date. */
function cleanDate(raw: string): string | null {
  const value = raw.trim();
  if (!DATE_PATTERN.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

/** The class record, when this account may use that class at all. */
async function usableClass(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  code: string,
) {
  const row = await findClass(ctx, code);
  if (row === null) return null;
  const access = await classAccess(ctx, userId, row);
  return access.read ? row : null;
}

/**
 * The class's practice sessions, newest first.
 *
 * `since` (a `YYYY-MM-DD`) narrows the window; the dashboard asks for the last
 * month for its leaderboard. `viewerIsStaff` comes from the deployment so the
 * page can show the review view without trusting this browser's stored role.
 */
export const classPractice = query({
  args: { code: v.string(), since: v.optional(v.string()) },
  handler: async (ctx, { code, since }) => {
    const closed = {
      ok: false,
      entries: [] as {
        id: Id<"practiceEntries">;
        date: string;
        minutes: number;
        item: string;
        author: string;
        authorId: Id<"users">;
        createdAt: number;
        mine: boolean;
      }[],
      viewerIsStaff: false,
    };
    const userId = await getAuthUserId(ctx);
    if (userId === null) return closed;

    const row = await findClass(ctx, code);
    if (row === null) return closed;
    const access = await classAccess(ctx, userId, row);
    const viewerIsStaff = access.staff;
    if (!access.read) return closed;

    const from = since ? cleanDate(since) : null;
    const rows = from
      ? await ctx.db
          .query("practiceEntries")
          .withIndex("by_code_and_date", (q) =>
            q.eq("code", row.code).gte("date", from),
          )
          .collect()
      : await ctx.db
          .query("practiceEntries")
          .withIndex("by_code", (q) => q.eq("code", row.code))
          .collect();

    const entries = rows
      .map((entry) => ({
        id: entry._id,
        date: entry.date,
        minutes: entry.minutes,
        item: entry.item,
        author: entry.authorName,
        authorId: entry.authorId,
        createdAt: entry.createdAt,
        mine: entry.authorId === userId,
      }))
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) || b.createdAt - a.createdAt,
      );

    return { ok: true, entries, viewerIsStaff };
  },
});

/** Log one practice session for the signed-in account. */
export const addEntry = mutation({
  args: {
    code: v.string(),
    date: v.string(),
    minutes: v.number(),
    item: v.string(),
  },
  handler: async (
    ctx,
    { code, date, minutes, item },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const row = await usableClass(ctx, userId, code);
    if (row === null) {
      return { ok: false, error: "You're not in this class." };
    }

    // The admin's switch is the authority, so a stale page can't post while
    // the Practice Log is off for everyone.
    const enabled = await ctx.runQuery(api.admin.practiceLogEnabled, {});
    if (!enabled) {
      return {
        ok: false,
        error: "The Practice Log is turned off by the admin.",
      };
    }

    const day = cleanDate(date);
    if (day === null) return { ok: false, error: "That date looks wrong." };

    const duration = Math.round(minutes);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MINUTES) {
      return { ok: false, error: "Enter how many minutes you practised." };
    }

    const title = item.trim().replace(/\s+/g, " ").slice(0, MAX_ITEM);
    if (!title) return { ok: false, error: "Type the item you practised." };

    const me = await ctx.db.get(userId);
    await ctx.db.insert("practiceEntries", {
      code: row.code,
      authorId: userId,
      authorName: me?.name ?? me?.email ?? "dancer",
      date: day,
      minutes: duration,
      item: title,
      createdAt: Date.now(),
    });
    return { ok: true, error: null };
  },
});

/**
 * Remove one session: its own author, or staff. Deleting is allowed even
 * while the Practice Log is switched off, so a mistake can still be undone.
 */
export const removeEntry = mutation({
  args: { id: v.id("practiceEntries") },
  handler: async (
    ctx,
    { id },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const entry = await ctx.db.get(id);
    // Already gone — nothing to report to a reader who wanted it gone.
    if (entry === null) return { ok: true, error: null };

    const classRow = await usableClass(ctx, userId, entry.code);
    if (classRow === null) {
      return { ok: false, error: "You're not in this class." };
    }
    if (entry.authorId !== userId && !(await classAccess(ctx, userId, classRow)).staff) {
      return { ok: false, error: "You can only delete your own sessions." };
    }

    await ctx.db.delete(id);
    return { ok: true, error: null };
  },
});

/**
 * One-time import of the sessions this browser logged before the log moved to
 * the deployment. Entries carry their old local id as `clientId`, so running
 * this again (another tab, a reload) skips what is already here.
 */
export const importLocal = mutation({
  args: {
    code: v.string(),
    entries: v.array(
      v.object({
        clientId: v.string(),
        date: v.string(),
        minutes: v.number(),
        item: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    { code, entries },
  ): Promise<{ ok: boolean; imported: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, imported: 0 };

    const row = await usableClass(ctx, userId, code);
    if (row === null) return { ok: false, imported: 0 };

    const me = await ctx.db.get(userId);
    const authorName = me?.name ?? me?.email ?? "dancer";

    let imported = 0;
    for (const entry of entries.slice(0, MAX_IMPORT)) {
      const day = cleanDate(entry.date);
      const duration = Math.round(entry.minutes);
      const title = entry.item.trim().replace(/\s+/g, " ").slice(0, MAX_ITEM);
      if (
        day === null ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > MAX_MINUTES ||
        !title ||
        !entry.clientId
      ) {
        continue;
      }
      const existing = await ctx.db
        .query("practiceEntries")
        .withIndex("by_client", (q) => q.eq("clientId", entry.clientId))
        .first();
      if (existing !== null) continue;

      await ctx.db.insert("practiceEntries", {
        code: row.code,
        authorId: userId,
        authorName,
        date: day,
        minutes: duration,
        item: title,
        createdAt: Date.now(),
        clientId: entry.clientId,
      });
      imported++;
    }

    return { ok: true, imported };
  },
});
