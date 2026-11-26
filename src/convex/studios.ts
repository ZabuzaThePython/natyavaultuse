import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { deleteClassContent } from "./classContent";
import { findClass, findStudio, generateCode } from "./codes";


/**
 * Studios: the tenant above a class.
 *
 * One deployment can host several studios. A studio owns its teachers, its
 * classes and its folder in the archive Drive, and a teacher of one studio must
 * never see another's classes. Everything the app stores is keyed by a class
 * join code, and class codes are unique deployment-wide, so the studio is
 * derivable from the class; this module holds the one rule that decides who may
 * open which class, replacing the deployment-wide "sees every class" test the
 * app used while it was a single studio.
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
 * The operator account: the built-in admin, by its sign-in name or its role.
 *
 * The display name is deliberately not part of this test. It used to be, and
 * anybody could type "admin" as their full name at sign-up — which made their
 * account look like the operator and, since the studio work, would have reached
 * every studio's classes. The sign-in name is reserved at sign-up (the card and
 * the provider both refuse it), so it is the only safe signal here.
 */
export async function isPlatformAdmin(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const me = await ctx.db.get(userId);
  if (me === null) return false;
  if (me.email === ADMIN_ACCOUNT || me.role === "admin") return true;
  // The durable anchor: the built-in sign-in account itself. The row's email
  // and name can be edited (and the name is how anyone could once pretend to be
  // the operator); the provider account behind `signIn` with `admin` cannot be
  // renamed from inside the app, so the operator is recognised by it too — an
  // admin whose row is missing its mark keeps their powers after a reload
  // instead of needing to sign in again.
  const account = await ctx.db
    .query("authAccounts")
    .withIndex("providerAndAccountId", (q) =>
      q.eq("provider", "password").eq("providerAccountId", ADMIN_ACCOUNT),
    )
    .unique();
  return account !== null && account.userId === userId;
}

/** Whether a studio is suspended (or gone), which freezes everything in it. */
export async function studioIsSuspended(
  ctx: QueryCtx | MutationCtx,
  studioId: Id<"studios">,
): Promise<boolean> {
  const studio = await ctx.db.get(studioId);
  return studio === null || studio.suspendedAt !== undefined;
}

/**
 * The staff test that was in force before studios existed: the admin, an
 * account created as a teacher, or one that already owns a class.
 *
 * It is kept for exactly one window — between deploying the studio code and
 * running the backfill, when no account has a studio row yet. Without it every
 * teacher and student would be locked out of their own class on the deploy.
 * Once the backfill has run, `scopeFor` answers for every account and this is
 * never consulted.
 */
export async function legacyStaff(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  if (await isPlatformAdmin(ctx, userId)) return true;
  const me = await ctx.db.get(userId);
  if (me?.classRole === "teacher") return true;
  const ownsAClass = await ctx.db
    .query("classes")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .first();
  return ownsAClass !== null;
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
  if (scope === null) {
    // Before the backfill nobody has a studio row: fall back to the rule that
    // was in force before studios, so the deploy locks nobody out.
    //
    // Narrowly: only a class that predates studios (no `studioId`) can be
    // reached this way. A class that belongs to a studio is that studio's, and
    // an account with no studio row has no claim on it.
    if (row.studioId !== undefined) {
      return { read: false, staff: false, platform: false };
    }
    if (await legacyStaff(ctx, userId)) {
      return { read: true, staff: true, platform: false };
    }
    const joined = await ctx.db
      .query("classMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();
    return {
      read: joined !== null && joined.code === row.code,
      staff: false,
      platform: false,
    };
  }
  if (scope.kind === "platform") {
    return { read: true, staff: true, platform: true };
  }

  // A suspended studio is frozen: its staff and students lose access until the
  // operator lifts it. Only the platform admin above is unaffected.
  if (row.studioId !== undefined && (await studioIsSuspended(ctx, row.studioId))) {
    return { read: false, staff: false, platform: false };
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
 * letters and digits dropped, so "Shubha Studio of Arts" is
 * `nvshubhastudioofarts`. Fixed at creation (see the schema).
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
        suspended: studio.suspendedAt !== undefined,
      },
    };
  },
});

