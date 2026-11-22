"use node";

/**
 * Sends the web-push notifications. A Node action because the Web Push
 * encryption comes from the `web-push` package.
 *
 * Chat notifications run after the message mutation commits, so a push problem
 * can never lose a message. The fee reminder (see convex/fees.ts) uses
 * `sendToUsers`, which is addressed by account rather than by chat.
 * Subscriptions the push service reports as gone (404/410) are deleted so they
 * stop being tried.
 */
import { v } from "convex/values";
import webpush from "web-push";
import { internal } from "./_generated/api";
import { internalAction, type ActionCtx } from "./_generated/server";

const DAY_SECONDS = 24 * 60 * 60;

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Point `web-push` at this deployment's keys. Returns false (and says so in the
 * logs) when they are not set, so callers can stop before doing any work.
 */
function configureVapid(): boolean {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  // A contact address for the push service; required by the Web Push spec
  // but only ever used if a service needs to reach the site owner.
  const subject =
    process.env.VAPID_SUBJECT?.trim() || "mailto:notifications@natyavault.app";

  if (!publicKey || !privateKey) {
    console.warn("Push skipped: VAPID keys are not set on this deployment.");
    return false;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return true;
}

/** Deliver one payload to every subscription, dropping the dead ones. */
async function deliver(
  ctx: Pick<ActionCtx, "runMutation">,
  subscriptions: Subscription[],
  payload: string,
): Promise<{ sent: number; dead: number; total: number }> {
  if (subscriptions.length === 0) return { sent: 0, dead: 0, total: 0 };

  let sent = 0;
  const dead: string[] = [];

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: {
              p256dh: subscription.p256dh,
              auth: subscription.auth,
            },
          },
          payload,
          { TTL: DAY_SECONDS },
        );
        sent += 1;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          dead.push(subscription.endpoint);
        } else {
          console.error("Push send failed:", status ?? error);
        }
      }
    }),
  );

  if (dead.length > 0) {
    await ctx.runMutation(internal.push.removeDead, { endpoints: dead });
  }

  return { sent, dead: dead.length, total: subscriptions.length };
}

export const send = internalAction({
  args: {
    chatId: v.id("chats"),
    /** The sender — they do not get a notification for their own message. */
    excludeUserId: v.id("users"),
    title: v.string(),
    body: v.string(),
    /** Where tapping the notification should land. */
    url: v.string(),
  },
  handler: async (
    ctx,
    { chatId, excludeUserId, title, body, url },
  ): Promise<{ sent: number; dead: number; total: number }> => {
    if (!configureVapid()) return { sent: 0, dead: 0, total: 0 };

    const { subscriptions } = await ctx.runQuery(internal.push.recipients, {
      chatId,
      excludeUserId,
    });
    return await deliver(
      ctx,
      subscriptions,
      JSON.stringify({ title, body, url, chatId }),
    );
  },
});

/**
 * Send one notification to a set of accounts — used by the monthly fee
 * reminder, which is about a person's fees rather than a chat. `tag` groups
 * repeats of the same notification so the phone replaces the older one.
 */
export const sendToUsers = internalAction({
  args: {
    userIds: v.array(v.id("users")),
    title: v.string(),
    body: v.string(),
    url: v.string(),
    tag: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { userIds, title, body, url, tag },
  ): Promise<{ sent: number; dead: number; total: number }> => {
    if (!configureVapid()) return { sent: 0, dead: 0, total: 0 };

    const { subscriptions } = await ctx.runQuery(
      internal.push.subscriptionsFor,
      { userIds },
    );
    return await deliver(
      ctx,
      subscriptions,
      JSON.stringify({ title, body, url, tag }),
    );
  },
});
