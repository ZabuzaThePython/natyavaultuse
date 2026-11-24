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

/** Tidy a typed name the way sign-up stored it (case and spacing aside). */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Most handles one typed display name may resolve to. */
const RESOLVE_LIMIT = 5;

/**
 * The usernames a typed sign-in name could mean.
 *
 * Sign-in accepts either the username or the full name shown on class lists,
 * but the Password provider keys accounts by the (lowercased) username. A full
 * name is not unique, so this returns the handles that go with it and the
 * sign-in card tries each with the password that was typed. Only handles come
 * back — never a name, email, role or anything else about the account.
 *
 * The exact handle wins first, so a username that also looks like a name
 * resolves to itself and nothing else.
 */
export const resolve = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const typed = normalizeName(name);
    if (!typed) return [];
    const byHandle = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", typed))
      .first();
    if (byHandle?.email) return [byHandle.email];
    const users = await ctx.db.query("users").collect();
    return users
      .filter((user) => normalizeName(user.name ?? "") === typed)
      .map((user) => user.email)
      .filter((email): email is string => Boolean(email))
      .slice(0, RESOLVE_LIMIT);
  },
});
