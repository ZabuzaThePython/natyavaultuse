import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findClass, sheetPeople } from "./classes";
import { classAccess } from "./studios";

/**
 * Attendance, per class, on the deployment.
 *
 * Marks used to live in each browser, which meant a teacher's roll and a
 * student's "not attending" note never met. They are rows here now, keyed by
 * the class's join code, so everyone in a class reads the same sheet on every
 * device.
 *
 * Who may do what:
 *  - the class's owner, any other teacher, and the admin (collectively "staff")
 *    may mark and unmark anyone on the sheet, and add or remove names;
 *  - a student in the class may mark and unmark any classmate, including
 *    themselves — classmates can keep the roll while the teacher isn't holding
 *    it. The one thing a student may never record is an `absent`: that stays
 *    the teacher's call, and a student can only say they won't be attending;
 *  - nobody may mark a teacher: staff names are refused by the server, not just
 *    hidden in the UI.
 */

const attendanceStatus = v.union(
  v.literal("present"),
  v.literal("late"),
  v.literal("absent"),
  v.literal("away"),
);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Whether a class day is a real `YYYY-MM-DD` date. */
function validDate(raw: string): boolean {
  return DATE_PATTERN.test(raw) && !Number.isNaN(Date.parse(`${raw}T00:00:00Z`));
}

/** Fold a name for comparison: trimmed and case-insensitive. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** The signed-in account's display name. */
async function accountName(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
): Promise<string> {
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? "someone";
}

interface ClassAccess {
  userId: Id<"users">;
  isStaff: boolean;
  /** Lower-cased staff names, which never appear on the sheet. */
  staff: Set<string>;
}

/**
 * Resolve a class and what the caller may do with it, or null when the caller
 * has no business seeing it at all.
 */
async function resolveClass(
  ctx: QueryCtx | MutationCtx,
  rawCode: string,
): Promise<(ClassAccess & { code: string; ownerId: Id<"users"> }) | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  const row = await findClass(ctx, rawCode);
  if (row === null) return null;

  // The one studio-scoped rule: staff of this class's studio, or a student who
  // joined it. It replaces the old deployment-wide "sees every class".
  const access = await classAccess(ctx, userId, row);
  if (!access.read) return null;
  const seesEveryClass = access.staff;
  const isStaff = row.ownerId === userId || seesEveryClass;

  const members = await ctx.db
    .query("classMembers")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  const { teachers } = await sheetPeople(ctx, row, members);
  const staff = new Set(teachers.map(nameKey));
  // A teacher — or the admin — is staff wherever they are, including in a
  // class they don't own.
  if (seesEveryClass) staff.add(nameKey(await accountName(ctx, userId)));

  return { userId, isStaff, staff, code: row.code, ownerId: row.ownerId };
}

/**
 * Every mark for the class on screen. Readable by its staff and by the
 * students who joined it — the same people who can read `classSheet`.
 */
export const classAttendance = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const access = await resolveClass(ctx, code);
    if (access === null) return { ok: false, marks: [] };

    const rows = await ctx.db
      .query("attendanceMarks")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();

    return {
      ok: true,
      marks: rows
        .map((row) => ({
          id: row._id,
          date: row.date,
          name: row.name,
          status: row.status,
          markedBy: row.markedBy,
          updatedAt: row.updatedAt,
        }))
        .sort((a, b) => a.date.localeCompare(b.date)),
    };
  },
});

/**
 * Record a mark. The caller must be staff (any person on the sheet) or the
 * student themselves, and a student may only say they are present, late, or
 * not attending — an absence stays the teacher's call.
 */
