/**
 * Checks the class-access rule for the three kinds of account, in the two
 * states a deployment can be in:
 *
 *   1. before the backfill — no `studioMembers` rows, classes with no
 *      `studioId`. This is the window right after deploying the studio code,
 *      and it must not lock anybody out of the class they already use.
 *   2. after the backfill — every account and class has its studio, and a
 *      teacher of one studio must not reach another studio's class.
 *
 * The rule itself is imported from src/convex/studios.ts, not re-implemented
 * here, so this checks the code that ships. The database is a tiny in-memory
 * stand-in for `ctx.db`.
 *
 *   node --experimental-strip-types scripts/check-studio-access.ts
 *   (or: npx esbuild scripts/check-studio-access.ts --bundle --platform=node \
 *          --format=esm --packages=external --outfile=/tmp/check.mjs && node /tmp/check.mjs)
 */
import { classAccess, legacyStaff, scopeFor } from "../src/convex/studios";

type Row = Record<string, unknown> & { _id: string };

/** Just enough of Convex's query builder for the code under test. */
class Table {
  private rows: Row[];
  constructor(rows: Row[]) {
    this.rows = rows;
  }
  withIndex(_name: string, build: (q: unknown) => unknown): Table {
    const conditions: [string, unknown][] = [];
    const eq = (field: string, value: unknown): unknown => {
      conditions.push([field, value]);
      return { eq };
    };
    build({ eq });
    return new Table(
      this.rows.filter((row) =>
        conditions.every(([field, value]) => row[field] === value),
      ),
    );
  }
  first(): Promise<Row | null> {
    return Promise.resolve(this.rows[0] ?? null);
  }
  unique(): Promise<Row | null> {
    return Promise.resolve(this.rows.length === 1 ? this.rows[0] : null);
  }
  collect(): Promise<Row[]> {
    return Promise.resolve(this.rows);
  }
}

class FakeDb {
  tables: Record<string, Row[]>;
  constructor(tables: Record<string, Row[]>) {
    this.tables = tables;
  }
  get(id: string): Promise<Row | null> {
    for (const rows of Object.values(this.tables)) {
      const found = rows.find((row) => row._id === id);
      if (found) return Promise.resolve(found);
    }
    return Promise.resolve(null);
  }
  query(name: string): Table {
    return new Table(this.tables[name] ?? []);
  }
}

function ctxWith(tables: Record<string, Row[]>) {
  return { db: new FakeDb(tables) } as unknown as Parameters<
    typeof classAccess
  >[0];
}

const USERS = {
  teacherA: { _id: "u_teacherA", name: "Teacher A", classRole: "teacher", email: "teachera" },
  teacherB: { _id: "u_teacherB", name: "Teacher B", classRole: "teacher", email: "teacherb" },
  studentA: { _id: "u_studentA", name: "Student A", classRole: "student", email: "studenta" },
  studentB: { _id: "u_studentB", name: "Student B", classRole: "student", email: "studentb" },
  admin: { _id: "u_admin", name: "admin", email: "admin" },
};

const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label} → ${a}`);
  } else {
    console.log(`  FAIL ${label} → ${a}, expected ${e}`);
    failures.push(label);
  }
}

async function preBackfill() {
  console.log("\nbefore the backfill (no studio rows, no class has a studio)");
  // Exactly what a deployment looks like the moment the code lands.
  const ctx = ctxWith({
    users: Object.values(USERS),
    studios: [],
    studioMembers: [],
    classes: [
      { _id: "c_A", code: "AAA111", name: "Class A", ownerId: "u_teacherA", studioId: undefined },
      { _id: "c_B", code: "BBB222", name: "Class B", ownerId: "u_teacherB", studioId: undefined },
    ],
    classMembers: [
      { _id: "m_A", userId: "u_studentA", code: "AAA111" },
      { _id: "m_B", userId: "u_studentB", code: "BBB222" },
    ],
  });
  const classA = (await ctx.db.get("c_A"))!;
  const classB = (await ctx.db.get("c_B"))!;

  check("teacherA scope", await scopeFor(ctx, "u_teacherA"), null);
  check("teacherA legacy staff", await legacyStaff(ctx, "u_teacherA"), true);
  check("teacherA on their class", await classAccess(ctx, "u_teacherA", classA), {
    read: true,
    staff: true,
    platform: false,
  });
  check("studentA on their class", await classAccess(ctx, "u_studentA", classA), {
    read: true,
    staff: false,
    platform: false,
  });
  check("studentA on the other class", await classAccess(ctx, "u_studentA", classB), {
    read: false,
    staff: false,
    platform: false,
  });
  check("admin on any class", await classAccess(ctx, "u_admin", classB), {
    read: true,
    staff: true,
    platform: true,
  });
}

async function postBackfill() {
  console.log("\nafter the backfill (two studios, every class and account placed)");
  const ctx = ctxWith({
    users: Object.values(USERS),
    studios: [
      { _id: "s_A", code: "STU111", name: "Studio A", folderName: "nvstudioa" },
      { _id: "s_B", code: "STU222", name: "Studio B", folderName: "nvstudiob" },
    ],
    studioMembers: [
      { _id: "sm_1", studioId: "s_A", userId: "u_teacherA", role: "owner" },
      { _id: "sm_2", studioId: "s_B", userId: "u_teacherB", role: "teacher" },
      { _id: "sm_3", studioId: "s_A", userId: "u_studentA", role: "student" },
      { _id: "sm_4", studioId: "s_B", userId: "u_studentB", role: "student" },
    ],
    classes: [
      { _id: "c_A", code: "AAA111", name: "Class A", ownerId: "u_teacherA", studioId: "s_A" },
      { _id: "c_B", code: "BBB222", name: "Class B", ownerId: "u_teacherB", studioId: "s_B" },
    ],
    classMembers: [
      { _id: "m_A", userId: "u_studentA", code: "AAA111" },
      { _id: "m_B", userId: "u_studentB", code: "BBB222" },
    ],
  });
  const classA = (await ctx.db.get("c_A"))!;
  const classB = (await ctx.db.get("c_B"))!;

  check("teacherA scope", await scopeFor(ctx, "u_teacherA"), {
    kind: "studio",
    studioId: "s_A",
    role: "owner",
  });
  check("teacherA on their studio's class", await classAccess(ctx, "u_teacherA", classA), {
    read: true,
    staff: true,
    platform: false,
  });
  check("teacherA on another studio's class", await classAccess(ctx, "u_teacherA", classB), {
    read: false,
    staff: false,
    platform: false,
  });
  check("teacherB on another studio's class", await classAccess(ctx, "u_teacherB", classA), {
    read: false,
    staff: false,
    platform: false,
  });
  check("studentA on their class", await classAccess(ctx, "u_studentA", classA), {
    read: true,
    staff: false,
    platform: false,
  });
  check("studentA on another studio's class", await classAccess(ctx, "u_studentA", classB), {
    read: false,
    staff: false,
    platform: false,
  });
  check("admin on every class", [
    await classAccess(ctx, "u_admin", classA),
    await classAccess(ctx, "u_admin", classB),
  ], [
    { read: true, staff: true, platform: true },
    { read: true, staff: true, platform: true },
  ]);
}

await preBackfill();
await postBackfill();

console.log(
  failures.length === 0
    ? "\nall access checks passed"
    : `\n${failures.length} FAILED: ${failures.join(", ")}`,
);
if (failures.length > 0) process.exit(1);
