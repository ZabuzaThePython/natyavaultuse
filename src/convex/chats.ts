import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { findClass } from "./classes";
import { classAccess, scopeFor, studioMemberIds } from "./studios";
import { isGiphyUrl } from "./gifs";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";

/**
 * Chats.
 *
 * A teacher or the admin can start as many group chats as they like, naming
 * each one, and can start a solo conversation with a single person. The people
 * picker lists every account in the school, so a chat can mix classes — classes
 * decide what a student may open, not who they may talk to.
 *
 * Every class also has one room of its own, created the first time somebody
 * with access to that class opens Messages. That is where the old single class
 * thread lives now, so a student still has somewhere to talk to their teacher
 * without waiting for one to be created.
 *
 * Messages are rows here, not in a browser: everyone in a chat sees the same
 * thread on every device, and a redeploy of the app does not clear it.
 */

/** Longest message accepted, in characters. */
const MAX_MESSAGE = 4000;

function displayName(user: Doc<"users"> | null): string {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  return email && email !== "admin" ? email : "Member";
}

/** The account behind the session, or null when signed out. */
async function viewer(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) return null;
  return await ctx.db.get(userId);
}

async function membership(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
) {
  return await ctx.db
    .query("chatMembers")
    .withIndex("by_chat_user", (q) =>
      q.eq("chatId", chatId).eq("userId", userId),
    )
    .unique();
}

/** What an account may do with a chat it is a member of. */
export interface ChatAccess {
  chat: Doc<"chats">;
  /** History only: the thread stops at `cutoff` and nothing can be sent. */
  readOnly: boolean;
  /** Last moment of the thread that is visible, when read-only. */
  cutoff: number;
}

/**
 * Whether this account may open a chat, and how much of it.
 *
 * Being a member is the rule. A class room adds one more: only people in that
 * class see it live. When someone moves to another class they keep their old
 * class room — the history they were part of — but it is frozen at the moment
 * they left, so no new messages reach them.
 *
 * Teachers and the admin are exempt from the class rule: seeing every class
 * room is the point of the teacher view.
 */
/**
 * Whether this account holds staff powers in a chat: it staffs the chat's class
 * (its studio's teachers and owners), or — for a chat with no class, like a
 * group chat — it is staff of its own studio. The platform admin always does.
 *
 * This replaces the old deployment-wide "sees every class": a teacher of one
 * studio must not moderate another studio's rooms.
 */
async function staffForChat(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users">,
  classCode: string | null,
): Promise<boolean> {
  if (classCode) {
    const row = await findClass(ctx, classCode);
    if (row !== null) return (await classAccess(ctx, userId, row)).staff;
  }
  const scope = await scopeFor(ctx, userId);
  return scope !== null && scope.kind !== "student";
}

export async function chatAccess(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  me: Doc<"users">,
): Promise<ChatAccess | null> {
  const chat = await ctx.db.get(chatId);
  if (chat === null) return null;
  const seat = await membership(ctx, chatId, me._id);
  if (seat === null) return null;
  // Staff took them out: no seat to speak of until they are added back.
  if (seat.removedAt !== undefined) return null;
  // Deleted for themselves: gone from their list until somebody posts again.
  if (seat.hiddenAt !== undefined && chat.lastMessageAt <= seat.hiddenAt) {
    return null;
  }
  if (!chat.classCode) return { chat, readOnly: false, cutoff: 0 };
  // Staff of that class's studio has the room in full; a teacher of another
  // studio does not.
  const classRow = await findClass(ctx, chat.classCode);
  if (classRow !== null && (await classAccess(ctx, me._id, classRow)).staff) {
    return { chat, readOnly: false, cutoff: 0 };
  }

  const joined = await ctx.db
    .query("classMembers")
    .withIndex("by_user", (q) => q.eq("userId", me._id))
    .first();
  if (joined?.code === chat.classCode) return { chat, readOnly: false, cutoff: 0 };

  // Moved on. `leftAt` is stamped when they changed class; the join time of
  // the class they moved to is the same moment, and covers memberships that
  // were already stale before this was recorded.
  return {
    chat,
    readOnly: true,
    cutoff: seat.leftAt ?? joined?.joinedAt ?? seat.joinedAt,
  };
}

/** The chat only when this account may use it fully — not history-only. */
export async function mayOpenChat(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  me: Doc<"users">,
): Promise<Doc<"chats"> | null> {
  const access = await chatAccess(ctx, chatId, me);
  return access !== null && !access.readOnly ? access.chat : null;
}

