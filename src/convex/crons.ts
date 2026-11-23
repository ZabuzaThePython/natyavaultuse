import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

/**
 * The monthly fee reminder.
 *
 * Runs every hour, on the half hour, and sends at 9am in each student's own
 * time zone on the first and last day of their month (see convex/fees.ts →
 * queueFeeReminders). The time zone comes from the browser that turned
 * notifications on, so an hourly tick is what lets every zone get its own 9am
 * instead of a single fixed moment for the whole deployment. The handler exits
 * early when no zone is due, so most runs cost one small read.
 */
crons.hourly(
  "monthly fee reminders",
  { minuteUTC: 30 },
  internal.fees.queueFeeReminders,
  {},
);

export default crons;
