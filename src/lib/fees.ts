/**
 * Class fees, as the dashboard sees them.
 *
 * A teacher ticks each student who has paid for a month (convex/fees.ts); the
 * same rows come back to a student, filtered by the server to their own name.
 */
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";

export interface FeeMark {
  id: string;
  studentName: string;
  /** The month being paid for, as YYYY-MM. */
  month: string;
  paid: boolean;
  markedBy: string;
  updatedAt: number;
}

export function useClassFees(code: string | null): {
  /** False when this account may not read the class. */
  ok: boolean;
  fees: FeeMark[];
  isLoading: boolean;
} {
  const data = useQuery(api.fees.classFees, code ? { code } : "skip");
  return {
    ok: data?.ok ?? false,
    fees: data?.fees ?? [],
    isLoading: code !== null && data === undefined,
  };
}

/** The month a date falls in, as `YYYY-MM` (local time, not UTC). */
export function monthKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** Move a `YYYY-MM` month by a number of months. */
export function shiftMonth(month: string, delta: number): string {
  const [year, number] = month.split("-").map(Number);
  return monthKey(new Date(year, number - 1 + delta, 1));
}

/** "November 2026" for a `YYYY-MM` month. */
export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return new Date(year, number - 1, 1).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}