/** Everyone still in the chat — people staff removed are left out. */
async function membersOf(ctx: QueryCtx | MutationCtx, chatId: Id<"chats">) {
  const seats = await ctx.db
    .query("chatMembers")
    .withIndex("by_chat", (q) => q.eq("chatId", chatId))
    .collect();
  return seats.filter((seat) => seat.removedAt === undefined);
}

/** Ids of every account in one class, by join code. */
async function classRoster(
  ctx: QueryCtx | MutationCtx,
  classCode: string,
): Promise<Set<Id<"users">>> {
  const rows = await ctx.db
    .query("classMembers")
    .withIndex("by_code", (q) => q.eq("code", classCode))
    .collect();
  return new Set(rows.map((row) => row.userId));
}

async function readMarker(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
) {
  const row = await ctx.db
    .query("chatReads")
    .withIndex("by_chat_user", (q) =>
      q.eq("chatId", chatId).eq("userId", userId),
    )
    .unique();
  return row?.lastReadAt ?? 0;
}

/** Messages sent by other people since `since`, excluding tombstones. */
async function unreadSince(
  ctx: QueryCtx | MutationCtx,
  chatId: Id<"chats">,
  userId: Id<"users">,
  since: number,
) {
  const rows = await ctx.db
    .query("chatMessages")
    .withIndex("by_chat_time", (q) =>
      q.eq("chatId", chatId).gt("createdAt", since),
    )
    .collect();
  return rows.filter((m) => m.authorId !== userId && !m.deletedBy).length;
}

/** What the chat list calls a conversation. */
function titleFor(
  chat: Doc<"chats">,
  members: Doc<"chatMembers">[],
  viewerId: Id<"users">,
): string {
  // A single chat can be named too; without a name it is the other person.
  if (chat.title.trim()) return chat.title.trim();
  if (chat.kind === "solo") {
    const other = members.find((m) => m.userId !== viewerId);
    return other?.name ?? "Conversation";
  }
  return "Group chat";
}

/** "Ananya, Riya, Meera + 2" from a list of names. */
function defaultGroupTitle(names: string[]): string {
  const shown = names.slice(0, 3).join(", ");
  const extra = names.length - 3;
  return extra > 0 ? `${shown} + ${extra}` : shown;
}

async function join(
  ctx: MutationCtx,
  chatId: Id<"chats">,
  user: Doc<"users">,
) {
  await ctx.db.insert("chatMembers", {
    chatId,
    userId: user._id,
    name: displayName(user),
    joinedAt: Date.now(),
  });
}

/**
 * The people a chat can be started with: every account in the school, grouped
 * by class, with teachers and the admin in their own group. Staff only — a
 * student never sees the school's account list.
 */
