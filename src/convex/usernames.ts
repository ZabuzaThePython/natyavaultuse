import { v } from "convex/values";
import { query } from "./_generated/server";

/**
 * Whether a password account already uses this username.
 *
 * The Password provider stores the normalized (lowercased) username in
 * `users.email`, so we check the existing email index. Used by the sign-up
 * form to show "That username has already been taken." before attempting
 * account creation.
 */
export const isTaken = query({
  args: { username: v.string() },
  handler: async (ctx, { username }) => {
    const handle = username.trim().toLowerCase();
    if (!handle) return false;
    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", handle))
      .first();
    return user !== null;
  },
});
