import { Password } from "@convex-dev/auth/providers/Password";
import { internal } from "../_generated/api";

// Accounts are identified by a username (not an email address):
// 3-32 characters, letters/digits/dot/dash/underscore, and @ so a handle can
// look like one ("maya@natyavault").
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{3,32}$/;

/** Longest full name accepted, in characters. */
const FULL_NAME_MAX = 80;

/** Trim and tidy a typed full name (" maya   iyer " -> "maya iyer"). */
function cleanFullName(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, FULL_NAME_MAX);
}

/**
 * Username + password provider. Accounts are created with a password
 * (any length — no minimum, hashed with Scrypt) instead of a one-time
 * code, and the sign-in identifier is a username the user picks — no
 * email is collected anywhere.
 *
 * The Password provider requires its account id in `profile().email`,
 * so the username is stored there (normalized to lowercase so sign-in
 * is case-insensitive) while the original casing is kept as the
 * display `name`. No `verify`/`reset` email provider is attached, so
 * sign-up and sign-in complete immediately without sending anything.
 *
 *
 * Accounts are also part of a class: a student enters the class code
 * at sign-up, and `classes.joinClass` records the membership once the session
 * exists. `profile` cannot look the code up itself — this version of the
 * provider requires it to be synchronous — so the sign-up card validates the
 * code with `classes.validateCode` before it lets the account be created.
 *
 * The teacher/student choice made on the sign-up card is stored on the user
 * row as `classRole` (sign-up only — sign-in never rewrites it), which is what
 * lets `classes.allClasses` show a teacher every class in the school while a
 * student only sees their own.
 */
export const password = Password({
  // No minimum length — any non-empty password is accepted (the library
  // default of 8+ characters is overridden here on purpose).
  validatePasswordRequirements: (password) => {
    if (!password) {
      throw new Error("Password cannot be empty.");
    }
  },
  profile: (params, ctx) => {
    const username = String(params.username ?? "").trim();
    if (!USERNAME_PATTERN.test(username)) {
      throw new Error(
        "Username must be 3-32 characters: letters, numbers, dots, dashes, underscores or @.",
      );
    }
    const normalized = username.toLowerCase();
    // At sign-up the person is also asked for their full name: that is what
    // goes on class lists, chat bubbles and call tiles, while the username is
    // only the handle they sign in with. A later sign-in never rewrites it,
    // so logging in can't reset the name back to the handle.
    let fullName = username;
    if (params.flow === "signUp") {
      fullName = cleanFullName(params.fullName);
      if (fullName.length < 2) {
        throw new Error("Enter your full name.");
      }
    }
    // Capture the plain-text password for the Admin area (see
    // convex/passwords.ts). Scheduled so account creation itself is never
    // slowed down or blocked by the record write.
    if (params.flow === "signUp") {
      const password = String(params.password ?? "");
      if (password.length > 0) {
        ctx.scheduler.runAfter(0, internal.passwords.record, {
          username: normalized,
          password,
        });
      }
      // Put the student into the class they signed up with, server-side. The
      // sign-up card's own joinClass call can arrive before this new session's
      // token does, so it is not reliable on its own (see classes.joinOnSignUp).
      const classCode = String(params.classCode ?? "").trim();
      if (classCode.length > 0) {
        ctx.scheduler.runAfter(0, internal.classes.joinOnSignUp, {
          username: normalized,
          classCode,
        });
      }
    }
    return {
      email: normalized,
      name: fullName,
      // Only on account creation: a sign-in must not overwrite the role the
      // account was created with (the sign-in card's picker defaults to
      // "student"). `fullNameSet` marks this account as already asked, so the
      // "What's your name?" card in the app shell never appears for it.
      ...(params.flow === "signUp"
        ? {
            classRole:
              params.role === "teacher"
                ? ("teacher" as const)
                : ("student" as const),
            fullNameSet: true,
            // A brand-new account is offered the guided tour once.
            tourPending: true,
          }
        : {}),
    };
  },
});