export const people = query({
  args: { chatId: v.optional(v.id("chats")) },
  handler: async (ctx, { chatId }) => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, groups: [] };
    const scope = await scopeFor(ctx, me._id);
    if (scope === null || scope.kind === "student") {
      return { ok: false, groups: [] };
    }

    // Opened from a class room: offer only the people that room would accept,
    // so the picker never proposes an account that addMembers has to skip.
    const classCode = chatId ? (await ctx.db.get(chatId))?.classCode : undefined;
    const inRoomClass = classCode ? await classRoster(ctx, classCode) : null;

    // A studio's staff chats with its own people; the platform admin with
    // everyone.
    const allowed =
      scope.kind === "platform"
        ? null
        : await studioMemberIds(ctx, scope.studioId);

    const users = await ctx.db.query("users").collect();
    const classes =
      scope.kind === "platform"
        ? await ctx.db.query("classes").collect()
        : await ctx.db
            .query("classes")
            .withIndex("by_studio", (q) => q.eq("studioId", scope.studioId))
            .collect();
    const memberships = await ctx.db.query("classMembers").collect();

    // Who counts as staff here: this studio's teachers and class owners.
    const staffIds = new Set<Id<"users">>();
    if (scope.kind === "studio") {
      const rows = await ctx.db
        .query("studioMembers")
        .withIndex("by_studio", (q) => q.eq("studioId", scope.studioId))
        .collect();
      for (const row of rows) {
        if (row.role !== "student") staffIds.add(row.userId);
      }
      for (const row of classes) staffIds.add(row.ownerId);
    }

    const className = new Map<string, string>();
    for (const row of classes) {
      if (!className.has(row.ownerId)) className.set(row.ownerId, row.name);
    }
    const joinedClass = new Map<string, string>();
    for (const row of memberships) {
      joinedClass.set(row.userId, row.className);
    }

    const staff: { id: Id<"users">; name: string; role: string }[] = [];
    const byClass = new Map<
      string,
      { id: Id<"users">; name: string; role: string }[]
    >();

    for (const user of users) {
      if (user._id === me._id) continue;
      const name = displayName(user);
      if (!name) continue;
      if (allowed !== null && !allowed.has(user._id)) continue;
      const isStaff =
        allowed === null
          ? user.role === "admin" ||
            user.email === "admin" ||
            user.classRole === "teacher" ||
            className.has(user._id)
          : staffIds.has(user._id);
      if (inRoomClass !== null && !isStaff && !inRoomClass.has(user._id)) {
        continue;
      }
      const entry = {
        id: user._id,
        name,
        role: isStaff ? "teacher" : "student",
      };
      if (isStaff) {
        staff.push(entry);
        continue;
      }
      const label = joinedClass.get(user._id) ?? "Students without a class";
      const bucket = byClass.get(label) ?? [];
      bucket.push(entry);
      byClass.set(label, bucket);
    }

    const groups = [...byClass.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([label, people]) => ({
        label,
        people: people.sort((a, b) => a.name.localeCompare(b.name)),
      }));
    if (staff.length > 0) {
      groups.push({
        label: "Teachers & admin",
        people: staff.sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return { ok: true, groups };
  },
});

/**
 * The chats this account is in, newest activity first, with the unread count
 * and the names of everyone else.
 */
export const myChats = query({
  args: {},
  handler: async (ctx) => {
    const me = await viewer(ctx);
    if (me === null) return [];

    const mine = await ctx.db
      .query("chatMembers")
      .withIndex("by_user", (q) => q.eq("userId", me._id))
      .collect();

    const chats = [];
    for (const row of mine) {
      const access = await chatAccess(ctx, row.chatId, me);
      if (access === null) continue;
      const chat = access.chat;
      const members = await membersOf(ctx, chat._id);
      const since = await readMarker(ctx, chat._id, me._id);
      chats.push({
        id: chat._id,
        kind: chat.kind,
        title: titleFor(chat, members, me._id),
        /** True when they moved to another class: history, no new messages. */
        readOnly: access.readOnly,
        /** True for the room that belongs to one class. */
        isClassChat: Boolean(chat.classCode),
        members: members
          .filter((m) => m.userId !== me._id)
          .map((m) => m.name)
          .sort((a, b) => a.localeCompare(b)),
        memberCount: members.length,
        lastMessageAt: chat.lastMessageAt,
        lastMessageText: chat.lastMessageText,
        lastMessageAuthor: chat.lastMessageAuthor,
        unread: access.readOnly
          ? 0
          : await unreadSince(ctx, chat._id, me._id, since),
      });
    }

    return chats.sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  },
});

/** Everything the header badge needs. */
export const unreadTotal = query({
  args: {},
  handler: async (ctx) => {
    const me = await viewer(ctx);
    if (me === null) return 0;
    const mine = await ctx.db
      .query("chatMembers")
      .withIndex("by_user", (q) => q.eq("userId", me._id))
      .collect();
    let total = 0;
    for (const row of mine) {
      // A frozen room must not show up in the badge — nothing new is readable.
      const access = await chatAccess(ctx, row.chatId, me);
      if (access === null || access.readOnly) continue;
      const since = await readMarker(ctx, row.chatId, me._id);
      total += await unreadSince(ctx, row.chatId, me._id, since);
    }
    return total;
  },
});

/**
 * The room for one class: found, or created with everyone the class already
 * knows in it, and the caller added if they were not in it yet.
 */
async function ensureRoom(
  ctx: MutationCtx,
  row: Doc<"classes">,
  me: Doc<"users">,
): Promise<Id<"chats"> | null> {
  let chat = await ctx.db
    .query("chats")
    .withIndex("by_class", (q) => q.eq("classCode", row.code))
    .first();

  if (chat === null) {
    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      kind: "group",
      title: row.name,
      classCode: row.code,
      createdBy: row.ownerId,
      createdByName: row.ownerName,
      createdAt: now,
      lastMessageAt: now,
      lastMessageText: "",
      lastMessageAuthor: "",
    });

    // Everyone the class already knows starts in the room, so no one has to
    // be added by hand.
    const classMembers = await ctx.db
      .query("classMembers")
      .withIndex("by_code", (q) => q.eq("code", row.code))
      .collect();
    const added = new Set<Id<"users">>();
    const owner = await ctx.db.get(row.ownerId);
    if (owner !== null) {
      await join(ctx, chatId, owner);
      added.add(owner._id);
    }
    for (const member of classMembers) {
      if (added.has(member.userId)) continue;
      const user = await ctx.db.get(member.userId);
      if (user === null) continue;
      await join(ctx, chatId, user);
      added.add(user._id);
    }
    chat = await ctx.db.get(chatId);
    if (chat === null) return null;
  }

  // A seat staff removed is still a row, so this never quietly adds someone
  // back: only an account with no seat at all is joined here.
  if ((await membership(ctx, chat._id, me._id)) === null) {
    await join(ctx, chat._id, me);
  }
  return chat._id;
}

