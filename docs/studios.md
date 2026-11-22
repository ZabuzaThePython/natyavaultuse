# Studios: several schools on one deployment

Today the deployment **is** the school. One `classes` table, one teacher role that
sees every class, one class-archive Drive. This document designs the layer above
it — a **studio** — so several schools can share the deployment and see nothing
of each other.

Status: design, not built. Phase 1 is the schema and the scoping rule; the
phases at the end say what each one touches.

## The tenancy boundary

```
studio  ──┬── studioMembers ── users        (owner, teachers, students)
          ├── classes ───────── attendance, practice, vault, chat rooms
          └── vaultDriveTokens (its own Google Drive archive)

platform admin ──── every studio
```

A studio is the tenant. Everything a signed-in person can reach — their class
list, attendance sheets, practice log, media vault, chat rooms — belongs to
exactly one studio, and nothing crosses that line except the platform admin.

```
                      ┌──────────── platform admin ────────────┐
                      │                                         │
              ┌───────┴────────┐                    ┌───────────┴──────┐
              │ studio "Nritya"│                    │ studio "Kalakshetra"│
              ├────────────────┤                    ├─────────────────┤
              │ owner (teacher)│                    │ owner (teacher) │
              │ teachers  [..] │                    │ teachers  [..]  │
              │ classes   [..] │                    │ classes   [..]  │
              │ Drive archive  │                    │ Drive archive   │
              └───────┬────────┘                    └───────────┬─────┘
                 students                          students
```

## Why not put a studio on every table

The seven shared tables — `attendanceMarks`, `practiceEntries`, `vaultMedia`,
`classStudents`, `classMembers`, `chats` (class rooms), and the rest — are all
keyed by a **class join code**, and class codes are already unique deployment
wide (`classes.by_code` is a unique index used by every lookup). A row therefore
already belongs to exactly one class, and the class belongs to one studio.

So the studio is derivable: `row.code → classes → studioId`. Adding a
`studioId` column to seven tables would duplicate that fact and create a new way
for it to be wrong (a row whose studio disagrees with its class). The design puts
the tenant on the two things that own it — `classes` and `users` — and leaves the
rest alone.

The archive Drive is the one thing that needs care, and it stays one connection:
each studio gets a folder inside it (see *Storage* below).

## Schema

Two new tables, two new fields.

```ts
// convex/schema.ts

studios: defineTable({
  /** Six-character code a teacher enters to join; also the studio's handle. */
  code: v.string(),
  name: v.string(),
  /** The teacher who created it. May rename it, add and remove teachers. */
  ownerId: v.id("users"),
  ownerName: v.string(),
  /** Folder in the archive Drive: fixed at creation, `nv` + the name's slug. */
  folderName: v.string(),
  /** Drive folder id, cached the first time an upload creates or adopts it. */
  driveFolderId: v.optional(v.string()),
  /** Closed studios refuse new teacher joins; students are unaffected. */
  joinOpen: v.boolean(),
  /** Set by the platform admin to freeze a studio without deleting it. */
  suspendedAt: v.optional(v.number()),
  createdAt: v.number(),
})
  .index("by_code", ["code"])
  .index("by_owner", ["ownerId"]),

/**
 * Who is in which studio. A row per account, like `classMembers`: a student's
 * row is written when they join a class, a teacher's when they join or found a
 * studio. `by_user` + `.first()` is "my studio" everywhere.
 */
studioMembers: defineTable({
  studioId: v.id("studios"),
  userId: v.id("users"),
  role: v.union(v.literal("owner"), v.literal("teacher"), v.literal("student")),
  name: v.string(),
  joinedAt: v.number(),
})
  .index("by_user", ["userId"])
  .index("by_studio", ["studioId"])
  .index("by_studio_user", ["studioId", "userId"]),
```

`classes` gains one field:

```ts
studioId: v.id("studios"),   // the tenant this class belongs to
```

with `.index("by_studio", ["studioId"])`. The existing `by_code` index stays the
unique lookup every shared table uses.

`vaultDriveTokens` does not change: one row, one archive. Studios are separated
by folder inside it, not by a second Google connection.

### Why a table instead of `users.studioId`

A field on `users` would be smaller, but the studio owner needs "list my
teachers" and "remove this teacher", which a field cannot answer without a scan,
and a teacher who leaves one studio for another would silently take their class
ownership with them. `studioMembers` answers both, and it already supports a
person belonging to two studios later without another migration — today
`.by_user … .first()` simply keeps the current "one studio" behaviour.

## The rule that replaces `maySeeEveryClass`

`maySeeEveryClass(ctx, userId)` currently means *the whole deployment*: the admin,
any account with `classRole: "teacher"`, or anybody who owns a class. Five modules
call it (`classes`, `practice`, `attendance`, `vault`, `chats`), plus `drive`.

It becomes one scoped predicate in a new `convex/studios.ts`:

