import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

// The four marks a class day can carry. `away` is a student telling the
// teacher in advance that they can't come, which is not the same as an
// absence the teacher recorded.
const attendanceStatusValidator = v.union(
  v.literal("present"),
  v.literal("late"),
  v.literal("absent"),
  v.literal("away"),
);

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove

      // Whether the account signed up as a teacher or a student. Recorded by
      // the password provider at sign-up (see convex/auth/password.ts) so the
      // server can decide who may list every class in the school.
      classRole: v.optional(
        v.union(v.literal("teacher"), v.literal("student")),
      ),

      // Stamped once the account has a real full name on it — at sign-up, or
      // later from the "What's your name?" card (see convex/names.ts).
      // Accounts created before full names were collected don't have it, which
      // is exactly what that card looks for.
      fullNameSet: v.optional(v.boolean()),

      // Set at sign-up and cleared once the guided tour has been seen (or
      // skipped), so the walkthrough is offered exactly once per account.
      // Missing on older accounts, which therefore never see it.
      tourPending: v.optional(v.boolean()),
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    // Plain-text copy of each account's password, captured server-side when
    // the account is created (see convex/auth/password.ts). Only the
    // admin-credential-gated functions in convex/admin.ts ever read it.
    savedPasswords: defineTable({
      username: v.string(), // normalized (lowercase) account identifier
      password: v.string(),
      updatedAt: v.number(),
    }).index("by_username", ["username"]),

    // Google Drive OAuth tokens, one row per user. Only the Drive actions in
    // convex/drive.ts read these, and they are never returned to a client.
    driveTokens: defineTable({
      userId: v.id("users"),
      accessToken: v.string(),
      refreshToken: v.string(),
      /** Unix ms at which the access token expires. */
      expiresAt: v.number(),
      scope: v.string(),
      /** Google account the drive belongs to, for display only. */
      email: v.optional(v.string()),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // The class vault's own Google Drive — a single connected account that
    // holds every upload the class makes, so files belong to one archive
    // instead of scattering across personal Drives. `key` is always "vault";
    // only the built-in admin may connect it. Tokens never reach a client.
    vaultDriveTokens: defineTable({
      key: v.string(),
      accessToken: v.string(),
      refreshToken: v.string(),
      expiresAt: v.number(),
      scope: v.string(),
      /** Google account that owns the class archive, for display. */
      email: v.optional(v.string()),
      /** Account that connected it. */
      connectedBy: v.optional(v.id("users")),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // Admin-area unlocks, one row per account, written when the admin
    // credentials are entered. They used to live only in that browser's
    // localStorage, so losing browser storage looked like admin powers being
    // taken away; keeping the grant on the deployment makes it survive a new
    // device, a cleared browser, or a storage quota that had filled up.
    adminUnlocks: defineTable({
      userId: v.id("users"),
      grantedAt: v.number(),
      expiresAt: v.number(),
    }).index("by_user", ["userId"]),

    // Short-lived, opaque media links. A player URL cannot carry a Google
    // access token (it would hand the class archive's credentials to anyone
    // who saw the link), so playback goes through the Convex site with one of
    // these instead.
    mediaGrants: defineTable({
      token: v.string(),
      fileId: v.string(),
      /** Whose stored Drive token can read the file; null = the class vault. */
      ownerUserId: v.optional(v.id("users")),
      expiresAt: v.number(),
      createdAt: v.number(),
    }).index("by_token", ["token"]),

    // One-time OAuth state rows. The Drive callback is an HTTP action with no
    // session, so the user identity is carried here (keyed by a random nonce)
    // rather than trusted from the client.
    driveStates: defineTable({
      nonce: v.string(),
      userId: v.id("users"),
      returnTo: v.string(),
      origin: v.optional(v.string()),
      /** "vault" when connecting the class archive, "personal" otherwise. */
      mode: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_nonce", ["nonce"]),

    // Files this app has uploaded to the user's Google Drive, so they can be
    // listed and deleted again (the app only manages what it created).
    driveFiles: defineTable({
      userId: v.id("users"),
      fileId: v.string(),
      name: v.string(),
      mimeType: v.string(),
      size: v.optional(v.number()),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    // Classes. A teacher creates one and gets a six-character
    // join code; students must enter that code to create an account, so each
    // account belongs to exactly one class.
    classes: defineTable({
      /** Six-character join code (uppercase alphanumerics). */
      code: v.string(),
      name: v.string(),
      ownerId: v.id("users"),
      ownerName: v.string(),
      createdAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_owner", ["ownerId"]),

    // Attendance marks, one row per class, class day, and person. They live
    // here (not in a browser) so a teacher's marks and a student's "not
    // attending" note are the same sheet on every device.
    attendanceMarks: defineTable({
      /** Join code of the class the mark belongs to. */
      code: v.string(),
      /** Class day, as YYYY-MM-DD. */
      date: v.string(),
      /** The person's name as it appears on the sheet. */
      name: v.string(),
      status: attendanceStatusValidator,
      /** Account that recorded the mark. */
      markedBy: v.string(),
      updatedAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_code_and_date", ["code", "date"]),

    // Practice sessions, one row per session. They live here rather than in a
    // browser so a teacher can see every student's log on any device — the
    // same reason attendance marks moved here.
    practiceEntries: defineTable({
      /** Join code of the class the session belongs to. */
      code: v.string(),
      /** Account that logged it. */
      authorId: v.id("users"),
      /** Display name at the time, so a class list needs no account reads. */
      authorName: v.string(),
      /** Practice date, YYYY-MM-DD. */
      date: v.string(),
      minutes: v.number(),
      item: v.string(),
      createdAt: v.number(),
      /**
       * The browser-side id an older local entry was imported from, so the
       * one-time import can never insert the same session twice.
       */
      clientId: v.optional(v.string()),
    })
      .index("by_code", ["code"])
      .index("by_code_and_date", ["code", "date"])
      .index("by_client", ["clientId"]),

    // Media the whole class can see. A row is metadata only — the bytes live
    // in the uploader's Google Drive (`driveFileId`), which is why only
    // Drive-backed uploads are listed here: a browser-local file can never be
    // opened on another person's device. Class members open a file with their
    // own Drive token, granted read access on demand by the owner.
    vaultMedia: defineTable({
      /** Join code of the class this upload belongs to. */
      code: v.string(),
      kind: v.union(v.literal("audio"), v.literal("video")),
      title: v.string(),
      mimeType: v.string(),
      /** Google Drive file id — playback resolves a URL on demand. */
      driveFileId: v.string(),
      /**
       * Which Drive holds the bytes: the class archive ("vault") or the
       * uploader's own Drive ("uploader", and the default for uploads from
       * before the class archive was connected).
       */
      owner: v.optional(v.union(v.literal("vault"), v.literal("uploader"))),
      /** Account that uploaded it; only they (or staff) may rename or delete. */
      uploaderId: v.id("users"),
      uploaderName: v.string(),
      /** Practice/rehearsal date, YYYY-MM-DD. */
      date: v.string(),
      createdAt: v.number(),
    })
      .index("by_code", ["code"])
      .index("by_drive_file", ["driveFileId"])
      .index("by_uploader", ["uploaderId"]),

    // Students a teacher added to a class by name (people without an account
    // yet). Also shared, so everyone in the class sees the same sheet.
    classStudents: defineTable({
      /** Join code of the class. */
      code: v.string(),
      name: v.string(),
      /** Account that added the name. */
      addedBy: v.string(),
      addedAt: v.number(),
    }).index("by_code", ["code"]),

    // Which class each account belongs to. Students join one class with a
    // code; a teacher owns classes instead and needs no membership row. A
    // teacher can switch into any class (see classes.allClasses), so a
    // membership row is what a teacher is *in*, not what they may see.
    classMembers: defineTable({
      userId: v.id("users"),
      code: v.string(),
      className: v.string(),
      joinedAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_code", ["code"]),

    // Chats. A teacher or the admin can start a group chat with any mix of
    // people — classes are not a boundary here — or a solo conversation with
    // one person. Every class also gets one room of its own (`classCode`), so
    // students keep the class thread they had before. Messages live in the
    // deployment rather than a browser, so they reach every device and are
    // still there after a redeploy.
    chats: defineTable({
      kind: v.union(v.literal("group"), v.literal("solo")),
      /** Group name. Empty for a solo conversation (the other person is). */
      title: v.string(),
      /** Join code of the class whose room this is, if it is one. */
      classCode: v.optional(v.string()),
      createdBy: v.id("users"),
      createdByName: v.string(),
      createdAt: v.number(),
      /** Newest message, denormalised so the chat list needs one read. */
      lastMessageAt: v.number(),
      lastMessageText: v.string(),
      lastMessageAuthor: v.string(),
      /** Canonical key for a two-person chat, so it is never duplicated. */
      soloKey: v.optional(v.string()),
    })
      .index("by_class", ["classCode"])
      .index("by_solo_key", ["soloKey"])
      .index("by_last_message", ["lastMessageAt"]),

    chatMembers: defineTable({
      chatId: v.id("chats"),
      userId: v.id("users"),
      /** Name at the time they joined, so the list needs no account reads. */
      name: v.string(),
      joinedAt: v.number(),
      /**
       * Set when this account moved to another class: it keeps its class
       * room, but the thread stops at this moment — history stays readable,
       * nothing new arrives (see chatAccess in convex/chats.ts).
       */
      leftAt: v.optional(v.number()),
      /**
       * When this person deleted the chat for themselves. The chat leaves
       * their list without touching anyone else's, and comes back if somebody
       * posts again after this moment.
       */
      hiddenAt: v.optional(v.number()),
      /**
       * Set when staff took this person out of the chat. The row stays so a
       * class room cannot quietly add them back the next time they open
       * Messages (see ensureRoom in convex/chats.ts); adding them again
       * clears it.
       */
      removedAt: v.optional(v.number()),
    })
      .index("by_chat", ["chatId"])
      .index("by_user", ["userId"])
      .index("by_chat_user", ["chatId", "userId"]),

    chatMessages: defineTable({
      chatId: v.id("chats"),
      authorId: v.id("users"),
      authorName: v.string(),
      /** Whether the sender was staff when they sent it (for the styling). */
      authorIsStaff: v.boolean(),
      text: v.string(),
      createdAt: v.number(),
      /** Staff can pin a message to the top of the thread. */
      pinned: v.boolean(),
      /** File in Convex file storage, readable by everyone in the chat. */
      attachment: v.optional(
        v.object({
          storageId: v.id("_storage"),
          name: v.string(),
          mimeType: v.string(),
          size: v.number(),
        }),
      ),
      /**
       * A GIF picked from GIPHY. Its media URLs are stored (not a copy of the
       * animation), so the bubble loads it from GIPHY like the picker does.
       */
      gif: v.optional(
        v.object({
          url: v.string(),
          previewUrl: v.string(),
          width: v.number(),
          height: v.number(),
          alt: v.string(),
        }),
      ),
      /** Set on soft delete (tombstone stays in the thread). */
      deletedBy: v.optional(
        v.union(v.literal("author"), v.literal("staff")),
      ),
      deletedByName: v.optional(v.string()),
    }).index("by_chat_time", ["chatId", "createdAt"]),

    /** Per-person read marker, so the chat list can show unread counts. */
    chatReads: defineTable({
      chatId: v.id("chats"),
      userId: v.id("users"),
      lastReadAt: v.number(),
    })
      .index("by_chat_user", ["chatId", "userId"])
      .index("by_user", ["userId"]),

    /**
     * A live call in a chat. One row per call: it is created when somebody
     * starts one (so everyone else gets a banner and a notification) and
     * stamped with `endedAt` when the last person leaves. The audio and video
     * themselves never touch the database — they go through LiveKit.
     */
    calls: defineTable({
      chatId: v.id("chats"),
      /** Room name in LiveKit, derived from the chat id by callState.ts. */
      roomName: v.string(),
      startedBy: v.id("users"),
      startedByName: v.string(),
      startedAt: v.number(),
      /** Last time somebody in the room said they were still there. A call is
       * only shown as live while this is recent. */
      heartbeatAt: v.number(),
      endedAt: v.optional(v.number()),
    }).index("by_chat_started", ["chatId", "startedAt"]),

    /**
     * One browser/device that agreed to receive chat notifications. The keys
     * are the Web Push subscription's encryption keys; nothing here can be
     * used to read a message, only to deliver an encrypted notification.
     */
    pushSubscriptions: defineTable({
      userId: v.id("users"),
      endpoint: v.string(),
      p256dh: v.string(),
      auth: v.string(),
      userAgent: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_endpoint", ["endpoint"]),

    // Deployment-wide feature switches (single-row table).
    settings: defineTable({
      // Key for the feature the row describes, e.g. "practiceLog".
      key: v.string(),
      // Whether the feature is available to every user.
      enabled: v.boolean(),
      updatedAt: v.number(),
    }).index("by_key", ["key"]),

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