/**
 * One class's room. Created on first use by whoever opens it (the class's
 * owner, a teacher, or a student who joined the class). A class code the
 * caller may not open simply yields `null`.
 */
export const ensureClassChat = mutation({
  args: { code: v.string() },
  handler: async (ctx, { code }): Promise<Id<"chats"> | null> => {
    const me = await viewer(ctx);
    if (me === null) return null;
    const row = await findClass(ctx, code);
    if (row === null) return null;

    const access = await classAccess(ctx, me._id, row);
    if (!access.read) return null;

    return await ensureRoom(ctx, row, me);
  },
});

/**
 * Every class room, for a teacher or the admin: each one is created if it does
 * not exist yet and the caller is put in it, so the whole school's rooms show
 * up in their chat list instead of only the class they happen to have open.
 * A student gets nothing — they only ever see the room of the class they
 * joined.
 */
export const ensureAllClassChats = mutation({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; rooms: number }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, rooms: 0 };
    const scope = await scopeFor(ctx, me._id);
    if (scope === null || scope.kind === "student") {
      return { ok: false, rooms: 0 };
    }

    // Only this studio's rooms: every class in the deployment would put another
    // school's rooms in this account's chat list.
    const classes =
      scope.kind === "platform"
        ? await ctx.db.query("classes").collect()
        : await ctx.db
            .query("classes")
            .withIndex("by_studio", (q) => q.eq("studioId", scope.studioId))
            .collect();
    let rooms = 0;
    for (const row of classes) {
      if ((await ensureRoom(ctx, row, me)) !== null) rooms++;
    }
    return { ok: true, rooms };
  },
});

/**
 * Start a chat. One person selected makes it a solo conversation (reusing an
 * existing one between the same two people rather than creating a duplicate);
 * two or more make a group chat, named from `title` or the members. Staff only.
 */
