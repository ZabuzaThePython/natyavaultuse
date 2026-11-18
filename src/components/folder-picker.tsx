import { cn } from "@/lib/utils";
import { childFolders, folderPath, type Folder } from "@/lib/vault";
import { ChevronRight, Folder as FolderIcon } from "lucide-react";
import { Fragment, useState } from "react";

/**
 * A small folder browser used wherever a destination folder is chosen
 * (uploading, editing a file, moving a folder).
 *
 * Clicking a folder walks into it and makes it the destination, so you can
 * step down the tree ("All files → Compositions → Margam") and stop wherever
 * the file should land. The breadcrumb walks back up; choosing "All files"
 * means no folder.
 */
export function FolderPicker({
  folders,
  value,
  onChange,
  excludeIds,
  rootLabel = "All files",
}: {
  folders: Folder[];
  /** Folder that will receive the file, or null for the top level. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** Folders that can't be picked — e.g. the folder being moved, and its own subfolders. */
  excludeIds?: ReadonlySet<string>;
  rootLabel?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(value);

  const current = folders.find((folder) => folder.id === openId) ?? null;
  const trail = folderPath(folders, current?.id ?? null);
  const children = childFolders(folders, current?.id ?? null).filter(
    (folder) => !excludeIds?.has(folder.id),
  );

  /** Walk into a folder (or back to the top level) and destine files there. */
  const go = (id: string | null) => {
    setOpenId(id);
    onChange(id);
  };

  const crumbClass = (active: boolean) =>
    cn(
      "max-w-[9rem] truncate rounded px-1 py-0.5 text-xs transition-colors",
      active
        ? "font-medium text-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/70 bg-muted/20 p-2">
      <nav className="flex flex-wrap items-center gap-0.5 px-1">
        <button
          type="button"
          onClick={() => go(null)}
          disabled={current === null}
          className={crumbClass(current === null)}
        >
          {rootLabel}
        </button>
        {trail.map((folder) => {
          const active = folder.id === current?.id;
          return (
            <Fragment key={folder.id}>
              <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              <button
                type="button"
                onClick={() => go(folder.id)}
                disabled={active}
                className={crumbClass(active)}
              >
                {folder.name}
              </button>
            </Fragment>
          );
        })}
      </nav>

      {children.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          {current
            ? `No folders inside “${current.name}”.`
            : "No folders yet — files go in the top level."}
        </p>
      ) : (
        <ul className="flex max-h-44 flex-col gap-0.5 overflow-y-auto">
          {children.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => go(folder.id)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <FolderIcon className="size-4 shrink-0 text-gold-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {folder.name}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="px-1 text-xs text-muted-foreground">
        Destination:{" "}
        <span className="font-medium text-foreground">
          {current ? trail.map((folder) => folder.name).join(" / ") : rootLabel}
        </span>
      </p>
    </div>
  );
}
