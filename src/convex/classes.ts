import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findClass, generateCode } from "./codes";
import {
  addStudioMember,
  classAccess,
  legacyStaff,
  membershipFor,
  scopeFor,
  studioIsSuspended,
  studioRoleIn,
} from "./studios";

// The join-code helpers moved to codes.ts (studios.ts needs them too) and are
// re-exported here, so every `from "./classes"` import keeps working.
export { CODE_LENGTH, findClass, generateCode, normalizeCode } from "./codes";

/**
 * Classes.
 *
 * A class is created by a teacher (or the admin) and gets a six-character
 * join code. Students must enter that code when they create their account, so
 * every account belongs to exactly one class. Teachers and the admin see every
 * class in the studio (`allClasses`); a student sees only the class they
 * joined with their code. All the content the app stores
 * — media, folders, practice entries, messages, and attendance — is kept per
 * class, while the Google Drive connection stays on the account and is
 * therefore shared by every class.
 *
 * Codes are uppercase alphanumerics from an alphabet without the characters
 * that are easy to misread in a classroom (0/O, 1/I/L).
 */

/** How many times to retry when a generated class code is already taken. */
const CODE_ATTEMPTS = 12;

/**
 * Whether a code is valid, and the class name it belongs to. The sign-up card
 * checks this before it creates an account, so a student cannot sign up
 * without a real class code.
 */
export const validateCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await findClass(ctx, code);
    if (!row) return { ok: false, name: null, studioName: null };
    // The sign-up card can say which studio the code belongs to, so a student
    // knows they are joining the right class.
    const studio = row.studioId === undefined ? null : await ctx.db.get(row.studioId);
    return { ok: true, name: row.name, studioName: studio?.name ?? null };
  },
});

/**
 * The classes the signed-in account can open: the ones it created (a teacher
 * may run several classes) and, for a student, the one it joined with a code.
 */
export const myClasses = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { owned: [] as { code: string; name: string }[], joined: null };
    }
    const owned = await ctx.db
      .query("classes")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    const member = await ctx.db
      .query("classMembers")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first();

    // A suspended studio is frozen, so its classes are not offered in the
    // switcher — the list must not hold a class that then refuses to open.
    const frozen = new Map<Id<"studios">, boolean>();
    const isFrozen = async (studioId: Id<"studios"> | undefined) => {
      if (studioId === undefined) return false;
      const known = frozen.get(studioId);
      if (known !== undefined) return known;
      const value = await studioIsSuspended(ctx, studioId);
      frozen.set(studioId, value);
      return value;
    };

    const visible: { code: string; name: string }[] = [];
    for (const row of owned) {
      if (await isFrozen(row.studioId)) continue;
      visible.push({ code: row.code, name: row.name });
    }

    let joined: { code: string; name: string } | null = member
      ? { code: member.code, name: member.className }
      : null;
    if (joined !== null) {
      const row = await findClass(ctx, joined.code);
      if (row !== null && (await isFrozen(row.studioId))) joined = null;
    }

    return {
      owned: visible.sort((a, b) => a.name.localeCompare(b.name)),
      joined,
    };
  },
});

/**
 * "Who may open which class" now lives in convex/studios.ts (`classAccess`):
 * the platform admin, the staff of that class's studio, and the students who
 * joined it. It used to be a deployment-wide "sees every class" test, which is
 * exactly what a second studio breaks.
 */

/**
 * Every class in the studio, for teachers and the admin.
 *
 * Anyone who is not staff — students among them — gets `canSeeAll: false` and
 * no rows, so a class code is never handed out by this query.
 */