/**
 * Every studio, for the platform admin's picker: the operator chooses which
 * studio to look at instead of seeing every studio's classes in one list.
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
  handler: async (ctx, { name }): Promise<StudioCreation> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return {
        ok: false,
        error: "Sign in first.",
        code: null,
        id: null,
        adoptedClasses: 0,
        adoptedStudents: 0,
      };
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
          adoptedClasses: 0,
          adoptedStudents: 0,
        };
      }
      const existing = await membershipFor(ctx, userId);
      if (existing !== null) {
        return {
          ok: false,
          error: "You already belong to a studio.",
          code: null,
          id: null,
          adoptedClasses: 0,
          adoptedStudents: 0,
        };
      }
    }

    return await createStudioFor(ctx, { userId, name });
  },
});

export interface StudioCreation {
  ok: boolean;
  error: string | null;
  code: string | null;
  id: Id<"studios"> | null;
  /** Classes this teacher already ran that had no studio yet. */
  adoptedClasses: number;
  /** Students in those classes, placed in the new studio. */
  adoptedStudents: number;
}

/**
 * Create a studio owned by `userId`, and bring their existing studio with it.
 *
 * A teacher who was teaching before studios existed has classes with no
 * `studioId`; founding their studio adopts those classes and puts every student
 * in them into the studio, so nobody is left stranded outside one. Classes that
 * already belong to a studio are left alone — they are somebody else's.
 */
