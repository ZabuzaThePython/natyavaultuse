import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Records the plain-text password for an account.
 *
 * Called from the Password provider's `profile()` hook while a new account is
 * being created (see convex/auth/password.ts), so the Admin area can display
 * each account's password. The table is never exposed to the client: the only
 * function that reads it is the admin-credential-gated `admin.listAccounts`.
 *
 * This is intentionally a plain-text record rather than a hash — it exists
 * purely so the vault owner can see the credentials they created.
 */
export const record = internalMutation({
  args: { username: v.string(), password: v.string() },
  handler: async (ctx, { username, password }) => {
    const key = username.trim().toLowerCase();
    if (key.length === 0) return;
    const existing = await ctx.db
      .query("savedPasswords")
      .withIndex("by_username", (q) => q.eq("username", key))
      .unique();
    const updatedAt = Date.now();
    if (existing !== null) {
      await ctx.db.patch(existing._id, { password, updatedAt });
      return;
    }
    await ctx.db.insert("savedPasswords", { username: key, password, updatedAt });
  },
});