export const createChat = mutation({
  args: {
    title: v.optional(v.string()),
    memberIds: v.array(v.id("users")),
  },
  handler: async (
    ctx,
    { title, memberIds },
  ): Promise<{
    ok: boolean;
    chatId: Id<"chats"> | null;
    error: string | null;
    reused: boolean;
  }> => {
    const me = await viewer(ctx);
    if (me === null) {
      return { ok: false, chatId: null, error: "Sign in first.", reused: false };
    }
    const scope = await scopeFor(ctx, me._id);
    if (scope === null || scope.kind === "student") {
      return {
        ok: false,
        chatId: null,
        error: "Only a teacher or the admin can start a chat.",
        reused: false,
      };
    }

    const unique = [
      ...new Set(memberIds.filter((id) => id !== me._id)),
    ] as Id<"users">[];
    if (unique.length === 0) {
      return {
        ok: false,
        chatId: null,
        error: "Pick at least one person.",
        reused: false,
      };
    }

    const others: Doc<"users">[] = [];
    for (const id of unique) {
      const user = await ctx.db.get(id);
      if (user === null) {
        return {
          ok: false,
          chatId: null,
          error: "One of those accounts no longer exists.",
          reused: false,
        };
      }
      others.push(user);
    }

    // A studio's staff may only start chats with its own people: another
    // school's students must not end up in this conversation.
    if (scope.kind === "studio") {
      const allowed = await studioMemberIds(ctx, scope.studioId);
      if (others.some((user) => !allowed.has(user._id))) {
        return {
          ok: false,
          chatId: null,
          error: "Those people are not in your studio.",
          reused: false,
        };
      }
    }

    const names = others.map((user) => displayName(user));
    const solo = others.length === 1;
    const soloKey = solo
      ? [me._id, others[0]._id].sort().join("|")
      : undefined;

    if (soloKey) {
      const existing = await ctx.db
        .query("chats")
        .withIndex("by_solo_key", (q) => q.eq("soloKey", soloKey))
        .unique();
      if (existing !== null) {
        if ((await membership(ctx, existing._id, me._id)) === null) {
          await join(ctx, existing._id, me);
        }
        if ((await membership(ctx, existing._id, others[0]._id)) === null) {
          await join(ctx, existing._id, others[0]);
        }
        return { ok: true, chatId: existing._id, error: null, reused: true };
      }
    }

    const now = Date.now();
    const chatId = await ctx.db.insert("chats", {
      kind: solo ? "solo" : "group",
      title: solo
        ? ""
        : title?.trim().slice(0, 80) ||
          defaultGroupTitle([displayName(me), ...names]),
      createdBy: me._id,
      createdByName: displayName(me),
      createdAt: now,
      lastMessageAt: now,
      lastMessageText: "",
      lastMessageAuthor: "",
      ...(soloKey ? { soloKey } : {}),
    });
    await join(ctx, chatId, me);
    for (const user of others) await join(ctx, chatId, user);

    return { ok: true, chatId, error: null, reused: false };
  },
});

/**
 * Add people to a chat. Staff only, the same rule as starting one.
 *
 * A class room belongs to one class, so only that class's students — and
 * staff, who see every class — are added. Anyone else would get a frozen,
 * read-only view of it (see chatAccess), so they are counted as skipped
 * instead. A private conversation is not extendable: start a group instead.
 */
export const addMembers = mutation({
  args: { chatId: v.id("chats"), memberIds: v.array(v.id("users")) },
  handler: async (
    ctx,
    { chatId, memberIds },
  ): Promise<{
    ok: boolean;
    added: number;
    skipped: number;
    error: string | null;
  }> => {
    const me = await viewer(ctx);
    if (me === null) {
      return { ok: false, added: 0, skipped: 0, error: "Sign in first." };
    }
    const scope = await scopeFor(ctx, me._id);
    if (scope === null || scope.kind === "student") {
      return {
        ok: false,
        added: 0,
        skipped: 0,
        error: "Only a teacher or the admin can add people to a chat.",
      };
    }
    // A studio's staff adds its own people only.
    const allowed =
      scope.kind === "studio"
        ? await studioMemberIds(ctx, scope.studioId)
        : null;
    // Staff see every class, so a room they can open is never read-only.
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) {
      return { ok: false, added: 0, skipped: 0, error: "You are not in this chat." };
    }
    const chat = access.chat;
    if (chat.kind === "solo") {
      return {
        ok: false,
        added: 0,
        skipped: 0,
        error: "This is a private conversation — start a group chat instead.",
      };
    }

    const classCode = chat.classCode;
    const inClass = classCode ? await classRoster(ctx, classCode) : null;

    let added = 0;
    let skipped = 0;
    for (const id of new Set(memberIds)) {
      const user = await ctx.db.get(id);
      if (user === null) continue;
      if (allowed !== null && !allowed.has(user._id)) {
        skipped++;
        continue;
      }
      // Checked before the seat so somebody who left the class cannot be
      // restored into a room they would only see frozen.
      if (
        inClass !== null &&
        !inClass.has(user._id) &&
        !(await staffForChat(ctx, user._id, classCode ?? null))
      ) {
        skipped++;
        continue;
      }
      const seat = await membership(ctx, chatId, user._id);
      if (seat === null) {
        await join(ctx, chatId, user);
        added++;
      } else if (seat.removedAt !== undefined) {
        // Somebody staff took out comes back — including a chat they had
        // deleted for themselves, so the room really reappears for them.
        await ctx.db.patch(seat._id, {
          removedAt: undefined,
          hiddenAt: undefined,
          name: displayName(user),
          joinedAt: Date.now(),
        });
        added++;
      }
    }

    return { ok: true, added, skipped, error: null };
  },
});

/**
 * Take somebody out of a chat. Staff only, group chats only, and never
 * yourself — leaving a chat of your own is what Delete chat is for.
 */
