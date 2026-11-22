import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findStudio, generateCode } from "./codes";

/**
 * Studios: the tenant above a class.
 *
 * One deployment can host several schools. A studio owns its teachers, its
 * classes and its folder in the archive Drive, and a teacher of one studio must
 * never see another's classes. Everything the app stores is keyed by a class
 * join code, and class codes are unique deployment-wide, so the studio is
 * derivable from the class; this module holds the one rule that decides who may
 * open which class, replacing the deployment-wide "sees every class" test the
 * app used while it was a single school.
 *
 * The platform admin (the built-in `admin` account) is the one account that
 * crosses studios — that is what makes it the operator.
 *
 * This file deliberately imports nothing from `classes.ts` (which imports it),
 * so the shared code helpers live in `codes.ts`.
 */

/** The built-in admin account (see convex/admin.ts). */
const ADMIN_ACCOUNT = "admin";
const NAME_MAX = 60;
const CODE_ATTEMPTS = 12;

export type StudioRole = "owner" | "teacher" | "student";

/** What a signed-in account may reach. */
export type Scope =
  | { kind: "platform"; isPlatformAdmin: true }
  | { kind: "studio"; studioId: Id<"studios">; role: "owner" | "teacher" }
  | { kind: "student"; studioId: Id<"studios"> };

/**
 * The operator account: the built-in admin, by its account name or its role.
 * Same test as convex/admin.ts, kept here so the studio layer needs no import
 * from the admin module (which imports this one).
 */
export async function isPlatformAdmin(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const me = await ctx.db.get(userId);
  if (me === null) return false;
  return (
    me.email === ADMIN_ACCOUNT ||
    me.role === "admin" ||
    me.name?.trim().toLowerCase() === ADMIN_ACCOUNT
  );
}

/** The account's studio row, if it has one. One row per account for now. */
export async function membershipFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"studioMembers"> | null> {
  return await ctx.db
    .query("studioMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
}

/** This account's role in one studio, or null when it isn't a member. */
export async function studioRoleIn(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  studioId: Id<"studios"> | undefined,
): Promise<StudioRole | null> {
  if (studioId === undefined) return null;
  const row = await ctx.db
    .query("studioMembers")
    .withIndex("by_studio_user", (q) =>
      q.eq("studioId", studioId).eq("userId", userId),
    )
    .unique();
  return row?.role ?? null;
}

/** What this account may reach: the platform, a studio's staff, or a student. */
export async function scopeFor(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<Scope | null> {
  if (await isPlatformAdmin(ctx, userId)) {
    return { kind: "platform", isPlatformAdmin: true };
  }
  const member = await membershipFor(ctx, userId);
  if (member === null) return null;
  if (member.role === "student") {
    return { kind: "student", studioId: member.studioId };
  }
  return { kind: "studio", studioId: member.studioId, role: member.role };
}

/**
 * The one class-access rule.
 *
 * `staff` means the account manages the class: the platform admin, or a
 * teacher/owner **of the class's own studio**. `read` also covers the students
 * who joined the class with its code and belong to that studio.
 *
 * A class created before studios existed has no `studioId`; it keeps behaving
 * the way it did (any staff account may open it) until the backfill assigns one,
 * so the deployment stays usable between the code deploy and the backfill.
 */
export async function classAccess(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  row: Doc<"classes">,
): Promise<{ read: boolean; staff: boolean; platform: boolean }> {
  const scope = await scopeFor(ctx, userId);
  if (scope === null) return { read: false, staff: false, platform: false };
  if (scope.kind === "platform") {
    return { read: true, staff: true, platform: true };
  }

  const sameStudio =
    row.studioId === undefined || row.studioId === scope.studioId;
  if (scope.kind === "studio" && sameStudio) {
    return { read: true, staff: true, platform: false };
  }

  const membership = await ctx.db
    .query("classMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  const read = membership !== null && membership.code === row.code && sameStudio;
  return { read, staff: false, platform: false };
}

/** Every account that belongs to a studio: its members and its class owners. */
export async function studioMemberIds(
  ctx: QueryCtx | MutationCtx,
  studioId: Id<"studios">,
): Promise<Set<Id<"users">>> {
  const ids = new Set<Id<"users">>();
  const members = await ctx.db
    .query("studioMembers")
    .withIndex("by_studio", (q) => q.eq("studioId", studioId))
    .collect();
  for (const member of members) ids.add(member.userId);
  const classes = await ctx.db
    .query("classes")
    .withIndex("by_studio", (q) => q.eq("studioId", studioId))
    .collect();
  for (const row of classes) ids.add(row.ownerId);
  return ids;
}

/**
 * A studio's folder in the archive Drive: `nv` + its name with everything but
 * letters and digits dropped, so "Shubha School of Arts" is
 * `nvshubhaschoolofarts`. Fixed at creation (see the schema).
 */
export function folderNameFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, NAME_MAX);
  return `nv${slug || "studio"}`;
}

/** Tidy a typed studio name. */
function cleanName(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, NAME_MAX);
}

