import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

/** Longest full name accepted, in characters (same cap as the sign-up card). */
const FULL_NAME_MAX = 80;

/** Trim and tidy a typed full name (" maya   iyer " -> "maya iyer"). */
function cleanFullName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, FULL_NAME_MAX);
}

/**
 * Does the signed-in account still need to say what its full name is?
 *
 * Sign-up now asks for a full name, but accounts made before that carry their
 * username as their display name — which is what class lists, chat bubbles and
 * call tiles show. They have no `fullNameSet` stamp, so this is the flag the
 * "What's your name?" card in the app shell waits on.
 */
export const needsFullName = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;
    const user = await ctx.db.get(userId);
    return user !== null && user.fullNameSet !== true;
  },
});

/**
 * Save the name this account goes by. Only ever changes the display name — the
 * username is what they sign in with, and that stays put.
 */
export const setFullName = mutation({
  args: { fullName: v.string() },
  handler: async (ctx, { fullName }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Sign in first.");
    const cleaned = cleanFullName(fullName);
    if (cleaned.length < 2) throw new Error("Enter your full name.");
    await ctx.db.patch(userId, { name: cleaned, fullNameSet: true });
    return cleaned;
  },
});
