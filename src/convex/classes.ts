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

/**
 * Classes.
 *
 * A class is created by a teacher (or the admin) and gets a six-character
 * join code. Students must enter that code when they create their account, so
 * every account belongs to exactly one class. Teachers and the admin see every
 * class in the school (`allClasses`); a student sees only the class they
 * joined with their code. All the content the app stores
 * — media, folders, practice entries, messages, and attendance — is kept per
 * class, while the Google Drive connection stays on the account and is
 * therefore shared by every class.
 *
 * Codes are uppercase alphanumerics from an alphabet without the characters
 * that are easy to misread in a classroom (0/O, 1/I/L).
 */

export const CODE_LENGTH = 6;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
/** How many times to retry when a generated code is already taken. */
const CODE_ATTEMPTS = 12;

/** Uppercase a typed code and drop anything a code can't contain. */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function randomChar(): string {
  const bytes = new Uint8Array(1);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Math.floor(Math.random() * 256);
  }
  return CODE_ALPHABET[bytes[0] % CODE_ALPHABET.length];
}

/** A fresh join code (not checked for collisions). */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += randomChar();
  return code;
}

/** The class a code points at, or null when the code is malformed/unknown. */
export async function findClass(ctx: QueryCtx | MutationCtx, rawCode: unknown) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  return await ctx.db
    .query("classes")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}

/**
 * Whether a code is valid, and the class name it belongs to. The sign-up card
 * checks this before it creates an account, so a student cannot sign up
 * without a real class code.
 */
export const validateCode = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const row = await findClass(ctx, code);
    return row ? { ok: true, name: row.name } : { ok: false, name: null };
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
    return {
      owned: owned
        .map((row) => ({ code: row.code, name: row.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      joined: member ? { code: member.code, name: member.className } : null,
    };
  },
});

/**
 * The built-in admin account (see convex/admin.ts). It signs in as a normal
 * password account named `admin`, so that is how the server recognises it.
 */
const ADMIN_ACCOUNT = "admin";

/**
 * Whether the account may see — and open — every class in the school: the
 * built-in admin, an account created as a teacher, or one that already owns a
 * class (teachers from before `classRole` existed). Teachers are staff, so
 * this is also what keeps them off the attendance sheet.
 */
export async function maySeeEveryClass(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<boolean> {
  const me = await ctx.db.get(userId);
  if (
    me !== null &&
    (me.email === ADMIN_ACCOUNT ||
      me.role === "admin" ||
      me.name?.trim().toLowerCase() === ADMIN_ACCOUNT)
  ) {
    return true;
  }
  if (me?.classRole === "teacher") return true;
  const ownsAClass = await ctx.db
    .query("classes")
    .withIndex("by_owner", (q) => q.eq("ownerId", userId))
    .first();
  return ownsAClass !== null;
}

/** Whether this account has joined the class with that code. */
async function joinedClass(
  ctx: QueryCtx,
  userId: Id<"users">,
  code: string,
): Promise<boolean> {
  const member = await ctx.db
    .query("classMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  return member !== null && member.code === code;
}

/**
 * Every class in the school, for teachers and the admin.
 *
 * Anyone who is not staff — students among them — gets `canSeeAll: false` and
 * no rows, so a class code is never handed out by this query.
 */
export const allClasses = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { canSeeAll: false, classes: [] };

    const canSeeAll = await maySeeEveryClass(ctx, userId);
    if (!canSeeAll) return { canSeeAll: false, classes: [] };

    const me = await ctx.db.get(userId);
    // Who may delete a class: the teacher who created it, or the admin (who
    // can clean up any class in the school). A teacher who merely sees a
    // colleague's class must not be able to remove it.
    const isAdminAccount =
      me !== null && (me.email === ADMIN_ACCOUNT || me.role === "admin");

    const rows = await ctx.db.query("classes").collect();
    // One pass over the membership table instead of a read per class.
    const members = await ctx.db.query("classMembers").collect();
    const counts = new Map<string, number>();
    for (const member of members) {
      counts.set(member.code, (counts.get(member.code) ?? 0) + 1);
    }

    return {
      canSeeAll: true,
      classes: rows
        .map((row) => ({
          code: row.code,
          name: row.name,
          ownerName: row.ownerName,
          members: counts.get(row.code) ?? 0,
          isMine: row.ownerId === userId,
          canDelete: row.ownerId === userId || isAdminAccount,
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
  args: {},
  handler: async (ctx): Promise<{ signedIn: boolean; isStaff: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { signedIn: false, isStaff: false };
    return { signedIn: true, isStaff: await maySeeEveryClass(ctx, userId) };
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
    if (member.userId === row.ownerId || account?.classRole === "teacher") {
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
    const viewerIsStaff =
      row.ownerId === userId || (await maySeeEveryClass(ctx, userId));
    const allowed = viewerIsStaff || (await joinedClass(ctx, userId, row.code));
    if (!allowed) return closed;

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
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return { ok: false, error: "Sign in before creating a class.", code: null, name: null };
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
 * every class in the school, so seeing one must not mean being able to wipe
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

    const me = await ctx.db.get(userId);
    const isAdminAccount =
      me !== null && (me.email === ADMIN_ACCOUNT || me.role === "admin");
    if (row.ownerId !== userId && !isAdminAccount) {
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
