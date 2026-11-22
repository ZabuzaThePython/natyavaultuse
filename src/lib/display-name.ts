/**
 * Names are stored whole ("Meera Krishnan"), but most screens show only the
 * first name — a class roll, a leaderboard and a message header read better
 * that way. The account block at the bottom of the sidebar keeps the full name
 * (and the email), since that is where the signed-in account is identified.
 *
 * Two dancers can share a first name, so `shortNames` adds the last name's
 * initial for each of them ("Meera K." and "Meera R.") whenever the set it is
 * given contains a clash.
 */

function words(name: string): string[] {
  return name.trim().split(/\s+/).filter(Boolean);
}

/** The first word of a display name: "Meera Krishnan" -> "Meera". */
export function firstName(name: string): string {
  return words(name)[0] ?? name.trim();
}

/** The initial of the last word: "Meera Krishnan" -> "K". */
export function lastInitial(name: string): string {
  const parts = words(name);
  const last = parts[parts.length - 1] ?? "";
  return (Array.from(last)[0] ?? "").toUpperCase();
}

/**
 * A single name, shortened. `company` is everyone it is shown beside, so a
 * repeated first name picks up its last initial and a unique one does not.
 */
export function shortName(
  name: string,
  company: readonly string[] = [],
): string {
  const first = firstName(name);
  const key = first.toLowerCase();
  const clash = company.some(
    (other) => other !== name && firstName(other).toLowerCase() === key,
  );
  // A one-word name has no surname to borrow an initial from.
  if (!clash || words(name).length < 2) return first;
  const initial = lastInitial(name);
  return initial ? `${first} ${initial}.` : first;
}

/** Shortened names for a list, keyed by the full name it was built from. */
export function shortNames(names: readonly string[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const name of names) labels.set(name, shortName(name, names));
  return labels;
}

/**
 * A conversation title, shortened when it is only the members' names — what the
 * deployment stores for a chat nobody has renamed ("Ananya, Riya", or the
 * cut-down "Ananya, Riya, Meera + 2"). A title someone typed is left alone.
 */
export function shortChatTitle(
  title: string,
  members: readonly string[],
): string {
  const trimmed = title.trim();
  if (members.length === 0 || trimmed === "") return title;
  if (members.includes(trimmed)) return shortName(trimmed, members);

  const parts = trimmed.split(",").map((part) => part.trim());
  const tail = parts[parts.length - 1] ?? "";
  const counted = tail.match(/^(.*?)\s*\+\s*(\d+)$/);
  const suffix = counted ? ` + ${counted[2]}` : "";
  const names = counted ? [...parts.slice(0, -1), counted[1]] : parts;
  if (names.length === 0 || !names.every((name) => members.includes(name))) {
    return title;
  }
  return names.map((name) => shortName(name, members)).join(", ") + suffix;
}
