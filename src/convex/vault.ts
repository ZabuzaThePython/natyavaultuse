import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findClass } from "./classes";
import { classAccess } from "./studios";

/**
 * The class media vault, on the deployment.
 *
 * Uploads used to be listed only in the browser's localStorage, so a clip a
 * student uploaded existed on that one device — the teacher's vault never
 * showed it, and another phone saw an empty shelf. Rows here are keyed by the
 * class's join code, so every member reads the same list.
 *
 * Only Drive-backed uploads are stored here. A file kept in the browser as a
 * data URL cannot be opened on someone else's device, so listing it class-wide
 * would just be a broken row; those stay local to their uploader.
 *
 * Who may do what:
 *  - any member of the class (or staff, who may open every class) may read it;
 *  - a member may add an upload to their own class;
 *  - an upload may be renamed or removed by the account that added it, or by
 *    staff.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_TITLE = 120;

const kindValidator = v.union(v.literal("audio"), v.literal("video"));

/** The class record, when this account may use that class at all. */
async function usableClass(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  rawCode: string,
) {
  const row = await findClass(ctx, rawCode);
  if (row === null) return null;
  const access = await classAccess(ctx, userId, row);
  return access.read ? row : null;
}

/** A `YYYY-MM-DD` day, or today when the value is unusable. */
function cleanDate(raw: string): string {
  const value = raw.trim();
  return DATE_PATTERN.test(value) ? value : new Date().toISOString().slice(0, 10);
}

/**
 * The class's shared media, newest first.
 *
 * `mine` and `canRemove` come from the deployment so the page can show the
 * right controls without trusting a locally stored role.
 */
export const classMedia = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, items: [] as never[] };

    const row = await findClass(ctx, code);
    if (row === null) return { ok: false, items: [] as never[] };

    const access = await classAccess(ctx, userId, row);
    if (!access.read) return { ok: false, items: [] as never[] };
    const staff = access.staff;

    const rows = await ctx.db
      .query("vaultMedia")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();

    const items = rows
      .map((item) => ({
        id: item._id,
        kind: item.kind,
        title: item.title,
        mimeType: item.mimeType,
        driveFileId: item.driveFileId,
        uploader: item.uploaderName,
        date: item.date,
        createdAt: item.createdAt,
        mine: item.uploaderId === userId,
        canRemove: item.uploaderId === userId || staff,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);

    return { ok: true, items };
  },
});

/** Add an upload to the class vault (after its bytes reached Google Drive). */
export const addShared = mutation({
  args: {
    code: v.string(),
    kind: kindValidator,
    title: v.string(),
    mimeType: v.string(),
    driveFileId: v.string(),
    date: v.string(),
    /** Which Drive received the bytes — the class archive when connected. */
    owner: v.optional(v.union(v.literal("vault"), v.literal("uploader"))),
  },
  handler: async (
    ctx,
    { code, kind, title, mimeType, driveFileId, date, owner },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const row = await usableClass(ctx, userId, code);
    if (row === null) {
      return { ok: false, error: "You're not in this class." };
    }

    const fileId = driveFileId.trim();
    if (!fileId) return { ok: false, error: "That upload has no file." };

    // The same Drive file added twice (a double submit, another tab) is one
    // shelf item, not two.
    const existing = await ctx.db
      .query("vaultMedia")
      .withIndex("by_drive_file", (q) => q.eq("driveFileId", fileId))
      .first();
    if (existing !== null) return { ok: true, error: null };

    const cleanTitle = title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE);
    if (!cleanTitle) return { ok: false, error: "Give this file a title." };

    const me = await ctx.db.get(userId);
    await ctx.db.insert("vaultMedia", {
      code: row.code,
      kind,
      title: cleanTitle,
      mimeType: mimeType.trim() || `${kind}/*`,
      driveFileId: fileId,
      owner: owner ?? "uploader",
      uploaderId: userId,
      uploaderName: me?.name ?? me?.email ?? "dancer",
      date: cleanDate(date),
      createdAt: Date.now(),
    });
    return { ok: true, error: null };
  },
});

/** Rename a class upload: its own uploader, or staff. */
export const renameShared = mutation({
  args: { id: v.id("vaultMedia"), title: v.string() },
  handler: async (
    ctx,
    { id, title },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const row = await ctx.db.get(id);
    if (row === null) return { ok: false, error: "That file is already gone." };

    const classRow = await usableClass(ctx, userId, row.code);
    if (classRow === null) {
      return { ok: false, error: "You're not in this class." };
    }
    const access = await classAccess(ctx, userId, classRow);
    if (row.uploaderId !== userId && !access.staff) {
      return { ok: false, error: "Only the uploader can rename this file." };
    }

    const cleanTitle = title.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE);
    if (!cleanTitle) return { ok: false, error: "Give this file a title." };

    await ctx.db.patch(id, { title: cleanTitle });
    return { ok: true, error: null };
  },
});

/** The row plus what this account may do with it, for the delete action. */
export const removable = internalQuery({
  args: { id: v.id("vaultMedia"), userId: v.id("users") },
  handler: async (ctx, { id, userId }) => {
    const row = await ctx.db.get(id);
    if (row === null) return null;
    const classRow = await usableClass(ctx, userId, row.code);
    if (classRow === null) return null;
    const access = await classAccess(ctx, userId, classRow);
    if (row.uploaderId !== userId && !access.staff) {
      return null;
    }
    return row;
  },
});

export const dropRow = internalMutation({
  args: { id: v.id("vaultMedia") },
  handler: async (ctx, { id }) => {
    await ctx.db.delete(id);
  },
});

/**
 * Remove a class upload.
 *
 * The bytes are deleted from the uploader's Drive with their stored (server
 * side) tokens, so a teacher removing a student's clip doesn't leave it behind
 * in that student's Drive. An action, not a mutation, because deleting from
 * Drive is a network call.
 */
export const removeShared = action({
  args: { id: v.id("vaultMedia") },
  handler: async (
    ctx,
    { id },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const row = await ctx.runQuery(internal.vault.removable, { id, userId });
    if (row === null) {
      return {
        ok: false,
        error: "You can only remove files you uploaded.",
      };
    }

    // Best effort: if the Drive grant has expired, the shelf entry still goes
    // and the file stays in Drive rather than blocking the delete.
    try {
      await ctx.runAction(internal.drive.removeForOwner, {
        fileId: row.driveFileId,
        uploaderId: row.uploaderId,
        owner: row.owner ?? "uploader",
      });
    } catch {
      // Ignore — the row is removed below either way.
    }

    await ctx.runMutation(internal.vault.dropRow, { id });
    return { ok: true, error: null };
  },
});

/** Used by the Drive actions to find the class an upload belongs to. */
export const byDriveFile = internalQuery({
  args: { fileId: v.string() },
  handler: async (ctx, { fileId }) => {
    const row = await ctx.db
      .query("vaultMedia")
      .withIndex("by_drive_file", (q) => q.eq("driveFileId", fileId))
      .first();
    if (row === null) return null;
    return {
      code: row.code,
      uploaderId: row.uploaderId,
      owner: row.owner ?? "uploader",
    };
  },
});

/** May this account see the given class? (For the Drive playback grant.) */
export const memberFor = internalQuery({
  args: { userId: v.id("users"), code: v.string() },
  handler: async (ctx, { userId, code }) =>
    (await usableClass(ctx, userId, code)) !== null,
});