```ts
export type Scope =
  | { kind: "platform" }                                                    // built-in admin
  | { kind: "studio"; studioId: Id<"studios">; role: "owner" | "teacher" }  // staff of one studio
  | { kind: "student"; studioId: Id<"studios"> };

/** What this account may see: platform-wide, staff of a studio, or a student. */
export async function scopeFor(ctx, userId): Promise<Scope | null>;

/**
 * The one class-access rule, replacing the four near-identical copies of
 * `usableClass` in vault.ts, practice.ts, attendance.ts and the checks in
 * classes.ts.
 */
export async function classAccess(ctx, userId, row: Doc<"classes">):
  Promise<{ read: boolean; staff: boolean }>;
```

`classAccess` is:

| viewer | `read` | `staff` |
|---|---|---|
| platform admin | yes | yes |
| teacher/owner **of `row.studioId`** | yes | yes |
| teacher of another studio | no | no |
| student joined to `row.code` | yes | no |
| student of another class or studio | no | no |

Every call site keeps its shape — it already has the class row or code — and the
four copies of `usableClass` collapse into this one function. That is the whole
security change, which is why it should be done first and in one commit.

### Queries that change

| function | today | with studios |
|---|---|---|
| `classes.allClasses` | every class | classes where `studioId = my studio`; every class only for the platform admin |
| `classes.viewerRole` | `{ signedIn, isStaff }` | `{ signedIn, isStaff, studio: { id, name, code } \| null, isPlatformAdmin }` |
| `classes.createClass` | any signed-in account | a teacher/owner of a studio; sets `studioId` |
| `classes.validateCode` | class exists? | class exists **and is active**; also returns the studio name, so the sign-up card can say "Join *Nritya Dance Academy*" |
| `sheetPeople` | keeps `classRole === "teacher"` off the roll | uses the **studio** role for that class's studio, not the account's global one |
| `practice.*`, `attendance.*`, `vault.*` | `usableClass` | `classAccess` |
| `chats.createGroup`, `ensureAllClassChats`, `ensureClassChat` | any class, any person | only people and classes in the caller's studio |
| `drive.viewerManagesClasses` | `maySeeEveryClass` | teacher/owner of a studio (for that studio's archive) |

## Storage: one Drive, one folder per studio (for now)

The archive stays **one Google account** (`vaultDriveTokens`, one row) and each
studio gets a folder in it. `drive.ts` already does exactly this for the single
folder it knows today — `FOLDER_NAME = "NatyaVault"` and `ensureFolder()` at
`drive.ts:729` — so the change is to make that name per studio instead of a
constant:

```ts
export const startUpload = action({
  // The class code is what identifies the studio: same argument the vault page
  // already holds, and the folder is a property of the studio, not the browser.
  args: { name: v.string(), mimeType: v.string(), size: v.number(), code: v.optional(v.string()) },
  …
});

/** `nv` + the studio name with everything but letters and digits dropped. */
function folderNameFor(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
  return `nv${slug || "studio"}`;
}

async function ensureStudioFolder(accessToken: string, studio: Doc<"studios">) {
  if (studio.driveFolderId) return studio.driveFolderId;         // cached
  const id = await ensureFolder(accessToken, studio.folderName); // find by name, else create
  await ctx.runMutation(internal.studios.setFolderId, { studioId: studio._id, folderId: id });
  return id;
}
```

| studio name | folder |
|---|---|
| Shubha School of Arts | `nvshubhaschoolofarts` |
| Natya Manjari | `nvnatyamanjari` |
| (the school that exists today) | `NatyaVault` — the folder already holding its files |

The rules that keep it from going wrong:

- **The name is fixed at creation.** Renaming a studio changes its display name
  only; the folder is looked up by id from then on, so a rename never strands
  files or creates a second folder.
- **Uniqueness is checked on insert** (`studios.folderName`), adding `-2`, `-3`
  when two schools pick the same name.
- **Find-then-create**, not create-always: a folder that already exists (a retry,
  or one the admin made by hand) is adopted rather than duplicated. Two uploads
  racing on a brand-new studio can each create a folder; the first id recorded
  wins and the stray empty folder is harmless — worth a note, not a lock.
- **The existing archive is adopted, not moved.** The school that exists today
  gets `folderName: "NatyaVault"`, which is exactly the folder its files are
  already in, so the backfill moves no bytes.
- **Personal uploads are unchanged**: no `code` (or no class archive connected)
  keeps today's behaviour — the uploader's own Drive.

Playback does not change at all: one token serves every folder, and the
per-class, per-studio check still gates the media grant.

## Later: Cloudflare R2

Going public means other schools' media should not live in one Google account,
so the switch is R2 — and the folder model above maps onto it one to one. Two
additions make the swap a change of one module rather than every caller:

```ts
// schema.ts
vaultMedia: defineTable({
  …,
  /** Which backend holds the bytes. Missing = "drive" (existing rows). */
  storage: v.optional(v.union(v.literal("drive"), v.literal("r2"))),
  /** R2 object key, e.g. studios/<studioId>/<uuid>. */
  objectKey: v.optional(v.string()),
});
```

`convex/mediaStore.ts` holds the three operations the app needs — `uploadUrl`,
`playUrl`, `remove` — with a Drive implementation (today's `drive.ts` code) and an
R2 one behind the same signatures. `studios/folderName` becomes the R2 prefix
(`studios/<studioId>/`) instead of a Drive folder name, `mediaGrants` keeps
gating playback so no signed URL is ever handed to a client that did not pass
`classAccess`, and `pages/MediaVault.tsx` stops calling `drive.*` directly and
calls `media.*`.

## Onboarding

The join code stays the only thing a person types, which keeps the sign-up card
the way it is today.

**Student** — enters a class code. The studio comes from the class, and both the
`classMembers` row and the `studioMembers` row are written in the same server-side
step (`classes.joinOnSignUp`, scheduled from the password provider, exactly as it
works now).

**Teacher** — two paths on the sign-up card:

- *Join a studio*: enter the studio's six-character code → `studioMembers` row with
  role `teacher`.
- *Start a studio*: enter a studio name → `studios` row, owner = them, plus
  `studioMembers` row with role `owner`. They land on an empty studio with a
  "create your first class" card.

The platform admin can flip `joinOpen` off on a studio whose code leaked.

## What the studio owner gets

A **Studio** page (the top of the sidebar, above the class switcher):

- studio name and join code, with a copy button;
- teachers: list, add by username, remove (refused while they still own classes);
- classes: every class in the studio with member counts, create and delete;
- its Drive archive connection status (phase 4).

The existing **Admin** page stays platform-level: it lists studios with member and
class counts, and can suspend one. It never reads a studio's media or messages.

## Migration

`schemaValidation` is `false`, so new fields can be deployed before they are
filled. One admin-gated mutation, `convex/migrations.ts → studiosBackfill`, run
once after deploy, does the work idempotently and reports what it did:

1. If no `studios` row exists, create one: name from a `settings` row
   (`key: "studioName"`) or `"NatyaVault"`, generated unique code, owner = the
   first teacher found (or the built-in admin), `joinOpen: false` — an existing
   school should not hand out its code by accident.
2. Every `classes` row missing `studioId` → the default studio.
3. Every account gets a `studioMembers` row:
   - admin / `classRole: "teacher"` / owns a class → `teacher` (the default studio's
     creator becomes `owner`);
   - otherwise the studio of their `classMembers` class;
   - anybody left over (no class, no role) → `student` of the default studio, and
     counted in the report so the admin can look at them.
4. No Drive work: the existing `NatyaVault` folder in the archive becomes the
   default studio's `folderName`, so its files stay exactly where they are.

Re-running is safe: steps skip rows that already carry the field.

## Consequences worth knowing before we start

1. **One archive, many folders means one account can read every school.** That
   is the deliberate trade for now: one `vaultDriveTokens` row, one folder per
   studio, no per-school Google setup. The isolation between studios is the
   `classAccess` check, not the storage, so whoever controls the archive account
   (or its refresh token) can read every school's media. Acceptable while the
   other studios are yours; moving to R2 before opening up to real schools is
   the right call, and the folder layout already carries over.
2. **Group chats narrow to the studio.** `chats.createGroup` today offers "any mix
   of people"; that list becomes the caller's studio.
3. **Settings stay platform-wide for now.** `practiceLog`, `gifs`, `publicMode`
   are single `settings` rows. Making them per studio is a later, additive change.
4. **Class codes are already globally unique**, so no student can join another
   studio's class by guessing a code, and no code needs to be reissued.
5. **A person is in one studio** to begin with (`.by_user … .first()`). Moving
   studio means leaving the class — the `classMembers` row is replaced, and the
   chat `leftAt`/`hiddenAt` handling already covers the history.
6. **The platform admin still sees everything.** That is deliberate: it is the
   operator account, gated by its own credentials (`adminAuthorized`).

## Phases

| # | Scope | Files | Risk |
|---|---|---|---|
| 1 | Schema, `scopeFor` / `classAccess`, all call sites, backfill | `schema.ts`, new `studios.ts`, `classes.ts`, `practice.ts`, `attendance.ts`, `vault.ts`, `chats.ts`, `drive.ts`, new `migrations.ts` | the security change — done in one commit, reviewed as a whole |
| 2 | Sign-up: teacher studio code / new studio; student code → studio | `auth/password.ts`, `pages/Auth.tsx` | touches account creation, so it needs a fresh-account test |
| 3 | Studio page, teacher management, class list per studio | `pages/Studio.tsx`, `main.tsx`, `components/AppShell.tsx`, `studios.ts` | UI only |
| 4 | Per-studio **folder** in the shared archive; `startUpload` takes the class code; `mediaStore` seam so R2 is one new module | `drive.ts`, new `studios.ts` helper, `schema.ts`, `pages/MediaVault.tsx` | low — one folder per studio, existing archive adopted as-is |
| 5 | Platform admin: studio list, suspend | `admin.ts`, `pages/Admin.tsx` | low |

Phase 1 leaves the app working exactly as it does today with a single studio, so
it can ship on its own.
