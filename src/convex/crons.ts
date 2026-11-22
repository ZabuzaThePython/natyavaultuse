import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * The monthly fee reminder.
 *
 * Runs every morning (03:30 UTC — 09:00 in India, where the studios are) and
 * sends only on the first and last day of the month, decided in the handler
 * (see convex/fees.ts → queueFeeReminders). Checking daily rather than on two
 * fixed dates means a deploy or an outage on one of them cannot skip a
 * reminder — the next morning catches the last day.
 */
crons.daily(
  "monthly fee reminders",
  { hourUTC: 3, minuteUTC: 30 },
  internal.fees.queueFeeReminders,
  {},
);

export default crons;
