import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { mayOpenChat } from "./chats";

/**
 * Call bookkeeping for the chats.
 *
 * Media never goes through Convex: it goes through LiveKit, and the token
 * that lets a browser into a room is minted server-side in convex/calls.ts.
 * What lives here is only the fact that a call is happening — which chat, who
 * started it, when it ended — so everyone else in the chat sees a "call live"
 * banner, gets a notification, and can join the same room.
 *
 * Everyone in a call says "still here" every 30 seconds, and a call only
 * counts as live while that heartbeat is recent. A closed laptop, a crash or
 * a lost network therefore stops advertising the call on its own, instead of
 * leaving a chat looking permanently in-call.
 */

/** How long a heartbeat stays believable. Generous enough for a backgrounded
 * phone, whose timers the browser throttles to about once a minute. */
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

/** The LiveKit room a chat's call happens in. Stable, so a rejoin lands in
 * the same room even if the row was swept away. */
export function roomNameFor(chatId: Id<"chats">): string {
  return `natyavault-${chatId}`;
}

function displayName(user: Doc<"users"> | null): string {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  return email && email !== "admin" ? email : "Member";
}

async function viewer(ctx: QueryCtx | MutationCtx) {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

/** The newest call that has not been closed, heartbeat or not. */
async function openCall(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  const newest = await ctx.db
    .query("calls")
    .withIndex("by_chat_started", (q) => q.eq("chatId", chatId))
    .order("desc")
    .first();
  if (newest === null) return null;
  if (newest.endedAt !== undefined) return null;
  return newest;
}

/** The newest call that has not ended and is still being kept alive. */
async function activeCall(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  const call = await openCall(ctx, chatId);
  if (call === null) return null;
  if (Date.now() - call.heartbeatAt > HEARTBEAT_FRESH_MS) return null;
  return call;
}

/** The call happening in this chat right now, for the banner and Join button. */
export const live = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const me = await viewer(ctx);
    if (me === null) return null;
    if ((await mayOpenChat(ctx, chatId, me)) === null) return null;
    const call = await activeCall(ctx, chatId);
    if (call === null) return null;
    return {
      id: call._id,
      startedBy: call.startedBy,
      startedByName: call.startedByName,
      startedAt: call.startedAt,
      isMine: call.startedBy === me._id,
    };
  },
});

/**
 * Mark a call as started in this chat and notify everyone else in it. Called
 * just before the caller joins the LiveKit room; if a call is already live it
 * is left alone, so a late joiner doesn't restart it or ring anyone again.
 */
export const start = mutation({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ ok: boolean; error: string | null; alreadyLive: boolean }> => {
    const me = await viewer(ctx);
    if (me === null) {
      return { ok: false, error: "Sign in first.", alreadyLive: false };
    }
    const chat = await mayOpenChat(ctx, chatId, me);
    if (chat === null) {
      return { ok: false, error: "You are not in this chat.", alreadyLive: false };
    }

    const existing = await openCall(ctx, chatId);
    if (existing !== null && Date.now() - existing.heartbeatAt <= HEARTBEAT_FRESH_MS) {
      return { ok: true, error: null, alreadyLive: true };
    }

    const name = displayName(me);
    const now = Date.now();
    await ctx.db.insert("calls", {
      chatId,
      roomName: roomNameFor(chatId),
      startedBy: me._id,
      startedByName: name,
      startedAt: now,
      heartbeatAt: now,
    });

    // Scheduled, so the call row is committed before the push is attempted:
    // a delivery problem can't lose the call.
    await ctx.scheduler.runAfter(0, internal.pushSend.send, {
      chatId,
      excludeUserId: me._id,
      title: `${name} started a call`,
      body: chat.title.trim()
        ? `Join the call in ${chat.title.trim()}.`
        : "Tap to join the call.",
      url: `/dashboard/messages?chat=${chatId}`,
    });

    return { ok: true, error: null, alreadyLive: false };
  },
});

/** "Still in the call". Called by every participant every 30 seconds, and once
 * on joining, so the chat's banner follows who is really there. */
export const touch = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<{ ok: boolean }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false };
    if ((await mayOpenChat(ctx, chatId, me)) === null) return { ok: false };
    const now = Date.now();
    const call = await openCall(ctx, chatId);
    if (call !== null) {
      await ctx.db.patch(call._id, { heartbeatAt: now });
      return { ok: true };
    }
    // In a room whose row was already closed (a rejoin into the same LiveKit
    // room): put it back without ringing the chat again.
    await ctx.db.insert("calls", {
      chatId,
      roomName: roomNameFor(chatId),
      startedBy: me._id,
      startedByName: displayName(me),
      startedAt: now,
      heartbeatAt: now,
    });
    return { ok: true };
  },
});

/** Close the chat's call. The last person to leave calls this. */
export const end = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }): Promise<{ ok: boolean }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false };
    if ((await mayOpenChat(ctx, chatId, me)) === null) return { ok: false };
    const call = await openCall(ctx, chatId);
    if (call !== null) await ctx.db.patch(call._id, { endedAt: Date.now() });
    return { ok: true };
  },
});

/**
 * What convex/calls.ts needs before it mints a token: who is asking, what they
 * are called, and which room they belong in. Internal — it is only ever read
 * from the token action, never exposed to a browser.
 */
export const session = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<
    | { ok: false; error: string }
    | {
        ok: true;
        userId: Id<"users">;
        name: string;
        roomName: string;
        chatTitle: string;
      }
  > => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    const chat = await mayOpenChat(ctx, chatId, me);
    if (chat === null) {
      return { ok: false, error: "You are not in this chat." };
    }
    return {
      ok: true,
      userId: me._id,
      name: displayName(me),
      roomName: roomNameFor(chatId),
      chatTitle: chat.title.trim() || "Call",
    };
  },
});
