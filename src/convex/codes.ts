import type { QueryCtx, MutationCtx } from "./_generated/server";

/**
 * Six-character join codes, shared by classes and studios.
 *
 * Codes are uppercase alphanumerics from an alphabet without the characters
 * that are easy to misread in a classroom (0/O, 1/I/L). They live in this file
 * rather than in `classes.ts` so that `studios.ts` can mint one without
 * importing the module that imports it.
 */

export const CODE_LENGTH = 6;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** Uppercase a typed code and drop anything a code can't contain. */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CODE_LENGTH);
}

function randomChar(): string {
  const bytes = new Uint8Array(1);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes);
  } else {
    bytes[0] = Math.floor(Math.random() * 256);
  }
  return CODE_ALPHABET[bytes[0] % CODE_ALPHABET.length];
}

/** A fresh join code (not checked for collisions). */
export function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += randomChar();
  return code;
}

/** The class a code points at, or null when the code is malformed/unknown. */
export async function findClass(ctx: QueryCtx | MutationCtx, rawCode: unknown) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  return await ctx.db
    .query("classes")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}

/** The studio a code points at, or null when the code is malformed/unknown. */
export async function findStudio(ctx: QueryCtx | MutationCtx, rawCode: unknown) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  return await ctx.db
    .query("studios")
    .withIndex("by_code", (q) => q.eq("code", code))
    .unique();
}
