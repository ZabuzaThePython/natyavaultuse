"use node";

import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";

/**
 * Live calls.
 *
 * Group audio/video runs on a LiveKit SFU, not peer to peer: every phone sends
 * one stream to the server and receives the others, so a full class can be in
 * one call without melting anyone's upload. That is the difference between a
 * 4-person mesh call and a real group call.
 *
 * The API secret must never reach a browser, so it lives in the deployment's
 * environment (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET) and only this
 * server-side action uses it, to mint a short-lived token for one room. The
 * browser then connects straight to LiveKit with that token.
 */

export const token = action({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{
    /** False when the deployment has no LiveKit project configured. */
    configured: boolean;
    ok: boolean;
    url: string | null;
    token: string | null;
    roomName: string | null;
    error: string | null;
  }> => {
    const url = process.env.LIVEKIT_URL?.trim().replace(/\/+$/, "") ?? "";
    const apiKey = process.env.LIVEKIT_API_KEY?.trim() ?? "";
    const apiSecret = process.env.LIVEKIT_API_SECRET?.trim() ?? "";
    if (!url || !apiKey || !apiSecret) {
      return {
        configured: false,
        ok: false,
        url: null,
        token: null,
        roomName: null,
        error: null,
      };
    }

    // The caller must be signed in and actually in this chat. The room is
    // chosen here, not by the client, so a token can't be minted for a room
    // the account has no business in.
    const session = await ctx.runQuery(internal.callState.session, { chatId });
    if (!session.ok) {
      return {
        configured: true,
        ok: false,
        url: null,
        token: null,
        roomName: null,
        error: session.error,
      };
    }

    // Identity is per connection, not per account: LiveKit disconnects an
    // earlier session with the same identity, and joining a class from a
    // phone while the laptop is also in the call should just work.
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity: `${session.userId}-${randomUUID().slice(0, 8)}`,
      name: session.name,
      // Long enough for a class. A fresh token is minted on every join.
      ttl: "4h",
    });
    accessToken.addGrant({
      room: session.roomName,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    return {
      configured: true,
      ok: true,
      url,
      token: await accessToken.toJwt(),
      roomName: session.roomName,
      error: null,
    };
  },
});
