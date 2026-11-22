import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { findClass } from "./codes";
import { classAccess, studioRoleIn } from "./studios";

/**
 * Class fees, per month, on the deployment.
 *
 * A teacher ticks each student who has paid for a month; the tick is a row
 * here, so it appears on the student's own dashboard straight away and on any
 * device. A student may read only their own marks — the server filters them,
 * not just the page — and may never write one: recording a payment stays with
 * the teacher (or the admin).
 */

/** A billing month as `YYYY-MM`. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Fold a name for comparison: trimmed and case-insensitive. */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Resolve a class and what the caller may do with it, or null when the caller
 * has no business seeing it. The same studio rule the class's other pages use
 * (see convex/studios.ts → classAccess).
 */
async function resolveClass(
  ctx: QueryCtx | MutationCtx,
  rawCode: string,
): Promise<{
  code: string;
  isStaff: boolean;
  me: string;
} | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  const row = await findClass(ctx, rawCode);
  if (row === null) return null;
  const access = await classAccess(ctx, userId, row);
  if (!access.read) return null;
  const account = await ctx.db.get(userId);
  return {
    code: row.code,
    // The class's owner holds the fee list even where a studio lookup can't
    // say so (a class from before studios).
    isStaff: access.staff || row.ownerId === userId,
    me: account?.name ?? account?.email ?? "someone",
  };
}

/**
 * The class's fee marks. Staff see every student; a student gets only their
 * own rows back.
 */
export const classFees = query({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const access = await resolveClass(ctx, code);
    if (access === null) {
      return { ok: false, viewerIsStaff: false, fees: [] };
    }
    const rows = await ctx.db
      .query("feePayments")
      .withIndex("by_code", (q) => q.eq("code", access.code))
      .collect();

    const mine = nameKey(access.me);
    return {
      ok: true,
      viewerIsStaff: access.isStaff,
      fees: rows
        .filter((row) => access.isStaff || nameKey(row.studentName) === mine)
        .map((row) => ({
          id: row._id,
          studentName: row.studentName,
          month: row.month,
          paid: row.paid,
          markedBy: row.markedBy,
          updatedAt: row.updatedAt,
        }))
        .sort(
          (a, b) =>
            a.month.localeCompare(b.month) ||
            a.studentName.localeCompare(b.studentName),
        ),
    };
  },
});

/**
 * Tick a student as paid for a month, or take the tick back. Staff only — a
 * student cannot record their own fee.
 */
export const setFee = mutation({
  args: {
    code: v.string(),
    studentName: v.string(),
    month: v.string(),
    paid: v.boolean(),
  },
  handler: async (ctx, { code, studentName, month, paid }) => {
    const access = await resolveClass(ctx, code);
    if (access === null) {
      return { ok: false, error: "You can't change this class's fees." };
    }
    if (!access.isStaff) {
      return { ok: false, error: "Only your teacher records fees." };
    }
    const name = studentName.trim().slice(0, 60);
    if (!name) return { ok: false, error: "Pick a student first." };
    if (!MONTH_PATTERN.test(month)) {
      return { ok: false, error: "That month looks wrong." };
    }

    const rows = await ctx.db
      .query("feePayments")
      .withIndex("by_code_and_month", (q) =>
        q.eq("code", access.code).eq("month", month),
      )
      .collect();
    const existing = rows.find((row) => nameKey(row.studentName) === nameKey(name));

    if (existing) {
      if (paid) {
        await ctx.db.patch(existing._id, {
          // Keep the spelling the teacher's sheet uses now.
          studentName: name,
          paid: true,
          markedBy: access.me,
          updatedAt: Date.now(),
        });
      } else {
        await ctx.db.delete(existing._id);
      }
    } else if (paid) {
      await ctx.db.insert("feePayments", {
        code: access.code,
        studentName: name,
        month,
        paid: true,
        markedBy: access.me,
        updatedAt: Date.now(),
      });
    }
    return { ok: true, error: null };
  },
});

/** The month names, so the reminder never depends on runtime date formatting. */
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** India Standard Time (UTC+5:30), where the studios are. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The monthly fee reminder, run every morning by convex/crons.ts.
 *
 * On the first and last day of the month — in IST, so the reminder lands on the
 * studio's calendar day, not the server's — every student whose fee for that
 * month has not been ticked gets one notification on their saved devices. A
 * student who has paid is left alone, and staff are never reminded: they are
 * the ones who record the payment.
 */
export const queueFeeReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = new Date(Date.now() + IST_OFFSET_MS);
    const year = now.getUTCFullYear();
    const monthIndex = now.getUTCMonth();
    const day = now.getUTCDate();
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    if (day !== 1 && day !== lastDay) {
      return { queued: 0, month: null };
    }

    const month = `${year}-${String(monthIndex + 1).padStart(2, "0")}`;
    const classes = await ctx.db.query("classes").collect();
    // One entry per student, even when they belong to more than one class.
    const unpaid = new Map<Id<"users">, string>();

    for (const row of classes) {
      const marks = await ctx.db
        .query("feePayments")
        .withIndex("by_code_and_month", (q) =>
          q.eq("code", row.code).eq("month", month),
        )
        .collect();
      const paid = new Set(
        marks
          .filter((mark) => mark.paid)
          .map((mark) => nameKey(mark.studentName)),
      );
      const members = await ctx.db
        .query("classMembers")
        .withIndex("by_code", (q) => q.eq("code", row.code))
        .collect();
      for (const member of members) {
        const account = await ctx.db.get(member.userId);
        const name = account?.name ?? account?.email;
        if (!name) continue;
        // Staff record the fees; they are never reminded about them.
        const studioRole = await studioRoleIn(ctx, member.userId, row.studioId);
        const isTeacher =
          member.userId === row.ownerId ||
          (studioRole !== null
            ? studioRole !== "student"
            : account?.classRole === "teacher");
        if (isTeacher) continue;
        if (paid.has(nameKey(name))) continue;
        unpaid.set(member.userId, name);
      }
    }

    if (unpaid.size === 0) return { queued: 0, month };

    await ctx.scheduler.runAfter(0, internal.pushSend.sendToUsers, {
      userIds: [...unpaid.keys()],
      title: `Fees for ${MONTH_NAMES[monthIndex]} ${year}`,
      body: `${MONTH_NAMES[monthIndex]}'s fee hasn't been recorded yet — pay it and your teacher will tick it off on your dashboard.`,
      url: "/dashboard",
      tag: `fees-${month}`,
    });
    return { queued: unpaid.size, month };
  },
});
