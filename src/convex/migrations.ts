import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation } from "./_generated/server";
import {
  addStudioMember,
  folderNameFor,
  freeStudioCode,
  isPlatformAdmin,
  membershipFor,
} from "./studios";

/**
 * One-time (and safe to re-run) move of an existing deployment onto studios.
 *
 * Everything that existed before this feature belongs to one studio, so it all
 * lands in a single studio whose folder is the `NatyaVault` folder the archive
 * Drive already has — no file moves, no re-authorising Google.
 *
 * Run from the Admin area once the code is deployed. Rows that already carry a
 * studio are skipped, so running it twice changes nothing.
 */

/** Folder the single-studio deployment already writes into. */
const LEGACY_FOLDER = "NatyaVault";

export const studiosBackfill = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in first.", studio: null, classes: 0, teachers: 0, students: 0, unplaced: 0 };
    }
    if (!(await isPlatformAdmin(ctx, userId))) {
      return {
        ok: false,
        error: "Only the platform admin can run this.",
        studio: null,
        classes: 0,
        teachers: 0,
        students: 0,
        unplaced: 0,
      };
    }

    const users = await ctx.db.query("users").collect();
    const classes = await ctx.db.query("classes").collect();

    // 1. The default studio, created once.
    let studio = await ctx.db.query("studios").first();
    if (studio === null) {
      // The oldest teacher is the most likely owner of the studio; the admin
      // account itself is the fallback.
      const owner =
        users.find((user) => user.classRole === "teacher") ??
        users.find((user) => user._id === userId) ??
        users[0];
      if (!owner) {
        return {
          ok: false,
          error: "No accounts to place in a studio yet.",
          studio: null,
          classes: 0,
          teachers: 0,
          students: 0,
          unplaced: 0,
        };
      }
      const name = "NatyaVault";
      const taken = await ctx.db
        .query("studios")
        .withIndex("by_folder", (q) => q.eq("folderName", LEGACY_FOLDER))
        .unique();
      const id = await ctx.db.insert("studios", {
        code: (await freeStudioCode(ctx)) ?? "NATYAV",
        name,
        ownerId: owner._id,
        ownerName: owner.name ?? owner.email ?? "teacher",
        // Adopt the folder the archive already has, so its files stay put.
        folderName: taken === null ? LEGACY_FOLDER : folderNameFor(name),
        joinOpen: false,
        createdAt: Date.now(),
      });
      studio = await ctx.db.get(id);
    }
    if (studio === null) {
      return {
        ok: false,
        error: "Could not create the default studio.",
        studio: null,
        classes: 0,
        teachers: 0,
        students: 0,
        unplaced: 0,
      };
    }

    // 2. Every class joins it.
    let movedClasses = 0;
    for (const row of classes) {
      if (row.studioId !== undefined) continue;
      await ctx.db.patch(row._id, { studioId: studio._id });
      movedClasses++;
    }

    // 3. Every account gets a studio row.
    const ownedCodes = new Map<string, string>();
    for (const row of classes) ownedCodes.set(row.ownerId, row.code);

    let teachers = 0;
    let students = 0;
    let unplaced = 0;

    for (const user of users) {
      // The operator account stays outside the studios it can inspect.
      if (await isPlatformAdmin(ctx, user._id)) continue;
      if ((await membershipFor(ctx, user._id)) !== null) continue;

      const name = user.name ?? user.email ?? "dancer";
      const isTeacher = user.classRole === "teacher" || ownedCodes.has(user._id);

      if (isTeacher) {
        await addStudioMember(ctx, {
          studioId: studio._id,
          userId: user._id,
          role: user._id === studio.ownerId ? "owner" : "teacher",
          name,
        });
        teachers++;
        continue;
      }

      // A student's studio is the one their class belongs to.
      const joined = await ctx.db
        .query("classMembers")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .first();
      const classRow =
        joined === null
          ? null
          : await ctx.db
              .query("classes")
              .withIndex("by_code", (q) => q.eq("code", joined.code))
              .unique();
      const target = classRow?.studioId ?? studio._id;
      if (classRow === null) unplaced++;

      await addStudioMember(ctx, {
        studioId: target,
        userId: user._id,
        role: "student",
        name,
      });
      students++;
    }

    return {
      ok: true,
      error: null,
      studio: studio.name,
      classes: movedClasses,
      teachers,
      students,
      unplaced,
    };
  },
});

