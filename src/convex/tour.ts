import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";

/**
 * Is the guided tour still owed to this account?
 *
 * `tourPending` is stamped at sign-up (see convex/auth/password.ts) and the
 * tour clears it, so a walkthrough is offered exactly once — never on a later
 * sign-in. Accounts that existed before the tour have no stamp at all, which
 * reads as "already seen".
 */
export const pending = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;
    const user = await ctx.db.get(userId);
    return user !== null && user.tourPending === true;
  },
});

/** Mark the tour as seen (finished or skipped). */
export const finish = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    await ctx.db.patch(userId, { tourPending: false });
    return true;
  },
});