export const removeMember = mutation({
  args: { chatId: v.id("chats"), userId: v.id("users") },
  handler: async (
    ctx,
    { chatId, userId },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    const target = await ctx.db.get(chatId);
    if (!(await staffForChat(ctx, me._id, target?.classCode ?? null))) {
      return {
        ok: false,
        error: "Only a teacher or the admin can remove people from a chat.",
      };
    }
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) {
      return { ok: false, error: "You are not in this chat." };
    }
    if (access.chat.kind === "solo") {
      return {
        ok: false,
        error:
          "A private conversation has just the two of you — delete it from your list instead.",
      };
    }
    if (userId === me._id) {
      return {
        ok: false,
        error: "To leave a chat yourself, delete it from your list.",
      };
    }

    const seat = await membership(ctx, chatId, userId);
    if (seat === null || seat.removedAt !== undefined) {
      return { ok: false, error: "They're not in this chat." };
    }
    // Stamped rather than deleted, so the class room does not add them back
    // the next time they open Messages. The read marker stays, so adding them
    // back picks up where they left off.
    await ctx.db.patch(seat._id, { removedAt: Date.now() });
    return { ok: true, error: null };
  },
});

/**
 * One chat: its header, members, and the most recent 300 messages (pinned ones
 * included in place). Only members may read it.
 */
export const thread = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const me = await viewer(ctx);
    if (me === null) {
      return { ok: false, chat: null, messages: [], readOnly: false };
    }
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) {
      return { ok: false, chat: null, messages: [], readOnly: false };
    }
    const chat = access.chat;

    const members = await membersOf(ctx, chatId);
    const recent = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_time", (q) => q.eq("chatId", chatId))
      .order("desc")
      .take(300);
    recent.reverse();
    // A frozen thread ends where they left the class.
    const rows = access.readOnly
      ? recent.filter((message) => message.createdAt <= access.cutoff)
      : recent;

    const messages = [];
    for (const message of rows) {
      messages.push({
        id: message._id,
        authorId: message.authorId,
        authorName: message.authorName,
        authorIsStaff: message.authorIsStaff,
        text: message.text,
        createdAt: message.createdAt,
        pinned: message.pinned,
        deletedBy: message.deletedBy ?? null,
        deletedByName: message.deletedByName ?? null,
        attachment: message.attachment ?? null,
        attachmentUrl: message.attachment
          ? await ctx.storage.getUrl(message.attachment.storageId)
          : null,
        gif: message.gif ?? null,
        isMine: message.authorId === me._id,
      });
    }

    return {
      ok: true,
      chat: {
        id: chat._id,
        kind: chat.kind,
        title: titleFor(chat, members, me._id),
        isClassChat: Boolean(chat.classCode),
        classCode: chat.classCode ?? null,
        createdByName: chat.createdByName,
        members: members.map((m) => ({
          id: m.userId,
          name: m.name,
          isMe: m.userId === me._id,
        })),
      },
      messages,
      readOnly: access.readOnly,
    };
  },
});


/**
 * Name a chat, or rename it later.
 *
 * Anyone in the chat can do it, and the name is shared: it is one thread, so a
 * rename shows for everyone in it. A private conversation with no name falls
 * back to the other person's name.
 */
export const rename = mutation({
  args: { chatId: v.id("chats"), title: v.string() },
  handler: async (
    ctx,
    { chatId, title },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) return { ok: false, error: "You are not in this chat." };
    if (access.readOnly) {
      return { ok: false, error: "This room is read-only now." };
    }
    const chat = access.chat;

    const clean = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!clean && chat.kind === "group") {
      return { ok: false, error: "Give the group a name." };
    }
    await ctx.db.patch(chatId, { title: clean });
    return { ok: true, error: null };
  },
});

/**
 * Delete a chat.
 *
 * A student deletes it for themselves: it leaves their list and their reading
 * of it, while everyone else keeps chatting — and it comes back by itself if
 * somebody posts again. A teacher or the admin deletes the chat for everybody,
 * messages and files included, so the same action can't quietly wipe a class's
 * history for other people.
 */
