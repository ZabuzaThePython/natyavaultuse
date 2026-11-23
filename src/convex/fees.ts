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

/** The local hour (9am) the reminder is delivered for each person. */
const REMINDER_HOUR = 9;

interface Clock {
  year: number;
  /** 0–11, like `Date.getMonth`. */
  monthIndex: number;
  day: number;
  hour: number;
}

/**
 * The wall clock in `timeZone` at `at` (an IANA name such as "Asia/Kolkata",
 * saved by the browser that turned notifications on). Null when the zone is
 * missing or the runtime cannot resolve it, so the caller can fall back.
 */
function zoneClock(timeZone: string, at: number): Clock | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hour12: false,
    }).formatToParts(new Date(at));
    const value = (type: string) =>
      Number(parts.find((part) => part.type === type)?.value);
    const year = value("year");
    const month = value("month");
    const day = value("day");
    const hour = value("hour") % 24; // some engines report midnight as 24
    if (![year, month, day, hour].every(Number.isFinite)) return null;
    return { year, monthIndex: month - 1, day, hour };
  } catch {
    return null;
  }
}

/** The studio's own clock, used when a device never told us its zone. */
function istClock(at: number): Clock {
  const shifted = new Date(at + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    monthIndex: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** One local calendar that is due a reminder on this run. */
interface DueCalendar {
  month: string;
  monthIndex: number;
  year: number;
  /** Accounts with a device in this zone. */
  userIds: Set<Id<"users">>;
  /** Of those, the ones whose fee for `month` is not ticked. */
  unpaid: Set<Id<"users">>;
}

/**
 * The monthly fee reminder, run every hour by convex/crons.ts.
 *
 * Each saved device carries the time zone its browser reported (see
 * convex/push.ts → subscribe), so the reminder follows the student rather than
 * the server: at 9am *their* time on the first and last day of *their* month,
 * every student whose fee for that month has not been ticked gets one
 * notification on their saved devices. A student who has paid is left alone,
 * and staff are never reminded: they are the ones who record the payment.
 * Devices that never reported a zone fall back to India time, where the
 * studios are.
 */
export const queueFeeReminders = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const subscriptions = await ctx.db.query("pushSubscriptions").collect();
    if (subscriptions.length === 0) return { queued: 0, months: [] };

    // Which local calendars want a reminder on this run. Time zones can sit on
    // different dates (and even different months) at the same instant, so each
    // one is worked out against its own clock.
    const calendars = new Map<string, DueCalendar>();
    for (const subscription of subscriptions) {
      const clock =
        (subscription.timeZone
          ? zoneClock(subscription.timeZone, now)
          : null) ?? istClock(now);
      if (clock.hour !== REMINDER_HOUR) continue;
      const lastDay = lastDayOfMonth(clock.year, clock.monthIndex);
      if (clock.day !== 1 && clock.day !== lastDay) continue;

      const key = subscription.timeZone ?? "";
      const existing = calendars.get(key);
      if (existing) {
        existing.userIds.add(subscription.userId);
      } else {
        calendars.set(key, {
          month: `${clock.year}-${String(clock.monthIndex + 1).padStart(2, "0")}`,
          monthIndex: clock.monthIndex,
          year: clock.year,
          userIds: new Set([subscription.userId]),
          unpaid: new Set(),
        });
      }
    }

    if (calendars.size === 0) return { queued: 0, months: [] };

    const months = [...new Set([...calendars.values()].map((due) => due.month))];
    const classes = await ctx.db.query("classes").collect();

    for (const row of classes) {
      // Who has paid, per month that some part of the world is billing now.
      const paidByMonth = new Map<string, Set<string>>();
      for (const month of months) {
        const marks = await ctx.db
          .query("feePayments")
          .withIndex("by_code_and_month", (q) =>
            q.eq("code", row.code).eq("month", month),
          )
          .collect();
        paidByMonth.set(
          month,
          new Set(
            marks
              .filter((mark) => mark.paid)
              .map((mark) => nameKey(mark.studentName)),
          ),
        );
      }

      const members = await ctx.db
        .query("classMembers")
        .withIndex("by_code", (q) => q.eq("code", row.code))
        .collect();
      for (const member of members) {
        // Only accounts with a device in a calendar that is due right now.
        const due = [...calendars.values()].filter(
          (calendar) =>
            calendar.userIds.has(member.userId) &&
            !calendar.unpaid.has(member.userId),
        );
        if (due.length === 0) continue;

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

        for (const calendar of due) {
          if (paidByMonth.get(calendar.month)?.has(nameKey(name))) continue;
          calendar.unpaid.add(member.userId);
        }
      }
    }

    let queued = 0;
    const sentMonths: string[] = [];
    for (const calendar of calendars.values()) {
      if (calendar.unpaid.size === 0) continue;
      await ctx.scheduler.runAfter(0, internal.pushSend.sendToUsers, {
        userIds: [...calendar.unpaid],
        title: `Fees for ${MONTH_NAMES[calendar.monthIndex]} ${calendar.year}`,
        body: `${MONTH_NAMES[calendar.monthIndex]}'s fee hasn't been recorded yet — pay it and your teacher will tick it off on your dashboard.`,
        url: "/dashboard",
        tag: `fees-${calendar.month}`,
      });
      queued += calendar.unpaid.size;
      sentMonths.push(calendar.month);
    }

    return { queued, months: sentMonths };
  },
});
