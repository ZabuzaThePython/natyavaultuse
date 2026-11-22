/**
 * Bridge between the deployment's shared media rows and the vault's client
 * `MediaItem`, so a class upload renders exactly like a file kept in this
 * browser — and both the vault page and the dashboard build the same list.
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { MediaItem } from "@/lib/vault";
import type { FunctionReturnType } from "convex/server";

type ClassMedia = FunctionReturnType<typeof api.vault.classMedia>;

/** One row of the class vault (`convex/vault.ts`). */
export type SharedMediaRow = ClassMedia["items"][number];

/** A vault file, plus the shared row behind it when it belongs to the class. */
export type VaultItem = MediaItem & {
  sharedId?: Id<"vaultMedia">;
  /** True when the signed-in account uploaded this class file. */
  mine?: boolean;
  /** Uploader or staff — the people allowed to rename or delete it. */
  canRemove?: boolean;
};

export function toVaultItem(row: SharedMediaRow): VaultItem {
  return {
    id: `shared:${row.id}`,
    kind: row.kind,
    title: row.title,
    performer: row.uploader,
    uploadedBy: row.uploader,
    date: row.date,
    createdAt: row.createdAt,
    src: `drive:${row.driveFileId}`,
    storage: "drive",
    mimeType: row.mimeType,
    driveFileId: row.driveFileId,
    sharedId: row.id,
    mine: row.mine,
    canRemove: row.canRemove,
  };
}

/**
 * Everything on the shelf: the class's uploads plus this browser's own files.
 *
 * One file can be in both places — a Drive import is shared with the class and
 * still sits in this browser's folders — so the two rows become one: the local
 * copy keeps its folder and place, and the shared row says the class can see
 * it (and supplies the title, so a rename shows up everywhere). A local file
 * with no shared row stays "this device only".
 */
export function vaultItems(
  local: readonly MediaItem[],
  rows: readonly SharedMediaRow[] | undefined,
): VaultItem[] {
  const shared = (rows ?? []).map(toVaultItem);
  const byDriveFile = new Map<string, VaultItem>();
  for (const item of shared) {
    if (item.driveFileId) byDriveFile.set(item.driveFileId, item);
  }

  const merged: VaultItem[] = [];
  for (const item of local) {
    const sharedCopy = item.driveFileId
      ? byDriveFile.get(item.driveFileId)
      : undefined;
    if (!sharedCopy) {
      merged.push(item);
      continue;
    }
    byDriveFile.delete(item.driveFileId!);
    merged.push({
      ...item,
      title: sharedCopy.title,
      sharedId: sharedCopy.sharedId,
      mine: sharedCopy.mine,
      canRemove: sharedCopy.canRemove,
    });
  }

  return [...merged, ...byDriveFile.values()];
}