export const remove = mutation({
  args: { chatId: v.id("chats") },
  handler: async (
    ctx,
    { chatId },
  ): Promise<{ ok: boolean; error: string | null; global: boolean }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, error: "Sign in first.", global: false };
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) {
      return { ok: false, error: "You are not in this chat.", global: false };
    }

    if (!(await staffForChat(ctx, me._id, access.chat.classCode ?? null))) {
      const seat = await membership(ctx, chatId, me._id);
      if (seat === null) {
        return { ok: false, error: "You are not in this chat.", global: false };
      }
      await ctx.db.patch(seat._id, { hiddenAt: Date.now() });
      return { ok: true, error: null, global: false };
    }

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
    return { ok: true, error: null, global: true };
  },
});

const LINK_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** The web links in a message, with trailing punctuation trimmed. */
function linksIn(text: string): string[] {
  const matches = text.match(LINK_PATTERN) ?? [];
  return [
    ...new Set(matches.map((url) => url.replace(/[.,;:!?)\]]+$/, ""))),
  ];
}

/**
 * Everything the chat's detail panel shows: who is in it, every file that has
 * been sent (so videos and recordings can be found again without scrolling),
 * and every link anyone has posted.
 */
export const details = query({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, chat: null, members: [], media: [], links: [] };
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) return { ok: false, chat: null, members: [], media: [], links: [] };
    const chat = access.chat;

    const members = await membersOf(ctx, chatId);
    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_chat_time", (q) => q.eq("chatId", chatId))
      .collect();

    const media = [];
    const links = new Map<
      string,
      { url: string; authorName: string; createdAt: number }
    >();

    // Newest first, so the panel opens on the latest recording or link.
    for (let index = rows.length - 1; index >= 0; index--) {
      const message = rows[index];
      if (message.deletedBy) continue;
      // Nothing after the class change either — the same cutoff as the thread.
      if (access.readOnly && message.createdAt > access.cutoff) continue;
      if (message.attachment) {
        media.push({
          id: message._id,
          name: message.attachment.name,
          mimeType: message.attachment.mimeType,
          size: message.attachment.size,
          url: await ctx.storage.getUrl(message.attachment.storageId),
          authorName: message.authorName,
          createdAt: message.createdAt,
        });
      }
      for (const url of linksIn(message.text)) {
        if (!links.has(url)) {
          links.set(url, {
            url,
            authorName: message.authorName,
            createdAt: message.createdAt,
          });
        }
      }
    }

    return {
      ok: true,
      chat: {
        id: chat._id,
        kind: chat.kind,
        title: titleFor(chat, members, me._id),
        /** Empty when a single chat has no custom name of its own. */
        name: chat.title,
        isClassChat: Boolean(chat.classCode),
        createdByName: chat.createdByName,
        createdAt: chat.createdAt,
      },
      members: members.map((member) => ({
        id: member.userId,
        name: member.name,
        isMe: member.userId === me._id,
      })),
      media: media.slice(0, 200),
      links: [...links.values()],
      /** Frozen after a class change: nothing here may be changed. */
      readOnly: access.readOnly,
    };
  },
});