export const allClasses = query({
  // The platform admin picks which studio to look at; a teacher's own studio is
  // implied and cannot be widened by passing another studio's id.
  args: { studioId: v.optional(v.id("studios")) },
  handler: async (ctx, { studioId }) => {
    const closed = {
      canSeeAll: false,
      classes: [      ] as {
        code: string;
        name: string;
        ownerName: string;
        members: number;
        isMine: boolean;
        canDelete: boolean;
      }[],
      studio: null as {
        id: Id<"studios">;
        name: string;
        suspended: boolean;
      } | null,
    };
    const userId = await getAuthUserId(ctx);
    if (userId === null) return closed;

    const scope = await scopeFor(ctx, userId);
    // Before the backfill no account has a studio row: the pre-studios staff
    // test keeps a teacher looking at their classes instead of an empty list.
    const legacy = scope === null ? await legacyStaff(ctx, userId) : false;
    if (scope === null ? !legacy : scope.kind === "student") return closed;

    const platform = scope?.kind === "platform";
    // The legacy fallback only reaches classes that predate studios, so the list
    // matches exactly what those accounts are allowed to open.
    const target =
      scope?.kind === "platform"
        ? studioId
        : scope?.kind === "studio"
          ? scope.studioId
          : undefined;
    const studio = target === undefined ? null : await ctx.db.get(target);
    // A suspended studio is frozen for its own people; the operator may still
    // look at it, which is how they check what they suspended.
    if (studio !== null && studio.suspendedAt !== undefined && !platform) {
      return closed;
    }

    // No studio picked by the operator: every studio's classes, which is what
    // this list showed before studios existed.
    const found =
      target === undefined
        ? await ctx.db.query("classes").collect()
        : await ctx.db
            .query("classes")
            .withIndex("by_studio", (q) => q.eq("studioId", target))
            .collect();
    const rows =
      scope === null ? found.filter((row) => row.studioId === undefined) : found;
    // One pass over the membership table instead of a read per class.
    const members = await ctx.db.query("classMembers").collect();
    const counts = new Map<string, number>();
    for (const member of members) {
      counts.set(member.code, (counts.get(member.code) ?? 0) + 1);
    }

    return {
      canSeeAll: true,
      studio:
        studio === null
          ? null
          : {
              id: studio._id,
              name: studio.name,
              suspended: studio.suspendedAt !== undefined,
            },
      classes: rows
        .map((row) => ({
          code: row.code,
          name: row.name,
          ownerName: row.ownerName,
          members: counts.get(row.code) ?? 0,
          isMine: row.ownerId === userId,
          // Only the teacher who created it, or the platform admin: seeing a
          // colleague's class must not mean being able to wipe it.
          canDelete: row.ownerId === userId || platform,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/**
 * Whether the signed-in account is staff: a teacher, the admin, or the owner
 * of a class — the deployment's own answer, using the same rule the class
 * queries and mutations enforce.
 *
 * The app needs this because the role a browser stores belongs to whoever
 * signed up on that device last: a student on a machine a teacher used would
 * otherwise be shown the teacher's view (and the teacher's permissions) on
 * every page, not just the attendance sheet.
 */
export const viewerRole = query({
  // `retry` is a cache-buster, not a fact: the client bumps it when this
  // subscription has gone quiet (a deploy mid-flight, a dropped socket) so the
  // shell asks again instead of signing the admin out of their own controls.
  args: { retry: v.optional(v.number()) },
  handler: async (ctx): Promise<{
    signedIn: boolean;
    isStaff: boolean;
    isPlatformAdmin: boolean;
    studio: { id: Id<"studios">; name: string; code: string } | null;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { signedIn: false, isStaff: false, isPlatformAdmin: false, studio: null };
    }
    const scope = await scopeFor(ctx, userId);
    if (scope === null) {
      // No studio row yet (pre-backfill): answer the way this did before
      // studios, so a teacher is not shown the student view for a deploy.
      return {
        signedIn: true,
        isStaff: await legacyStaff(ctx, userId),
        isPlatformAdmin: false,
        studio: null,
      };
    }
    if (scope.kind === "platform") {
      return { signedIn: true, isStaff: true, isPlatformAdmin: true, studio: null };
    }
    const studio = await ctx.db.get(scope.studioId);
    return {
      signedIn: true,
      isStaff: scope.kind === "studio",
      isPlatformAdmin: false,
      // A student gets the studio's name but not its join code: that code is
      // for teachers.
      studio:
        studio === null
          ? null
          : {
              id: studio._id,
              name: studio.name,
              code: scope.kind === "studio" ? studio.code : "",
            },
    };
  },
});

/**
 * Split a class's members into the students on its attendance sheet and the
 * staff that must never appear on it: the class's owner (staff even without a
 * membership row) and any teacher account that joined with a code.
 */
export async function sheetPeople(
  ctx: QueryCtx | MutationCtx,
  row: Doc<"classes">,
  members: Doc<"classMembers">[],
): Promise<{ students: string[]; teachers: string[] }> {
  const students: string[] = [];
  const teachers: string[] = [row.ownerName];
  for (const member of members) {
    const account = await ctx.db.get(member.userId);
    const name = account?.name ?? account?.email;
    if (!name) continue;
    // Staff of this studio stay off the roll. A class from before studios has
    // no studio to ask, so it falls back to the account's sign-up choice.
    const studioRole = await studioRoleIn(ctx, member.userId, row.studioId);
    const isTeacher =
      studioRole !== null
        ? studioRole !== "student"
        : account?.classRole === "teacher";
    if (member.userId === row.ownerId || isTeacher) {
      teachers.push(name);
      continue;
    }
    students.push(name);
  }
  return { students: uniqueNames(students), teachers: uniqueNames(teachers) };
}

/**
 * Case-insensitive de-duplication that drops blank names.
 */
function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Who is on a class's attendance sheet.
 *
 * `students` is every account that joined the class with its code, so the
 * whole class shows up for the teacher and for each student no matter which
 * device they are on; `added` is the extra names a teacher entered by hand.
 * `teachers` is the class's owner plus any teacher account that joined it —
 * the sheet exists for students, and a teacher is never listed and never
 * markable.
 *
 * Readable by the class's owner, by the teachers/admin who can open every
 * class, and by the students who joined it.
 */
export const classSheet = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const closed = {
      ok: false,
      ownerName: null as string | null,
      students: [] as string[],
      teachers: [] as string[],
      added: [] as string[],
      viewerIsStaff: false,
    };
    const userId = await getAuthUserId(ctx);
    if (userId === null) return closed;
    const row = await findClass(ctx, code);
    if (row === null) return closed;

    // Staff status is decided here, per account, and handed to the client: the
    // role the browser stored belongs to whoever signed in on that device last,
    // so a student on a machine a teacher used would otherwise be treated as
    // the teacher and locked out of their own row.
    const access = await classAccess(ctx, userId, row);
    const viewerIsStaff = access.staff || row.ownerId === userId;
    if (!access.read) return closed;

    const members = await ctx.db
      .query("classMembers")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    const { students, teachers } = await sheetPeople(ctx, row, members);
    // Names the teacher added by hand, for students without an account yet.
    const extra = await ctx.db
      .query("classStudents")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();

    return {
      ok: true,
      ownerName: row.ownerName,
      students,
      teachers,
      added: uniqueNames(extra.map((student) => student.name)),
      viewerIsStaff,
    };
  },
});

/**
 * Create a class and get its join code. Any signed-in teacher can do this;
 * the new class is theirs (they don't need to join it).
 */
export const createClass = mutation({
  args: { name: v.string(), studioId: v.optional(v.id("studios")) },
  handler: async (ctx, { name, studioId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in before creating a class.", code: null, name: null };
    }
    // A class belongs to a studio: the caller's own, or the one the platform
    // admin is looking at. A student never creates one.
    const scope = await scopeFor(ctx, userId);
    if (scope === null) {
      // Pre-backfill a teacher may still create a class; the backfill puts it
      // into the default studio along with everything else.
      if (!(await legacyStaff(ctx, userId))) {
        return { ok: false, error: "Only a teacher can create a class.", code: null, name: null };
      }
    } else if (scope.kind === "student") {
      return { ok: false, error: "Only a teacher can create a class.", code: null, name: null };
    }
    const studio =
      scope === null
        ? undefined
        : scope.kind === "platform"
          ? (studioId ?? (await ctx.db.query("studios").first())?._id)
          : scope.studioId;
    if (scope !== null && studio === undefined) {
      return {
        ok: false,
        error: "Create a studio first — a class belongs to one.",
        code: null,
        name: null,
      };
    }
    const trimmed = name.trim().slice(0, 60) || "New class";

    let code = "";
    for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
      const candidate = generateCode();
      const clash = await ctx.db
        .query("classes")
        .withIndex("by_code", (q) => q.eq("code", candidate))
        .unique();
      if (clash === null) {
        code = candidate;
        break;
      }
    }
    if (code === "") {
      return {
        ok: false,
        error: "Couldn't find a free class code. Try again.",
        code: null,
        name: null,
      };
    }

    const user = await ctx.db.get(userId);
    await ctx.db.insert("classes", {
      code,
      name: trimmed,
      ownerId: userId,
      ownerName: user?.name ?? user?.email ?? "teacher",
      studioId: studio,
      createdAt: Date.now(),
    });
    return { ok: true, code, name: trimmed };
  },
});

/**
 * Delete a class and everything that hangs off its join code: who belongs to
 * it, the names the teacher added to its sheet, its attendance marks, and its
 * chat room with its messages and files. The code stops working for sign-up
 * and for joining straight away.
 *
 * Only the class's owner or the admin may delete it — every teacher can see
 * every class in the studio, so seeing one must not mean being able to wipe
 * it. Returns the name so the caller can say what went.
 */
export const deleteClass = mutation({
  args: { code: v.string() },
  handler: async (
    ctx,
    { code },
  ): Promise<{ ok: boolean; error: string | null; name: string | null }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in first.", name: null };
    }
    const row = await findClass(ctx, code);
    if (row === null) {
      return { ok: false, error: "That class no longer exists.", name: null };
    }

    // Staff of the studio is not enough: a colleague who merely sees a class
    // must not be able to wipe it. Its owner, or the platform admin.
    const access = await classAccess(ctx, userId, row);
    if (row.ownerId !== userId && !access.platform) {
      return {
        ok: false,
        error: "Only the class's owner or the admin can delete it.",
        name: null,
      };
    }

    // The class's room goes with it: its messages (and any files on them),
    // seats, read markers, and call rows.
    const rooms = await ctx.db
      .query("chats")
      .withIndex("by_class", (q) => q.eq("classCode", row.code))
      .collect();
    for (const room of rooms) {
      const messages = await ctx.db
        .query("chatMessages")
        .withIndex("by_chat_time", (q) => q.eq("chatId", room._id))
        .collect();
      for (const message of messages) {
        if (message.attachment) {
          await ctx.storage.delete(message.attachment.storageId);
        }
        await ctx.db.delete(message._id);
      }

      const seats = await ctx.db
        .query("chatMembers")
        .withIndex("by_chat", (q) => q.eq("chatId", room._id))
        .collect();
      for (const seat of seats) await ctx.db.delete(seat._id);

      const reads = await ctx.db
        .query("chatReads")
        .withIndex("by_chat_user", (q) => q.eq("chatId", room._id))
        .collect();
      for (const read of reads) await ctx.db.delete(read._id);

      const calls = await ctx.db
        .query("calls")
        .withIndex("by_chat_started", (q) => q.eq("chatId", room._id))
        .collect();
      for (const call of calls) await ctx.db.delete(call._id);

      await ctx.db.delete(room._id);
    }

    const members = await ctx.db
      .query("classMembers")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    for (const member of members) await ctx.db.delete(member._id);

    const added = await ctx.db
      .query("classStudents")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    for (const student of added) await ctx.db.delete(student._id);

    const marks = await ctx.db
      .query("attendanceMarks")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    for (const mark of marks) await ctx.db.delete(mark._id);

    await ctx.db.delete(row._id);
    return { ok: true, error: null, name: row.name };
  },
});