/** A studio code that no studio is using yet. */
export async function freeStudioCode(
  ctx: MutationCtx,
): Promise<string | null> {
  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const candidate = generateCode();
    const clash = await ctx.db
      .query("studios")
      .withIndex("by_code", (q) => q.eq("code", candidate))
      .unique();
    if (clash === null) return candidate;
  }
  return null;
}

async function uniqueFolderName(
  ctx: MutationCtx,
  base: string,
): Promise<string> {
  let candidate = base;
  for (let suffix = 2; suffix < 100; suffix++) {
    const clash = await ctx.db
      .query("studios")
      .withIndex("by_folder", (q) => q.eq("folderName", candidate))
      .unique();
    if (clash === null) return candidate;
    candidate = `${base}-${suffix}`;
  }
  return `${base}-${Date.now()}`;
}

/** Add an account to a studio (or update the role it already has). */
export async function addStudioMember(
  ctx: MutationCtx,
  args: {
    studioId: Id<"studios">;
    userId: Id<"users">;
    role: StudioRole;
    name: string;
  },
): Promise<void> {
  const existing = await ctx.db
    .query("studioMembers")
    .withIndex("by_studio_user", (q) =>
      q.eq("studioId", args.studioId).eq("userId", args.userId),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("studioMembers", {
      studioId: args.studioId,
      userId: args.userId,
      role: args.role,
      name: args.name,
      joinedAt: Date.now(),
    });
    return;
  }
  if (existing.role !== args.role) {
    await ctx.db.patch(existing._id, { role: args.role });
  }
}

/** The studio this account belongs to, for the shell and the studio page. */
export const myStudio = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { signedIn: false, isPlatformAdmin: false, studio: null };
    }
    const platform = await isPlatformAdmin(ctx, userId);
    const member = await membershipFor(ctx, userId);
    if (member === null) {
      return { signedIn: true, isPlatformAdmin: platform, studio: null };
    }
    const studio = await ctx.db.get(member.studioId);
    if (studio === null) {
      return { signedIn: true, isPlatformAdmin: platform, studio: null };
    }
    return {
      signedIn: true,
      isPlatformAdmin: platform,
      studio: {
        id: studio._id,
        name: studio.name,
        code: studio.code,
        role: member.role,
        folderName: studio.folderName,
      },
    };
  },
});

/**
 * Every studio, for the platform admin's picker: the operator chooses which
 * school to look at instead of seeing every school's classes in one list.
 */