export async function createStudioFor(
  ctx: MutationCtx,
  { userId, name }: { userId: Id<"users">; name: string },
): Promise<StudioCreation> {
  const clean = cleanName(name);
  if (clean.length < 2) {
    return {
      ok: false,
      error: "Give the studio a name.",
      code: null,
      id: null,
      adoptedClasses: 0,
      adoptedStudents: 0,
    };
  }
  const code = await freeStudioCode(ctx);
  if (code === null) {
    return {
      ok: false,
      error: "Couldn't find a free studio code. Try again.",
      code: null,
      id: null,
      adoptedClasses: 0,
      adoptedStudents: 0,
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

  // The studio they were already running comes along.
  const owned = await ctx.db
    .query("classes")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .collect();
  let adoptedStudents = 0;
  let adoptedClasses = 0;
  for (const row of owned) {
    if (row.studioId !== undefined) continue;
    await ctx.db.patch(row._id, { studioId: id });
    adoptedClasses++;
    const members = await ctx.db
      .query("classMembers")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    for (const member of members) {
      if ((await membershipFor(ctx, member.userId)) !== null) continue;
      const account = await ctx.db.get(member.userId);
      await addStudioMember(ctx, {
        studioId: id,
        userId: member.userId,
        role: "student",
        name: account?.name ?? account?.email ?? "dancer",
      });
      adoptedStudents++;
    }
  }

  return {
    ok: true,
    error: null,
    code,
    id,
    adoptedClasses,
    adoptedStudents,
  };
}

/**
 * Put a brand-new teacher into the studio they chose at sign-up.
 *
 * The password provider cannot create the studio itself (its `profile` hook is
 * synchronous and the account does not exist yet), so it records the choice and
 * schedules this, exactly as `classes.joinOnSignUp` does for a student. If the
 * users row is not visible yet it waits and retries.
 */
export const studioOnSignUp = internalMutation({
  args: {
    username: v.string(),
    studioCode: v.optional(v.string()),
    studioName: v.optional(v.string()),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { username, studioCode, studioName, attempt }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", username.trim().toLowerCase()))
      .unique();
    if (user === null) {
      const tries = attempt ?? 0;
      if (tries >= 6) return;
      await ctx.scheduler.runAfter(
        400 * (tries + 1),
        internal.studios.studioOnSignUp,
        { username, studioCode, studioName, attempt: tries + 1 },
      );
      return;
    }
    // Already placed (a retry, or the sign-up card got there first).
    if ((await membershipFor(ctx, user._id)) !== null) return;

    if (studioCode) {
      const row = await findStudio(ctx, studioCode);
      if (row === null || row.suspendedAt !== undefined || !row.joinOpen) return;
      await addStudioMember(ctx, {
        studioId: row._id,
        userId: user._id,
        role: "teacher",
        name: user.name ?? user.email ?? "teacher",
      });
      return;
    }

    if (studioName && studioName.trim().length >= 2) {
      await createStudioFor(ctx, { userId: user._id, name: studioName });
    }
  },
});

/**
 * Whether a studio code is real, and the studio's name. The sign-up card
 * checks this before it creates a teacher's account, so a mistyped code is
 * caught while they can still fix it.
 */
export const validateCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await findStudio(ctx, code);
    if (row === null || row.suspendedAt !== undefined) {
      return { ok: false, name: null, closed: false };
    }
    // A real studio that is not accepting new teachers is a different answer
    // from a code that matches nothing, and the card says so.
    if (!row.joinOpen) return { ok: false, name: row.name, closed: true };
    return { ok: true, name: row.name, closed: false };
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

interface StudioOverview {
  ok: boolean;
  isPlatformAdmin: boolean;
  isOwner: boolean;
  studio: {
    id: Id<"studios">;
    name: string;
    code: string;
    folderName: string;
    joinOpen: boolean;
    ownerName: string;
    suspended: boolean;
  } | null;
  teachers: {
    id: Id<"users">;
    name: string;
    role: StudioRole;
    ownsClasses: boolean;
  }[];
  classes: { code: string; name: string; ownerName: string; members: number }[];
}

/** The studio a staff account manages: its own, or the operator's first one. */
async function studioForStaff(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  preferred?: Id<"studios">,
): Promise<{ studio: Doc<"studios">; platform: boolean } | null> {
  const scope = await scopeFor(ctx, userId);
  if (scope === null || scope.kind === "student") return null;
  const studioId =
    scope.kind === "platform"
      ? (preferred ?? (await ctx.db.query("studios").first())?._id)
      : scope.studioId;
  if (studioId === undefined) return null;
  const studio = await ctx.db.get(studioId);
  if (studio === null) return null;
  return { studio, platform: scope.kind === "platform" };
}

/**
 * The studio page: its name, its join code, its teachers and its classes.
 *
 * Readable by the studio's staff; a student gets `ok: false`, so a class code
 * never turns into a list of the studio's accounts.
 */
export const studioOverview = query({
  // The platform admin can look at any studio — the one picked in the shell.
  args: { studioId: v.optional(v.id("studios")) },
  handler: async (ctx, { studioId }): Promise<StudioOverview> => {
    const closed: StudioOverview = {
      ok: false,
      isPlatformAdmin: false,
      isOwner: false,
      studio: null,
      teachers: [],
      classes: [],
    };
    const userId = await getAuthUserId(ctx);
    if (userId === null) return closed;

    const found = await studioForStaff(ctx, userId, studioId);
    if (found === null) return closed;
    const { studio, platform } = found;

    const teachers = await ctx.db
      .query("studioMembers")
      .withIndex("by_studio", (q) => q.eq("studioId", studio._id))
      .collect();
    const classes = await ctx.db
      .query("classes")
      .withIndex("by_studio", (q) => q.eq("studioId", studio._id))
      .collect();
    const members = await ctx.db.query("classMembers").collect();

    const counts = new Map<string, number>();
    for (const member of members) {
      counts.set(member.code, (counts.get(member.code) ?? 0) + 1);
    }
    const owners = new Set(classes.map((row) => row.ownerId));

    return {
      ok: true,
      isPlatformAdmin: platform,
      isOwner: platform || studio.ownerId === userId,
      studio: {
        id: studio._id,
        name: studio.name,
        code: studio.code,
        folderName: studio.folderName,
        joinOpen: studio.joinOpen,
        ownerName: studio.ownerName,
        suspended: studio.suspendedAt !== undefined,
      },
      teachers: teachers
        .filter((row) => row.role !== "student")
        .map((row) => ({
          id: row.userId,
          name: row.name,
          role: row.role,
          ownsClasses: owners.has(row.userId),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      classes: classes
        .map((row) => ({
          code: row.code,
          name: row.name,
          ownerName: row.ownerName,
          members: counts.get(row.code) ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/** Add a teacher to the studio by their username. Its owner, or the admin. */
export const addTeacher = mutation({
  // The operator may look at several studios, so the one on screen is passed in.
  args: { username: v.string(), studioId: v.optional(v.id("studios")) },
  handler: async (
    ctx,
    { username, studioId },
  ): Promise<{ ok: boolean; error: string | null; name: string | null }> => {
    const me = await getAuthUserId(ctx);
    if (me === null) return { ok: false, error: "Sign in first.", name: null };

    const found = await studioForStaff(ctx, me, studioId);
    if (found === null) return { ok: false, error: "You are not in a studio.", name: null };
    const { studio, platform } = found;
    if (!platform && studio.ownerId !== me) {
      return { ok: false, error: "Only the studio's owner can add teachers.", name: null };
    }

    const handle = username.trim().toLowerCase().replace(/^@/, "");
    if (!handle) return { ok: false, error: "Type their username.", name: null };
    const account = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", handle))
      .unique();
    if (account === null) {
      return { ok: false, error: "No account has that username.", name: null };
    }

    const existing = await membershipFor(ctx, account._id);
    if (existing !== null && existing.studioId !== studio._id) {
      return {
        ok: false,
        error: "They already belong to another studio.",
        name: null,
      };
    }
    const name = account.name ?? account.email ?? "teacher";
    await addStudioMember(ctx, {
      studioId: studio._id,
      userId: account._id,
      role: existing?.role === "owner" ? "owner" : "teacher",
      name,
    });
    return { ok: true, error: null, name };
  },
});

/**
 * Take a teacher out of the studio. Its owner, or the admin.
 *
 * Refused for the owner themselves, and for anyone who still owns classes
 * here — their classes would be left in a studio they are no longer in.
 */
export const removeTeacher = mutation({
  args: { userId: v.id("users"), studioId: v.optional(v.id("studios")) },
  handler: async (
    ctx,
    { userId: targetId, studioId },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await getAuthUserId(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };

    const found = await studioForStaff(ctx, me, studioId);
    if (found === null) return { ok: false, error: "You are not in a studio." };
    const { studio, platform } = found;
    if (!platform && studio.ownerId !== me) {
      return { ok: false, error: "Only the studio's owner can remove teachers." };
    }
    if (targetId === studio.ownerId) {
      return { ok: false, error: "The studio's owner cannot be removed." };
    }

    const owned = await ctx.db
      .query("classes")
      .withIndex("by_owner", (q) => q.eq("ownerId", targetId))
      .collect();
    if (owned.some((row) => row.studioId === studio._id)) {
      return {
        ok: false,
        error: "They still own classes here — move or delete those first.",
      };
    }

    const row = await ctx.db
      .query("studioMembers")
      .withIndex("by_studio_user", (q) =>
        q.eq("studioId", studio._id).eq("userId", targetId),
      )
      .unique();
    if (row !== null) await ctx.db.delete(row._id);
    return { ok: true, error: null };
  },
});

/**
 * Suspend or resume a studio — the operator's switch.
 *
 * A suspended studio is frozen rather than deleted: its classes, attendance,
 * practice, media and class rooms stop answering (see `classAccess`), its
 * teachers lose their staff powers, and nothing is removed. Flipping it back
 * restores everything exactly as it was.
 */
export const setStudioSuspended = mutation({
  args: { studioId: v.id("studios"), suspended: v.boolean() },
  handler: async (
    ctx,
    { studioId, suspended },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await getAuthUserId(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    if (!(await isPlatformAdmin(ctx, me))) {
      return { ok: false, error: "Only the operator can suspend a studio." };
    }
    const row = await ctx.db.get(studioId);
    if (row === null) return { ok: false, error: "That studio no longer exists." };
    await ctx.db.patch(studioId, {
      suspendedAt: suspended ? Date.now() : undefined,
    });
    return { ok: true, error: null };
  },
});

/**
 * Delete a studio and everything that belongs to it — the operator's action.
 *
 * Suspending freezes a studio (see `setStudioSuspended`); this removes it for
 * good. Its classes go through the same cascade as deleting one on the Classes
 * page (classContent.ts), and the studio's own member rows go with them.
 *
 * Accounts are kept. Its teachers and students are left without a studio, so
 * nothing of the deleted studio is reachable from them; the operator can still
 * see every account under "All studios" in the admin page, and a teacher can
 * found or join a studio again.
 */
export const deleteStudio = mutation({
  args: { studioId: v.id("studios") },
  handler: async (
    ctx,
    { studioId },
  ): Promise<{
    ok: boolean;
    error: string | null;
    name: string | null;
    classes: number;
    members: number;
  }> => {
    const me = await getAuthUserId(ctx);
    if (me === null) {
      return {
        ok: false,
        error: "Sign in first.",
        name: null,
        classes: 0,
        members: 0,
      };
    }
    if (!(await isPlatformAdmin(ctx, me))) {
      return {
        ok: false,
        error: "Only the operator can delete a studio.",
        name: null,
        classes: 0,
        members: 0,
      };
    }
    const row = await ctx.db.get(studioId);
    if (row === null) {
      return {
        ok: false,
        error: "That studio no longer exists.",
        name: null,
        classes: 0,
        members: 0,
      };
    }

    const classes = await ctx.db
      .query("classes")
      .withIndex("by_studio", (q) => q.eq("studioId", studioId))
      .collect();

    for (const classroom of classes) {
      await deleteClassContent(ctx, classroom);
    }

    const seats = await ctx.db
      .query("studioMembers")
      .withIndex("by_studio", (q) => q.eq("studioId", studioId))
      .collect();
    for (const seat of seats) await ctx.db.delete(seat._id);

    await ctx.db.delete(studioId);
    return {
      ok: true,
      error: null,
      name: row.name,
      classes: classes.length,
      members: seats.length,
    };
  },
});

/** Open or close a studio to new teachers joining with its code. */
export const setJoinOpen = mutation({
  args: { studioId: v.id("studios"), open: v.boolean() },
  handler: async (
    ctx,
    { studioId, open },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await getAuthUserId(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    const found = await studioForStaff(ctx, me, studioId);
    if (found === null || found.studio._id !== studioId) {
      return { ok: false, error: "You do not manage that studio." };
    }
    if (!found.platform && found.studio.ownerId !== me) {
      return { ok: false, error: "Only the studio's owner can change this." };
    }
    await ctx.db.patch(studioId, { joinOpen: open });
    return { ok: true, error: null };
  },
});

/** Which Drive folder a class's uploads belong in, for the upload action. */
export const folderForClass = internalQuery({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await findClass(ctx, code);
    if (row === null || row.studioId === undefined) return null;
    const studio = await ctx.db.get(row.studioId);
    if (studio === null) return null;
    return {
      studioId: studio._id,
      folderName: studio.folderName,
      folderId: studio.driveFolderId ?? null,
    };
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