/**
 * Record that an account belongs to a class. One membership per account: an
 * existing row moves to the new class rather than piling up.
 */
async function recordMembership(
  ctx: MutationCtx,
  userId: Id<"users">,
  row: Doc<"classes">,
) {
  // The class names the studio, so belonging to the class also puts the
  // account in that studio (the studio is what scopes everything else). A
  // teacher already in a studio keeps it; a student moves with their class.
  if (row.studioId !== undefined) {
    const me = await ctx.db.get(userId);
    const who = me?.name ?? me?.email ?? "dancer";
    const studio = await membershipFor(ctx, userId);
    if (studio === null) {
      await addStudioMember(ctx, {
        studioId: row.studioId,
        userId,
        role: "student",
        name: who,
      });
    } else if (studio.role === "student" && studio.studioId !== row.studioId) {
      await ctx.db.patch(studio._id, {
        studioId: row.studioId,
        name: who,
        joinedAt: Date.now(),
      });
    }
  }

  const existing = await ctx.db
    .query("classMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (existing === null) {
    await ctx.db.insert("classMembers", {
      userId,
      code: row.code,
      className: row.name,
      joinedAt: Date.now(),
    });
    return;
  }
  if (existing.code !== row.code) {
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      code: row.code,
      className: row.name,
      joinedAt: now,
    });
    // The room of the class they are leaving stays in their chat list as
    // history: mark when they left it, so it stops showing new messages
    // (convex/chats.ts chatAccess).
    const room = await ctx.db
      .query("chats")
      .withIndex("by_class", (q) => q.eq("classCode", existing.code))
      .first();
    if (room !== null) {
      const seat = await ctx.db
        .query("chatMembers")
        .withIndex("by_chat_user", (q) =>
          q.eq("chatId", room._id).eq("userId", userId),
        )
        .unique();
      if (seat !== null && seat.leftAt === undefined) {
        await ctx.db.patch(seat._id, { leftAt: now });
      }
    }
  }
}

