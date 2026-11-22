/**
 * Web Push subscriptions for chat notifications.
 *
 * Each device that turns notifications on saves its browser subscription here,
 * tied to the signed-in account. The sending itself lives in pushSend.ts,
 * which needs a Node action for the web-push library.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";

/** The VAPID public key the browser subscribes with. */
export const publicKey = query({
  args: {},
  handler: async () => process.env.VAPID_PUBLIC_KEY ?? null,
});

/**
 * This account's saved devices — endpoints only, so the app can tell whether
 * *this* device is already registered without asking the browser for a new
 * subscription (which would need permission again).
 */
export const devices = query({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return rows.map((row) => row.endpoint);
  },
});

/**
 * Save this device's subscription. The endpoint is the browser's own id for
 * the device, so re-subscribing updates the row instead of adding a duplicate
 * — and if a different account used this device before, it moves to them.
 */
export const subscribe = mutation({
  args: {
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
  },
  handler: async (ctx, { endpoint, p256dh, auth, userAgent }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false as const, error: "Sign in first." };
    const trimmed = endpoint.trim();
    if (
      !trimmed.startsWith("https://") ||
      trimmed.length > 1000 ||
      !p256dh ||
      p256dh.length > 300 ||
      !auth ||
      auth.length > 300
    ) {
      return { ok: false as const, error: "That subscription looks wrong." };
    }

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", trimmed))
      .unique();
    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        userId,
        p256dh,
        auth,
        userAgent,
      });
    } else {
      await ctx.db.insert("pushSubscriptions", {
        userId,
        endpoint: trimmed,
        p256dh,
        auth,
        userAgent,
        createdAt: Date.now(),
      });
    }
    return { ok: true as const, error: null };
  },
});

/** Forget one device (the browser's subscription is removed separately). */
export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false as const };
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint.trim()))
      .collect();
    for (const row of rows) {
      if (row.userId === userId) await ctx.db.delete(row._id);
    }
    return { ok: true as const };
  },
});

/**
 * Where one message should go: every other member's saved devices, plus the
 * chat's name so the notification can say where the message is.
 */
export const recipients = internalQuery({
  args: {
    chatId: v.id("chats"),
    excludeUserId: v.id("users"),
  },
  handler: async (ctx, { chatId, excludeUserId }) => {
    const chat = await ctx.db.get(chatId);
    if (chat === null) {
      return { chatTitle: null, subscriptions: [] };
    }
    const members = await ctx.db
      .query("chatMembers")
      .withIndex("by_chat", (q) => q.eq("chatId", chatId))
      .collect();

    const subscriptions: {
      endpoint: string;
      p256dh: string;
      auth: string;
    }[] = [];
    for (const member of members) {
      if (member.userId === excludeUserId) continue;
      // Somebody staff removed from the chat should not be notified about it.
      if (member.removedAt !== undefined) continue;
      const rows = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_user", (q) => q.eq("userId", member.userId))
        .collect();
      for (const row of rows) {
        subscriptions.push({
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
        });
      }
    }
    return { chatTitle: chat.title, subscriptions };
  },
});

/** Drop subscriptions the push service says are gone (uninstalled, expired). */
export const removeDead = internalMutation({
  args: { endpoints: v.array(v.string()) },
  handler: async (ctx, { endpoints }) => {
    for (const endpoint of endpoints) {
      const rows = await ctx.db
        .query("pushSubscriptions")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
        .collect();
      for (const row of rows) await ctx.db.delete(row._id);
    }
  },
});
