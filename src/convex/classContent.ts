/**
 * Deleting a class and everything keyed by its join code.
 *
 * The join code is the key for a class's people, its added names, its
 * attendance, its practice log, its fee marks, its media and its chat room.
 * Two places remove a class — its owner from the Classes page, and the
 * operator when they delete a whole studio — so the cascade lives here once
 * instead of being copied into both and drifting apart.
 *
 * This module is deliberately free of policy: each caller decides who may
 * delete what before calling, and this just takes the class apart.
 */
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

/**
 * Delete one chat room and everything attached to it: its messages and the
 * files on them, its seats, read markers and call rows.
 */
async function deleteRoom(ctx: MutationCtx, chatId: Id<"chats">) {
  const messages = await ctx.db
    .query("chatMessages")
    .withIndex("by_chat_time", (q) => q.eq("chatId", chatId))
    .collect();
  for (const message of messages) {
    if (message.attachment) {
      await ctx.storage.delete(message.attachment.storageId);
    }
    await ctx.db.delete(message._id);
  }

  const seats = await ctx.db
    .query("chatMembers")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  for (const seat of seats) await ctx.db.delete(seat._id);

  const reads = await ctx.db
    .query("chatReads")
    .withIndex("by_chat_user", (q) => q.eq("chatId", chatId))
    .collect();
  for (const read of reads) await ctx.db.delete(read._id);

  const calls = await ctx.db
    .query("calls")
    .withIndex("by_chat_started", (q) => q.eq("chatId", chatId))
    .collect();
  for (const call of calls) await ctx.db.delete(call._id);

  await ctx.db.delete(chatId);
}

/**
 * Delete one class and every row that hangs off its join code, then the class
 * row itself. The code stops working for sign-up and for joining straight
 * away, and because nothing is left behind a recycled code cannot resurface
 * the old class's data. Returns the class's name for the caller's message.
 */
export async function deleteClassContent(
  ctx: MutationCtx,
  row: Doc<"classes">,
): Promise<string> {
  const rooms = await ctx.db
    .query("chats")
    .withIndex("by_class", (q) => q.eq("classCode", row.code))
    .collect();
  for (const room of rooms) await deleteRoom(ctx, room._id);

  const members = await ctx.db
    .query("classMembers")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const member of members) await ctx.db.delete(member._id);

  const added = await ctx.db
    .query("classStudents")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const student of added) await ctx.db.delete(student._id);

  const marks = await ctx.db
    .query("attendanceMarks")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const mark of marks) await ctx.db.delete(mark._id);

  const sessions = await ctx.db
    .query("practiceEntries")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const session of sessions) await ctx.db.delete(session._id);

  const fees = await ctx.db
    .query("feePayments")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const fee of fees) await ctx.db.delete(fee._id);

  const media = await ctx.db
    .query("vaultMedia")
    .withIndex("by_code", (q) => q.eq("code", row.code))
    .collect();
  for (const file of media) await ctx.db.delete(file._id);

  await ctx.db.delete(row._id);
  return row.name;
}