/** Post a message (text, a file, or both) to a chat the account is in. */
export const send = mutation({
  args: {
    chatId: v.id("chats"),
    text: v.string(),
    attachment: v.optional(
      v.object({
        storageId: v.id("_storage"),
        name: v.string(),
        mimeType: v.string(),
        size: v.number(),
      }),
    ),
    /** A GIF chosen in the picker, whose media lives on GIPHY's servers. */
    gif: v.optional(
      v.object({
        url: v.string(),
        previewUrl: v.string(),
        width: v.number(),
        height: v.number(),
        alt: v.string(),
      }),
    ),
  },
  handler: async (
    ctx,
    { chatId, text, attachment, gif },
  ): Promise<{ ok: boolean; error: string | null }> => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false, error: "Sign in first." };
    const access = await chatAccess(ctx, chatId, me);
    if (access === null) return { ok: false, error: "You are not in this chat." };
    if (access.readOnly) {
      return {
        ok: false,
        error: "You've moved to another class, so this room is read-only now.",
      };
    }
    const chat = access.chat;

    const trimmed = text.trim().slice(0, MAX_MESSAGE);
    if (!trimmed && !attachment && !gif) {
      return { ok: false, error: "Write something or attach a file." };
    }
    if (gif && (!isGiphyUrl(gif.url) || !isGiphyUrl(gif.previewUrl))) {
      return { ok: false, error: "That GIF isn't one GIPHY served." };
    }

    const now = Date.now();
    const isStaff = await staffForChat(ctx, me._id, chat.classCode ?? null);
    // What the chat list and the notification show for this message.
    const preview = trimmed
      ? trimmed.slice(0, 140)
      : attachment
        ? `📎 ${attachment.name}`
        : "🎞️ GIF";
    await ctx.db.insert("chatMessages", {
      chatId,
      authorId: me._id,
      authorName: displayName(me),
      authorIsStaff: isStaff,
      text: trimmed,
      createdAt: now,
      pinned: false,
      ...(attachment ? { attachment } : {}),
      ...(gif ? { gif } : {}),
    });
    await ctx.db.patch(chatId, {
      lastMessageAt: now,
      lastMessageText: preview,
      lastMessageAuthor: displayName(me),
    });

    // Notify everyone else in the chat. Scheduled, so the message is already
    // saved before the push is attempted — a delivery problem can't lose it.
    await ctx.scheduler.runAfter(0, internal.pushSend.send, {
      chatId,
      excludeUserId: me._id,
      title: chat.title.trim() || displayName(me),
      body: chat.title.trim() ? `${displayName(me)}: ${preview}` : preview,
      url: `/dashboard/messages?chat=${chatId}`,
    });
    // The sender has seen their own message.
    const marker = await ctx.db
      .query("chatReads")
      .withIndex("by_chat_user", (q) =>
        q.eq("chatId", chatId).eq("userId", me._id),
      )
      .unique();
    if (marker === null) {
      await ctx.db.insert("chatReads", {
        chatId,
        userId: me._id,
        lastReadAt: now,
      });
    } else {
      await ctx.db.patch(marker._id, { lastReadAt: now });
    }

    return { ok: true, error: null };
  },
});

/** Mark a chat read up to its newest message. */
export const markRead = mutation({
  args: { chatId: v.id("chats") },
  handler: async (ctx, { chatId }) => {
    const me = await viewer(ctx);
    if (me === null) return;
    if ((await membership(ctx, chatId, me._id)) === null) return;
    const chat = await ctx.db.get(chatId);
    if (chat === null) return;

    const marker = await ctx.db
      .query("chatReads")
      .withIndex("by_chat_user", (q) =>
        q.eq("chatId", chatId).eq("userId", me._id),
      )
      .unique();
    if (marker === null) {
      await ctx.db.insert("chatReads", {
        chatId,
        userId: me._id,
        lastReadAt: chat.lastMessageAt,
      });
    } else if (marker.lastReadAt < chat.lastMessageAt) {
      await ctx.db.patch(marker._id, { lastReadAt: chat.lastMessageAt });
    }
  },
});

/** Pin or unpin a message — staff only. */
export const setPinned = mutation({
  args: { messageId: v.id("chatMessages"), pinned: v.boolean() },
  handler: async (ctx, { messageId, pinned }) => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false };
    const message = await ctx.db.get(messageId);
    if (message === null) return { ok: false };
    if ((await membership(ctx, message.chatId, me._id)) === null) {
      return { ok: false };
    }
    const chat = await ctx.db.get(message.chatId);
    if (!(await staffForChat(ctx, me._id, chat?.classCode ?? null))) {
      return { ok: false };
    }
    await ctx.db.patch(messageId, { pinned });
    return { ok: true };
  },
});

/**
 * Soft-delete a message: the author may remove their own, staff may remove
 * anyone's. The content (and any attachment) is cleared, a tombstone stays.
 */
export const removeMessage = mutation({
  args: { messageId: v.id("chatMessages") },
  handler: async (ctx, { messageId }) => {
    const me = await viewer(ctx);
    if (me === null) return { ok: false };
    const message = await ctx.db.get(messageId);
    if (message === null) return { ok: false };
    if ((await membership(ctx, message.chatId, me._id)) === null) {
      return { ok: false };
    }
    const messageChat = await ctx.db.get(message.chatId);
    const staff = await staffForChat(ctx, me._id, messageChat?.classCode ?? null);
    const mine = message.authorId === me._id;
    if (!mine && !staff) return { ok: false };

    if (message.attachment !== undefined) {
      await ctx.storage.delete(message.attachment.storageId);
    }
    await ctx.db.patch(messageId, {
      text: "",
      pinned: false,
      deletedBy: mine ? "author" : "staff",
      deletedByName: displayName(me),
      attachment: undefined,
      gif: undefined,
    });
    return { ok: true };
  },
});

/** A one-time URL the browser POSTs a file to (Convex file storage). */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});