export const setMark = mutation({
  args: {
    code: v.string(),
    date: v.string(),
    name: v.string(),
    status: attendanceStatus,
  },
  handler: async (ctx, { code, date, name, status }) => {
    const access = await resolveClass(ctx, code);
    if (access === null) {
      return { ok: false, error: "You can't mark this class's attendance." };
    }
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, error: "Pick someone to mark." };
    if (!validDate(date)) return { ok: false, error: "That class day looks wrong." };

    const me = await accountName(ctx, access.userId);
    // A student may mark any classmate, but never records an absence.
    if (!access.isStaff && status === "absent") {
      return { ok: false, error: "Only your teacher records an absence." };
    }
    if (access.staff.has(nameKey(trimmed))) {
      return { ok: false, error: "The teacher isn't marked on the roll." };
    }

    const now = Date.now();
    const existing = (
      await ctx.db
        .query("attendanceMarks")
        .withIndex("by_code_and_date", (q) =>
          q.eq("code", access.code).eq("date", date),
        )
        .collect()
    ).find((row) => nameKey(row.name) === nameKey(trimmed));

    if (existing) {
      await ctx.db.patch(existing._id, {
        name: trimmed,
        status,
        markedBy: me,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("attendanceMarks", {
        code: access.code,
        date,
        name: trimmed,
        status,
        markedBy: me,
        updatedAt: now,
      });
    }
    return { ok: true, error: null };
  },
});

/** Take a mark back off the sheet: staff, or any student in the class. */
export const clearMark = mutation({
  args: { code: v.string(), date: v.string(), name: v.string() },
  handler: async (ctx, { code, date, name }) => {
    const access = await resolveClass(ctx, code);
    if (access === null) {
      return { ok: false, error: "You can't change this class's attendance." };
    }
    if (access.staff.has(nameKey(name))) {
      return { ok: false, error: "The teacher isn't marked on the roll." };
    }
    const rows = await ctx.db
      .query("attendanceMarks")
      .withIndex("by_code_and_date", (q) => q.eq("code", access.code).eq("date", date))
      .collect();
    for (const row of rows) {
      if (nameKey(row.name) === nameKey(name)) await ctx.db.delete(row._id);
    }
    return { ok: true, error: null };
  },
});

/**
 * Add a student to the class by name — for people who don't have an account
 * yet. Staff only, and case-insensitively de-duplicated.
 */
export const addStudent = mutation({
  args: { code: v.string(), name: v.string() },
  handler: async (ctx, { code, name }) => {
    const access = await resolveClass(ctx, code);
    if (access === null || !access.isStaff) {
      return { ok: false, error: "Only the teacher can change the class list." };
    }
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) return { ok: false, error: "Enter a name first." };
    if (access.staff.has(nameKey(trimmed))) {
      return { ok: false, error: "That name belongs to the teacher." };
    }
    const existing = await ctx.db
      .query("classStudents")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();
    if (existing.some((row) => nameKey(row.name) === nameKey(trimmed))) {
      return { ok: false, error: "That name is already on the class list." };
    }
    await ctx.db.insert("classStudents", {
      code: access.code,
      name: trimmed,
      addedBy: await accountName(ctx, access.userId),
      addedAt: Date.now(),
    });
    return { ok: true, error: null };
  },
});

/** Take a name back off the class list (staff only). Marks already given stay. */
export const removeStudent = mutation({
  args: { code: v.string(), name: v.string() },
  handler: async (ctx, { code, name }) => {
    const access = await resolveClass(ctx, code);
    if (access === null || !access.isStaff) {
      return { ok: false, error: "Only the teacher can change the class list." };
    }
    const rows = await ctx.db
      .query("classStudents")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();
    for (const row of rows) {
      if (nameKey(row.name) === nameKey(name)) await ctx.db.delete(row._id);
    }
    return { ok: true, error: null };
  },
});

/**
 * Wipe a class's attendance: every mark and every added name. Used by the
 * admin's "delete everything" for the class on screen. Staff only.
 */
export const clearClassAttendance = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const access = await resolveClass(ctx, code);
    if (access === null || !access.isStaff) {
      return { ok: false, error: "Only the teacher can clear the roll." };
    }
    const marks = await ctx.db
      .query("attendanceMarks")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();
    for (const row of marks) await ctx.db.delete(row._id);
    const students = await ctx.db
      .query("classStudents")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();
    for (const row of students) await ctx.db.delete(row._id);
    return { ok: true, cleared: marks.length + students.length, error: null };
  },
});