export const listStudios = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, studios: [] as never[] };
    if (!(await isPlatformAdmin(ctx, userId))) {
      return { ok: false, studios: [] as never[] };
    }

    const rows = await ctx.db.query("studios").collect();
    const members = await ctx.db.query("studioMembers").collect();
    const classes = await ctx.db.query("classes").collect();

    const people = new Map<Id<"studios">, number>();
    for (const member of members) {
      if (member.role === "owner") continue;
      people.set(member.studioId, (people.get(member.studioId) ?? 0) + 1);
    }
    const classCount = new Map<Id<"studios">, number>();
    for (const row of classes) {
      if (row.studioId === undefined) continue;
      classCount.set(row.studioId, (classCount.get(row.studioId) ?? 0) + 1);
    }

    return {
      ok: true,
      studios: rows
        .map((row) => ({
          id: row._id,
          name: row.name,
          code: row.code,
          folderName: row.folderName,
          ownerName: row.ownerName,
          members: people.get(row._id) ?? 0,
          classes: classCount.get(row._id) ?? 0,
          suspended: row.suspendedAt !== undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/**
 * Create a studio. The platform admin may create one anywhere; a teacher
 * account creates its own, which it then owns. A student never may.
 */
export const createStudio = mutation({
  args: { name: v.string() },
  handler: async (
    ctx,
    { name },
  ): Promise<{ ok: boolean; error: string | null; code: string | null; id: Id<"studios"> | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in first.", code: null, id: null };
    }
    const platform = await isPlatformAdmin(ctx, userId);
    if (!platform) {
      const me = await ctx.db.get(userId);
      if (me?.classRole !== "teacher") {
        return {
          ok: false,
          error: "Only a teacher can start a studio.",
          code: null,
          id: null,
        };
      }
      const existing = await membershipFor(ctx, userId);
      if (existing !== null) {
        return {
          ok: false,
          error: "You already belong to a studio.",
          code: null,
          id: null,
        };
      }
    }

    const clean = cleanName(name);
    if (clean.length < 2) {
      return { ok: false, error: "Give the studio a name.", code: null, id: null };
    }
    const code = await freeStudioCode(ctx);
    if (code === null) {
      return {
        ok: false,
        error: "Couldn't find a free studio code. Try again.",
        code: null,
        id: null,
      };
    }
    const folderName = await uniqueFolderName(ctx, folderNameFor(clean));
    const me = await ctx.db.get(userId);
    const ownerName = me?.name ?? me?.email ?? "teacher";

    const id = await ctx.db.insert("studios", {
      code,
      name: clean,
      ownerId: userId,
      ownerName,
      folderName,
      joinOpen: true,
      createdAt: Date.now(),
    });
    await addStudioMember(ctx, {
      studioId: id,
      userId,
      role: "owner",
      name: ownerName,
    });
    return { ok: true, error: null, code, id };
  },
});

/** Join an existing studio with its code — a teacher joining a colleague's. */
export const joinStudio = mutation({
  args: { code: v.string() },
  handler: async (
    ctx,
    { code },
  ): Promise<{ ok: boolean; error: string | null; name: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in first.", name: null };
    }
    const row = await findStudio(ctx, code);
    if (row === null) {
      return {
        ok: false,
        error: "That studio code doesn't match any studio.",
        name: null,
      };
    }
    if (row.suspendedAt !== undefined) {
      return { ok: false, error: "That studio is not open.", name: null };
    }
    if (!row.joinOpen) {
      return {
        ok: false,
        error: "That studio is not accepting new teachers.",
        name: null,
      };
    }
    const existing = await membershipFor(ctx, userId);
    if (existing !== null && existing.studioId !== row._id) {
      return {
        ok: false,
        error: "You already belong to another studio.",
        name: null,
      };
    }
    const me = await ctx.db.get(userId);
    if (me?.classRole === "student") {
      return {
        ok: false,
        error: "A student account joins with a class code, not a studio code.",
        name: null,
      };
    }
    await addStudioMember(ctx, {
      studioId: row._id,
      userId,
      role: "teacher",
      name: me?.name ?? me?.email ?? "teacher",
    });
    return { ok: true, error: null, name: row.name };
  },
});

/** Rename a studio: its owner, or the platform admin. The folder stays. */
export const renameStudio = mutation({
  args: { studioId: v.id("studios"), name: v.string() },
  handler: async (
    ctx,
    { studioId, name },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, error: "Sign in first." };

    const row = await ctx.db.get(studioId);
    if (row === null) return { ok: false, error: "That studio is gone." };

    const platform = await isPlatformAdmin(ctx, userId);
    if (!platform && row.ownerId !== userId) {
      return { ok: false, error: "Only the studio's owner can rename it." };
    }
    const clean = cleanName(name);
    if (clean.length < 2) return { ok: false, error: "Give the studio a name." };

    await ctx.db.patch(studioId, { name: clean });
    return { ok: true, error: null };
  },
});

/** Record the Drive folder a studio's uploads go into (first write wins). */
export const setFolderId = internalMutation({
  args: { studioId: v.id("studios"), folderId: v.string() },
  handler: async (ctx, { studioId, folderId }) => {
    const row = await ctx.db.get(studioId);
    if (row === null || row.driveFolderId !== undefined) return;
    await ctx.db.patch(studioId, { driveFolderId: folderId });
  },
});