/** How many times the sign-up join re-checks for the new account. */
const SIGN_UP_JOIN_ATTEMPTS = 6;

/**
 * Put a brand-new student into the class they signed up with, from the server.
 *
 * The sign-up card cannot do this reliably: its own `joinClass` call can reach
 * Convex before the fresh session token does, in which case the mutation has no
 * idea who is asking. This is scheduled by the password provider at account
 * creation (see convex/auth/password.ts), so it runs with the account already
 * committed — and if the users row is not visible yet it waits and retries.
 *
 * Scheduled work is why a student never has to type the code in again.
 */
export const joinOnSignUp = internalMutation({
  args: {
    username: v.string(),
    classCode: v.string(),
    attempt: v.optional(v.number()),
  },
  handler: async (ctx, { username, classCode, attempt }) => {
    const row = await findClass(ctx, classCode);
    // A malformed or unknown code simply has nothing to join.
    if (row === null) return;

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", username.trim().toLowerCase()))
      .unique();
    if (user === null) {
      const tries = attempt ?? 0;
      if (tries >= SIGN_UP_JOIN_ATTEMPTS) return;
      await ctx.scheduler.runAfter(
        400 * (tries + 1),
        internal.classes.joinOnSignUp,
        { username, classCode, attempt: tries + 1 },
      );
      return;
    }

    await recordMembership(ctx, user._id, row);
  },
});

/**
 * Join a class with its code: a student who is moving to another class, and a
 * second attempt right after sign-up (the server-side `joinOnSignUp` is what
 * makes it stick). A student belongs to one class at a time.
 */
export const joinClass = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in first.", code: null, name: null };
    }
    const row = await findClass(ctx, code);
    if (row === null) {
      return {
        ok: false,
        error: "That class code doesn't match any class. Check it with your teacher.",
        code: null,
        name: null,
      };
    }
    await recordMembership(ctx, userId, row);
    return { ok: true, code: row.code, name: row.name };
  },
});
