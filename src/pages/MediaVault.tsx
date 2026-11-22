import { FolderPicker } from "@/components/folder-picker";
import { MediaRow, VideoCard, VideoDialog } from "@/components/media";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import {
  cacheDriveUrl,
  connectDrive,
  driveKind,
  readDriveResult,
  stripDriveResult,
  uploadFileToDrive,
  type DriveBrowse,
  type DriveBrowseFile,
  type DriveBrowseFolder,
  type DriveSubtreeFile,
} from "@/lib/drive";
import { useAuth } from "@/hooks/use-auth";
import { useViewerIsStaff } from "@/lib/classes";
import { vaultItems, type VaultItem } from "@/lib/vault-shared";
import {
  addFolder,
  addMedia,
  childFolders,
  folderPath,
  folderSubtreeIds,
  importFromDrive,
  MAX_PERSISTENT_BYTES,
  mediaForFolderView,
  moveFolder,
  orderMedia,
  removeFolder,
  removeMedia,
  renameFolder,
  reorderMedia,
  storeFile,
  updateMedia,
  useVault,
  type DriveImportFile,
  type DriveImportFolder,
  type Folder,
  type MediaItem,
  type MediaKind,
} from "@/lib/vault";
import {
  ArrowLeft,
  ChevronRight,
  Folder as FolderIcon,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GripVertical,
  HardDrive,
  Link as LinkIcon,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Unplug,
  UploadCloud,
  Video,
} from "lucide-react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

/** Sentinel for the "no folder" option in the folder picker. */
const ROOT = "__root__";

const today = () => new Date().toISOString().slice(0, 10);

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|avi|m4v|ogv)$/i;

/** Audio or video, decided from the uploaded file itself. */
function detectKind(file: File): MediaKind {
  if (file.type.startsWith("video")) return "video";
  if (file.type.startsWith("audio")) return "audio";
  return VIDEO_EXT.test(file.name) ? "video" : "audio";
}

interface UploadForm {
  title: string;
  /** Folder id, or ROOT for the vault root. */
  folderId: string;
}

/** What a Drive file needs to be put on the class shelf. */
interface ShareableFile {
  kind: MediaKind;
  title: string;
  mimeType: string;
  driveFileId: string;
  date: string;
}

/** "2.4 MB" style label for Drive file sizes. */
function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export default function MediaVault() {
  const { user } = useAuth();
  const vault = useVault();
  const currentName = user?.name ?? "You";

  const [tab, setTab] = useState<MediaKind>("audio");
  const [query, setQuery] = useState("");
  const [openFolder, setOpenFolder] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [form, setForm] = useState<UploadForm>(() => ({
    title: "",
    folderId: ROOT,
  }));
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  /** Why the last upload attempt was refused, shown inside the dialog. */
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [folderDialog, setFolderDialog] = useState<{
    mode: "create" | "rename";
    id?: string;
  } | null>(null);
  const [folderName, setFolderName] = useState("");

  // The folder being moved, and where it is headed (ROOT = top level).
  const [movingFolder, setMovingFolder] = useState<Folder | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>(ROOT);

  // Dragging a file to a new place in the order (teachers and admin only).
  const viewer = useViewerIsStaff();
  const canArrange = viewer.isStaff;
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropOnId, setDropOnId] = useState<string | null>(null);

  const [editing, setEditing] = useState<VaultItem | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editFolder, setEditFolder] = useState<string>(ROOT);

  const [playing, setPlaying] = useState<MediaItem | null>(null);

  // The Google Drive folder picker: which folder is open, and its contents.
  const [drivePickerOpen, setDrivePickerOpen] = useState(false);
  const [driveBrowse, setDriveBrowse] = useState<DriveBrowse | null>(null);
  const [driveTrail, setDriveTrail] = useState<
    { id: string | null; name: string }[]
  >([{ id: null, name: "My Drive" }]);
  const [loadingDrive, setLoadingDrive] = useState(false);
  // The Drive folder id currently being imported (whole folder + subfolders).
  const [busyDriveFolder, setBusyDriveFolder] = useState<string | null>(null);

  // ------------------------------------------------------------ google drive
  const navigate = useNavigate();
  const location = useLocation();
  const driveStatus = useQuery(api.drive.status);
  const driveAuthUrl = useAction(api.drive.authUrl);
  const disconnectDriveVault = useAction(api.drive.disconnectVault);
  const startDriveUpload = useAction(api.drive.startUpload);
  const finishDriveUpload = useAction(api.drive.finishUpload);
  const cancelDriveUpload = useAction(api.drive.cancelUpload);
  const removeFromDrive = useAction(api.drive.remove);
  const disconnectDrive = useAction(api.drive.disconnect);
  const browseDrive = useAction(api.drive.browse);
  const listDriveSubtree = useAction(api.drive.listSubtree);
  // The class archive: one Drive that every upload lands in. Falls back to the
  // caller's own Drive when the admin has not connected it yet.
  const vaultDrive = driveStatus?.vaultConnected === true;
  const personalDrive = driveStatus?.configured === true && driveStatus.connected;
  const driveReady =
    driveStatus?.configured === true && (vaultDrive || personalDrive);

  // Class-shared media: the deployment holds the list, the bytes live in the
  // uploader's Drive, so every member of the class sees the same shelf.
  const sharedMedia = useQuery(api.vault.classMedia, {
    code: vault.classCode ?? "",
  });
  const addSharedMedia = useMutation(api.vault.addShared);
  const renameSharedMedia = useMutation(api.vault.renameShared);
  const removeSharedMedia = useAction(api.vault.removeShared);

  // Report the result of the OAuth round-trip, then tidy the URL.
  useEffect(() => {
    const result = readDriveResult(new URLSearchParams(location.search));
    if (!result) return;
    if (result === "connected") toast.success("Google Drive connected.");
    else if (result === "denied") toast.error("Google Drive access was not granted.");
    else toast.error("Could not connect Google Drive. Try again.");
    navigate(stripDriveResult(new URL(window.location.href)), { replace: true });
  }, [location.search, navigate]);

  const handleConnectDrive = async () => {
    try {
      const { url } = await driveAuthUrl({
        returnTo: "/dashboard/vault",
        origin: window.location.origin,
      });
      connectDrive({ url });
    } catch (error) {
      console.error("Drive connect error:", error);
      toast.error(
        error instanceof Error ? error.message : "Could not start the Drive connection.",
      );
    }
  };

  /** Connect a Drive account to hold the class archive (admin only). */
  const handleConnectVault = async () => {
    try {
      const { url } = await driveAuthUrl({
        returnTo: "/dashboard/vault",
        origin: window.location.origin,
        mode: "vault",
      });
      connectDrive({ url });
    } catch (error) {
      console.error("Class vault connect error:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not start the class Drive connection.",
      );
    }
  };

  const handleDisconnectVault = async () => {
    try {
      const result = await disconnectDriveVault({});
      if (!result.ok) {
        toast.error("Only the admin can disconnect the class vault.");
        return;
      }
      toast.success("Class vault disconnected.");
    } catch (error) {
      console.error("Class vault disconnect error:", error);
      toast.error("Could not disconnect the class vault.");
    }
  };

  const handleDisconnectDrive = async () => {
    try {
      await disconnectDrive({});
      toast.success("Google Drive disconnected.");
    } catch (error) {
      console.error("Drive disconnect error:", error);
      toast.error("Could not disconnect Google Drive.");
    }
  };

  /** Everything on the shelf: the class's uploads plus this browser's files. */
  const allMedia = useMemo(
    () => vaultItems(vault.media, sharedMedia?.ok ? sharedMedia.items : []),
    [vault.media, sharedMedia],
  );

  /**
   * True when this browser keeps its own row for the file as well — a Drive
   * import sits in this browser's folders and on the class shelf at once.
   */
  const isLocalCopy = (item: MediaItem) =>
    vault.media.some((media) => media.id === item.id);

  /**
   * How much media is still stored in this browser (base64 data URLs).
   *
   * localStorage is small and shared with everything else the app remembers —
   * a full quota makes saves fail silently, including the session and settings.
   * Uploads go to Drive now, so this only counts what is left over.
   */
  const browserMediaBytes = useMemo(
    () =>
      allMedia
        .filter((item) => item.storage === "persistent" && item.src.startsWith("data:"))
        .reduce((total, item) => total + item.src.length * 0.75, 0),
    [allMedia],
  );

  /** Drive file ids already shown in the vault, so they aren't imported twice. */
  const importedDriveIds = useMemo(
    () =>
      new Set(
        allMedia
          .map((m) => m.driveFileId)
          .filter((id): id is string => Boolean(id)),
      ),
    [allMedia],
  );

  /** Open a Drive folder (null = the top of My Drive) and list one level. */
  const loadDriveFolder = async (
    folderId: string | null,
    trail: { id: string | null; name: string }[],
  ) => {
    setLoadingDrive(true);
    try {
      setDriveBrowse(await browseDrive(folderId ? { folderId } : {}));
      setDriveTrail(trail);
    } catch (error) {
      console.error("Drive browse failed:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not read that folder on Google Drive.",
      );
      setDrivePickerOpen(false);
    } finally {
      setLoadingDrive(false);
    }
  };

  const openDrivePicker = () => {
    setDriveBrowse(null);
    setDrivePickerOpen(true);
    void loadDriveFolder(null, [{ id: null, name: "My Drive" }]);
  };

  /** Step into a folder from the picker. */
  const enterDriveFolder = (folder: DriveBrowseFolder) => {
    void loadDriveFolder(folder.id, [
      ...driveTrail,
      { id: folder.id, name: folder.name },
    ]);
  };

  /** Jump back to a breadcrumb along the picker's path. */
  const goToDriveCrumb = (index: number) => {
    const crumb = driveTrail[index];
    void loadDriveFolder(crumb.id, driveTrail.slice(0, index + 1));
  };

  const toImportFile = (
    file: DriveBrowseFile | DriveSubtreeFile,
    folderKey: string | null,
  ): DriveImportFile => ({
    title: file.name.replace(/\.[^.]+$/, "") || file.name,
    kind: driveKind(file.mimeType, file.name),
    mimeType: file.mimeType,
    size: file.size,
    driveFileId: file.fileId,
    folderKey,
    performer: currentName,
    uploadedBy: currentName,
    date: today(),
  });

  /**
   * Put Drive imports on the class shelf as well.
   *
   * A file picked from Google Drive stays in the importer's own Drive — only
   * its id is recorded — so the class plays it with that account's stored
   * token, the same way an upload made before the class archive was connected
   * is served. Imports used to be listed in this browser alone, so a folder a
   * teacher added from Drive never reached their students.
   *
   * Returns how many files the class can now see.
   */
  const shareImported = useCallback(
    async (files: ShareableFile[]) => {
      const code = vault.classCode;
      if (!code || files.length === 0) return 0;

      // One call per file: a big folder import still finishes quickly because
      // the Convex client sends them over the same connection.
      const results = await Promise.allSettled(
        files.map((file) =>
          addSharedMedia({
            code,
            kind: file.kind,
            title: file.title,
            mimeType: file.mimeType,
            driveFileId: file.driveFileId,
            date: file.date,
            // The bytes are in the importer's Drive, not the class archive.
            owner: "uploader",
          }),
        ),
      );

      let failed = 0;
      let reason: string | null = null;
      for (const result of results) {
        if (result.status === "rejected") {
          failed++;
          continue;
        }
        if (!result.value.ok) {
          failed++;
          reason = reason ?? result.value.error;
        }
      }
      if (failed > 0) {
        toast.error(
          `${failed} of ${files.length} Drive file${
            files.length === 1 ? "" : "s"
          } could not be shared with the class${
            reason ? ` — ${reason}` : ""
          }. They stay in your own vault.`,
        );
      }
      return files.length - failed;
    },
    [addSharedMedia, vault.classCode],
  );

  /**
   * Drive-backed files that exist only in this browser — an import, or an
   * upload from before the class shelf existed — are shared once when the page
   * opens, so the class can play what is already in the vault.
   */
  const sharedLocalFiles = useRef(false);
  useEffect(() => {
    if (sharedLocalFiles.current) return;
    if (!vault.classCode || sharedMedia === undefined || !sharedMedia.ok) return;
    const known = new Set<string>();
    for (const item of sharedMedia.items) {
      if (item.driveFileId) known.add(item.driveFileId);
    }
    const missing = vault.media.filter(
      (item) =>
        item.driveFileId &&
        // Only files this account put here: another account's Drive file
        // cannot be read with this account's token.
        item.uploadedBy === currentName &&
        !known.has(item.driveFileId),
    );
    if (missing.length === 0) return;
    sharedLocalFiles.current = true;
    void shareImported(
      missing.map((item) => ({
        kind: item.kind,
        title: item.title,
        mimeType: item.mimeType,
        driveFileId: item.driveFileId!,
        date: item.date,
      })),
    );
  }, [currentName, shareImported, sharedMedia, vault.classCode, vault.media]);

  /** Vault import payload for a Drive folder and everything inside it (deep). */
  const buildSubtreePayload = async (rootId: string) => {
    const subtree = await listDriveSubtree({ folderId: rootId });
    const keyOf = new Map<string, string>();
    const folders: DriveImportFolder[] = subtree.folders.map((folder) => {
      const key = `k-${folder.id}`;
      keyOf.set(folder.id, key);
      return {
        key,
        name: folder.name,
        parentKey:
          folder.parentId === null
            ? null
            : (keyOf.get(folder.parentId) ?? null),
      };
    });
    const files: DriveImportFile[] = subtree.files
      .filter((file) => !importedDriveIds.has(file.fileId))
      .map((file) =>
        toImportFile(
          file,
          file.parentId === null ? null : (keyOf.get(file.parentId) ?? null),
        ),
      );
    return { folders, files };
  };

  /** Add a whole Drive folder — subfolders and files — to the vault. */
  const handleAddDriveFolder = async (folder: DriveBrowseFolder) => {
    setBusyDriveFolder(folder.id);
    try {
      const { folders, files } = await buildSubtreePayload(folder.id);
      const result = importFromDrive(folders, files, openFolder);
      const sharedCount = await shareImported(files);
      toast.success(
        `Added “${folder.name}” — ${result.media} file${
          result.media === 1 ? "" : "s"
        } in ${result.folders} folder${result.folders === 1 ? "" : "s"}.${
          sharedCount > 0 ? " Their files are on the class shelf too." : ""
        }`,
      );
    } catch (error) {
      console.error("Drive folder import failed:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not import that folder from Google Drive.",
      );
    } finally {
      setBusyDriveFolder(null);
    }
  };

  const handleAddDriveFile = async (file: DriveBrowseFile) => {
    const imported = [toImportFile(file, null)];
    importFromDrive([], imported, openFolder);
    const sharedCount = await shareImported(imported);
    toast.success(
      `Added “${file.name}” to the vault${
        sharedCount > 0 ? " — everyone in your class can play it" : ""
      }.`,
    );
  };

  /** Add every folder and file shown at the current Drive level. */
  const handleImportAll = async () => {
    const foldersAtLevel = driveBrowse?.folders ?? [];
    const filesAtLevel = (driveBrowse?.files ?? []).filter(
      (file) => !importedDriveIds.has(file.fileId),
    );
    if (foldersAtLevel.length === 0 && filesAtLevel.length === 0) {
      toast.info("This folder has nothing new to add.");
      return;
    }
    setLoadingDrive(true);
    try {
      const folders: DriveImportFolder[] = [];
      const files: DriveImportFile[] = [];
      for (const folder of foldersAtLevel) {
        const payload = await buildSubtreePayload(folder.id);
        folders.push(...payload.folders);
        files.push(...payload.files);
      }
      for (const file of filesAtLevel) files.push(toImportFile(file, null));
      const result = importFromDrive(folders, files, openFolder);
      const sharedCount = await shareImported(files);
      toast.success(
        `Added ${result.media} file${result.media === 1 ? "" : "s"} in ${
          result.folders
        } folder${result.folders === 1 ? "" : "s"} from Google Drive.${
          sharedCount > 0 ? " Their files are on the class shelf too." : ""
        }`,
      );
      setDrivePickerOpen(false);
    } catch (error) {
      console.error("Drive import failed:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not import from Google Drive.",
      );
    } finally {
      setLoadingDrive(false);
    }
  };

  const driveFolders = driveBrowse?.folders ?? [];
  const driveFiles = driveBrowse?.files ?? [];
  const levelPendingCount =
    driveFolders.length +
    driveFiles.filter((file) => !importedDriveIds.has(file.fileId)).length;

  const currentFolder = vault.folders.find((f) => f.id === openFolder) ?? null;
  const trail = folderPath(vault.folders, openFolder);
  const subfolders = childFolders(vault.folders, openFolder);
  const sorted = useMemo(
    () => orderMedia(allMedia, vault.mediaOrder),
    [allMedia, vault.mediaOrder],
  );

  // Full folder path for a file ("Varnam project / Jathis"), so a search can
  // match the folder a file lives in as well as its own details.
  const folderPathFor = (item: MediaItem) =>
    item.folderId
      ? folderPath(vault.folders, item.folderId)
          .map((f) => f.name)
          .join(" ")
      : "";

  const matchesQuery = (item: MediaItem) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [item.title, item.piece, item.talam, item.ragam, folderPathFor(item)]
      .filter(Boolean)
      .some((v) => v!.toLowerCase().includes(q));
  };

  // "All files" shows every file, including the ones kept inside a folder;
  // opening a folder narrows the list down to just that folder.
  const inFolder = mediaForFolderView(sorted, openFolder);
  const audioItems = inFolder.filter(
    (m) => m.kind === "audio" && matchesQuery(m),
  );
  const videoItems = inFolder.filter(
    (m) => m.kind === "video" && matchesQuery(m),
  );

  const countIn = (folderId: string) =>
    vault.media.filter((m) => m.folderId === folderId).length;

  const subfolderCount = (folderId: string) =>
    childFolders(vault.folders, folderId).length;

  /**
   * Tag each file with the folder it lives in, or with who can see it — a
   * class upload versus one that only exists on this device.
   */
  const folderLabelFor = (item: VaultItem) => {
    if (openFolder === null) {
      const folder = vault.folders.find((f) => f.id === item.folderId)?.name;
      if (folder) return folder;
    }
    return item.sharedId ? "Class vault" : "This device only";
  };

  const openUpload = () => {
    setForm({ title: "", folderId: openFolder ?? ROOT });
    setFile(null);
    setUploadError(null);
    setUploadOpen(true);
  };

  /** "7.4 MB" label for the size limits in the upload dialog. */
  const megabytes = (bytes: number) =>
    `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

  /**
   * An upload that will land in the class shelf. Class files have no folder:
   * folders live in this browser, so another member's copy would point at a
   * folder they don't have.
   */
  const classUpload = driveReady && Boolean(vault.classCode);

  /**
   * Store an upload in the signed-in account's Google Drive whenever it is
   * connected, and fall back to browser storage only for files that fit.
   *
   * The old fallback kept anything over 4 MB as a session-only blob URL, which
   * looked uploaded and then vanished on reload — a whole studio recording
   * gone without a word. So a file too big for this browser is now refused
   * with an explanation instead of being quietly sessioned.
   */
  const storeUpload = async (
    file: File,
    name: string,
  ): Promise<{
    src: string;
    storage: "persistent" | "session" | "drive";
    driveFileId?: string;
    target?: "vault" | "uploader";
  }> => {
    if (driveReady) {
      try {
        // The browser uploads straight to Google via a resumable session, so
        // the file never passes through a Convex function.
        const result = await uploadFileToDrive(file, name, {
          startUpload: startDriveUpload,
          finishUpload: finishDriveUpload,
          cancelUpload: cancelDriveUpload,
        });
        if (result.url) cacheDriveUrl(result.fileId, result.url);
        return {
          src: `drive:${result.fileId}`,
          storage: "drive",
          driveFileId: result.fileId,
          target: result.target,
        };
      } catch (error) {
        console.error("Drive upload failed:", error);
        // Surface the underlying reason — it is the only way to tell an expired
        // connection apart from an oversized file or a Google API error.
        const reason = (
          error instanceof Error ? error.message : String(error ?? "")
        ).slice(0, 120);
        if (file.size > MAX_PERSISTENT_BYTES) {
          throw new Error(
            `Google Drive could not take this file (${reason}). At ${megabytes(
              file.size,
            )} it is too big to keep in this browser, so nothing was saved — try again.`,
          );
        }
        toast.error(
          /connect google drive/i.test(reason)
            ? "Google Drive needs connecting again — saved to this browser for now."
            : `Drive upload failed (${reason}) — saved to this browser instead.`,
        );
      }
    } else if (file.size > MAX_PERSISTENT_BYTES) {
      throw new Error(
        `This file is ${megabytes(
          file.size,
        )}, and this browser can only keep ${megabytes(
          MAX_PERSISTENT_BYTES,
        )} per upload. ${
          driveStatus?.canManageVault
            ? "Connect the class vault above and upload again — it will go straight to that Drive."
            : "Ask your teacher to connect the class vault, then upload again (or pick a smaller file)."
        }`,
      );
    }

    return await storeFile(file);
  };

  const handleUpload = async (event: FormEvent) => {
    event.preventDefault();
    if (!file) {
      toast.error("Choose a file to upload first.");
      return;
    }
    if (!form.title.trim()) {
      toast.error("Give this file a title.");
      return;
    }

    setSaving(true);
    setUploadError(null);
    try {
      const kind = detectKind(file);
      const mimeType =
        file.type || (kind === "audio" ? "audio/*" : "video/*");

      // Every account stores in its own Drive when connected; the helper falls
      // back to this browser only when the file fits there.
      const stored = await storeUpload(file, file.name || form.title.trim());
      const title = form.title.trim();

      // A Drive upload belongs to the class shelf, so every member sees it.
      // Only that shared row is written — adding a local copy as well would
      // show the uploader the same clip twice.
      const shared =
        stored.storage === "drive" && stored.driveFileId && vault.classCode
          ? await addSharedMedia({
              code: vault.classCode,
              kind,
              title,
              mimeType,
              driveFileId: stored.driveFileId,
              date: today(),
              owner: stored.target ?? "uploader",
            })
          : null;

      if (shared?.ok) {
        toast.success(
          `${kind === "audio" ? "Track" : "Clip"} added to the class vault — everyone can play it.`,
        );
      } else {
        addMedia({
          kind,
          title,
          folderId: form.folderId === ROOT ? null : form.folderId,
          // Username identifies the account throughout the app (logs, folders,
          // leaderboard), so use the whole account name here too.
          performer: currentName,
          uploadedBy: currentName,
          date: today(),
          src: stored.src,
          storage: stored.storage,
          mimeType,
          ...(stored.driveFileId ? { driveFileId: stored.driveFileId } : {}),
        });

        if (shared && !shared.ok) {
          toast.error(
            `Saved to your Drive, but not shared with the class — ${shared.error}`,
          );
        } else if (stored.storage === "drive") {
          toast.success(
            `${kind === "audio" ? "Track" : "Clip"} saved to your Google Drive. Join a class to share uploads with everyone.`,
          );
        } else if (stored.storage === "session") {
          toast.info(
            "Large file kept for this session only — smaller files persist after refresh.",
          );
        } else {
          toast.success(
            `${kind === "audio" ? "Track" : "Clip"} added to this device's vault.`,
          );
        }
      }
      setUploadOpen(false);
    } catch (error) {
      // Keep the dialog open with the file still chosen, so a connected Drive
      // can be retried without picking the recording again.
      const message =
        error instanceof Error ? error.message.trim() : "";
      setUploadError(
        message || "Could not read that file. Try another one.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (item: VaultItem) => {
    if (item.sharedId) {
      if (item.canRemove === false) {
        toast.error("Only the uploader or a teacher can remove this file.");
        return;
      }
      const result = await removeSharedMedia({ id: item.sharedId });
      if (!result.ok) {
        toast.error(result.error ?? "Could not remove that file.");
        return;
      }
      // An upload from before the vault was shared also has a local row; drop
      // it too, or its dead tile would reappear now the shared one is gone.
      const localCopy = item.driveFileId
        ? vault.media.find((m) => m.driveFileId === item.driveFileId)
        : undefined;
      if (localCopy) removeMedia(localCopy.id);
      toast.success(`Removed “${item.title}” from the class vault.`);
      return;
    }

    removeMedia(item.id);
    if (item.driveFileId) {
      try {
        await removeFromDrive({ fileId: item.driveFileId });
      } catch (error) {
        console.error("Drive delete failed:", error);
      }
    }
    toast.success(`Removed “${item.title}” from the vault.`);
  };

  const openEdit = (item: VaultItem) => {
    if (item.sharedId && item.canRemove === false) {
      toast.error("Only the uploader or a teacher can rename this file.");
      return;
    }
    setEditing(item);
    setEditTitle(item.title);
    setEditFolder(item.folderId ?? ROOT);
  };

  const handleEditSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const title = editTitle.trim();
    if (!title) {
      toast.error("Give this file a title.");
      return;
    }

    if (editing.sharedId) {
      // Renaming a class upload changes it for everyone in the class.
      const result = await renameSharedMedia({
        id: editing.sharedId,
        title,
      });
      if (!result.ok) {
        toast.error(result.error ?? "Could not rename that file.");
        return;
      }
      // A Drive import also has a row in this browser's vault, which is where
      // its folder lives — move that copy too, so the layout follows.
      if (isLocalCopy(editing)) {
        updateMedia(editing.id, {
          folderId: editFolder === ROOT ? null : editFolder,
        });
      }
    } else {
      updateMedia(editing.id, {
        title,
        folderId: editFolder === ROOT ? null : editFolder,
      });
    }
    setEditing(null);
    toast.success("File updated.");
  };

  const openCreateFolder = () => {
    setFolderName("");
    setFolderDialog({ mode: "create" });
  };

  const openRenameFolder = (folder: Folder) => {
    setFolderName(folder.name);
    setFolderDialog({ mode: "rename", id: folder.id });
  };

  const handleFolderSubmit = (event: FormEvent) => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) {
      toast.error("Give the folder a name.");
      return;
    }
    if (folderDialog?.mode === "rename" && folderDialog.id) {
      renameFolder(folderDialog.id, name);
      toast.success("Folder renamed.");
    } else {
      // New folders are created inside whatever folder is currently open.
      addFolder(name, openFolder);
      toast.success(
        currentFolder
          ? `Folder created inside “${currentFolder.name}”.`
          : "Folder created.",
      );
    }
    setFolderDialog(null);
  };

  // --------------------------------------------------------- tile ordering
  const handleDragStart = (
    event: DragEvent<HTMLButtonElement>,
    item: MediaItem,
  ) => {
    setDraggingId(item.id);
    event.dataTransfer.effectAllowed = "move";
    // Firefox only begins a drag when some data is set.
    event.dataTransfer.setData("text/plain", item.title);
  };

  const handleTileDragOver = (
    event: DragEvent<HTMLDivElement>,
    item: MediaItem,
  ) => {
    if (!canArrange || !draggingId || draggingId === item.id) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (dropOnId !== item.id) setDropOnId(item.id);
  };

  const handleTileDrop = (
    event: DragEvent<HTMLDivElement>,
    item: MediaItem,
  ) => {
    event.preventDefault();
    const dragged = draggingId;
    setDraggingId(null);
    setDropOnId(null);
    if (!canArrange || !dragged || dragged === item.id) return;
    reorderMedia(dragged, item.id);
  };

  const handleDragEnd = () => {
    setDraggingId(null);
    setDropOnId(null);
  };

  /** The grip a teacher drags; students never see it. */
  const reorderHandle = (item: VaultItem, tone: "row" | "overlay") =>
    canArrange && (!item.sharedId || isLocalCopy(item)) ? (
      <button
        type="button"
        draggable
        onDragStart={(event) => handleDragStart(event, item)}
        onDragEnd={handleDragEnd}
        aria-label={`Reorder ${item.title}`}
        title="Drag to reorder"
        className={
          tone === "row"
            ? "flex size-7 cursor-grab items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:cursor-grabbing"
            : "flex size-7 cursor-grab items-center justify-center rounded-md bg-black/35 text-white backdrop-blur-sm transition-colors hover:bg-black/55 active:cursor-grabbing"
        }
      >
        <GripVertical className="size-4" />
      </button>
    ) : undefined;

  const tileClass = (item: MediaItem) =>
    `rounded-xl transition-all ${
      draggingId === item.id ? "opacity-50" : ""
    } ${
      dropOnId === item.id
        ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
        : ""
    }`;

  const openMoveFolder = (folder: Folder) => {
    setMoveTarget(folder.parentId ?? ROOT);
    setMovingFolder(folder);
  };

  // Moving a folder to where it already is does nothing, so the dialog's
  // button stays disabled until a different destination is picked.
  const moveIsNoop =
    movingFolder !== null &&
    (movingFolder.parentId ?? null) ===
      (moveTarget === ROOT ? null : moveTarget);

  const handleMoveFolder = (event: FormEvent) => {
    event.preventDefault();
    if (!movingFolder || moveIsNoop) return;
    const target = moveTarget === ROOT ? null : moveTarget;
    if (!moveFolder(movingFolder.id, target)) {
      toast.error("A folder can't be moved inside itself.");
      return;
    }
    const destination = target
      ? vault.folders.find((f) => f.id === target) ?? null
      : null;
    toast.success(
      destination
        ? `Moved “${movingFolder.name}” into “${destination.name}”.`
        : `Moved “${movingFolder.name}” to the top level.`,
    );
    setMovingFolder(null);
  };

  const handleDeleteFolder = (folder: Folder) => {
    const subtree = folderSubtreeIds(vault.folders, folder.id);
    const doomed = new Set(subtree);
    const moved = vault.media.filter(
      (m) => m.folderId && doomed.has(m.folderId),
    ).length;
    const nested = subtree.length - 1;
    removeFolder(folder.id);
    if (openFolder && doomed.has(openFolder)) setOpenFolder(null);
    const parts = [
      moved > 0
        ? `${moved} file${moved === 1 ? "" : "s"} moved to All files`
        : null,
      nested > 0
        ? `${nested} subfolder${nested === 1 ? "" : "s"} removed`
        : null,
    ].filter(Boolean);
    toast.success(
      parts.length > 0 ? `Folder deleted — ${parts.join(", ")}.` : "Folder deleted.",
    );
  };

  const setField = (key: keyof UploadForm, value: string) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      {/* ------------------------------------------ google drive status */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-card px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${
              driveReady
                ? "bg-gold/25 text-gold-foreground"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <HardDrive className="size-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {vaultDrive
                ? "Class vault · Google Drive"
                : personalDrive
                  ? "Stored in your Google Drive"
                  : "Storage: this browser"}
            </p>
            <p className="text-xs text-muted-foreground sm:truncate">
              {driveStatus === undefined
                ? "Checking Google Drive…"
                : !driveStatus.configured
                  ? "Google Drive isn't configured on this deployment yet."
                  : vaultDrive
                    ? `Every class upload lands in ${
                        driveStatus.vaultEmail ?? "the class Drive"
                      } — and everyone in the class can play it.`
                    : driveStatus.canManageVault
                      ? "Connect a Google Drive as the class vault, so every upload the class makes lands in one place."
                      : "No class vault is connected yet — ask your teacher or admin to connect one."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {driveStatus?.configured && !vaultDrive && driveStatus.canManageVault && (
            <Button
              type="button"
              size="sm"
              className="shrink-0"
              onClick={() => void handleConnectVault()}
            >
              <LinkIcon className="size-4" />
              Connect class vault
            </Button>
          )}
          {driveStatus?.configured &&
            vaultDrive &&
            driveStatus.canManageVault &&
            !personalDrive && (
              // Only staff can connect a Drive, and this one is just for
              // browsing their own files into the vault ("Add from Drive").
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="shrink-0"
                title="Only needed to import folders from your own Drive"
                onClick={() => void handleConnectDrive()}
              >
                <LinkIcon className="size-4" />
                Connect my Drive
              </Button>
            )}
          {driveStatus?.configured && vaultDrive && driveStatus.canManageVault && (
            // Every class upload lives in this Drive; disconnecting hides the
            // whole class shelf, so this is a deliberate two-step action.
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                >
                  <Unplug className="size-4" />
                  Disconnect class vault
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Disconnect the class vault?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    The files stay in that Drive, but nobody in the class —
                    including you — will be able to play them until it is
                    connected again.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep connected</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void handleDisconnectVault()}>
                    Disconnect
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {/* Students are never offered a Drive connection: uploads go to the
              class vault, and class clips play without one. The only control
              they may need is undoing a connection made before this. */}
          {driveStatus?.configured &&
            !driveStatus.canManageVault &&
            personalDrive && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => void handleDisconnectDrive()}
              >
                <Unplug className="size-4" />
                Disconnect my Drive
              </Button>
            )}
        </div>
      </div>

      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <nav className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => setOpenFolder(null)}
              className="rounded px-1 py-0.5 transition-colors hover:text-foreground"
            >
              All files
            </button>
            {trail.map((folder, index) => (
              <Fragment key={folder.id}>
                <ChevronRight className="size-3 shrink-0" />
                {index === trail.length - 1 ? (
                  <span className="truncate px-1 font-medium text-foreground">
                    {folder.name}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpenFolder(folder.id)}
                    className="rounded px-1 py-0.5 transition-colors hover:text-foreground"
                  >
                    {folder.name}
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
          <h1 className="mt-1 truncate text-2xl font-bold tracking-tight sm:text-3xl">
            {currentFolder ? currentFolder.name : "Media Vault"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Practice tracks and dance clips, shared with everyone in your class.
          </p>
        </div>
        <div data-tour="vault-actions" className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={openCreateFolder}>
            <FolderPlus />
            New folder
          </Button>
          {/* Staff only: importing browses YOUR Drive, which needs a personal
              connection — the class vault is not the same account. If that
              connection is missing, the button starts it instead of vanishing. */}
          {driveStatus?.configured && driveStatus.canManageVault && (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                personalDrive ? openDrivePicker() : void handleConnectDrive()
              }
              title={
                personalDrive
                  ? "Import files and folders from your own Google Drive (files are shared with your class)"
                  : "Connect your own Google Drive to import from it — this is not the class vault"
              }
            >
              <HardDrive />
              Add from Drive
            </Button>
          )}
          <Button type="button" onClick={openUpload}>
            <UploadCloud />
            Upload a file
          </Button>
        </div>
      </header>

      {/* -------------------------------------------------------- folders */}
      <section data-tour="vault-folders" className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold tracking-tight">
          {openFolder === null ? "Folders" : "Subfolders"}
        </h2>
        {subfolders.length === 0 ? (
          <p className="rounded-xl border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
            {openFolder === null
              ? "No folders yet — create one to group your clips."
              : "No subfolders in here — use New folder to add one inside this folder."}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subfolders.map((folder) => (
              <div
                key={folder.id}
                className="flex items-center gap-1.5 rounded-xl border border-border/70 bg-card px-3 py-2.5 transition-colors hover:border-primary/40"
              >
                <button
                  type="button"
                  onClick={() => setOpenFolder(folder.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gold/25 text-gold-foreground">
                    <FolderIcon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {folder.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {countIn(folder.id)} file
                      {countIn(folder.id) === 1 ? "" : "s"}
                      {subfolderCount(folder.id) > 0 &&
                        ` · ${subfolderCount(folder.id)} folder${
                          subfolderCount(folder.id) === 1 ? "" : "s"
                        }`}
                    </span>
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Move ${folder.name}`}
                  className="shrink-0 text-muted-foreground"
                  onClick={() => openMoveFolder(folder)}
                >
                  <FolderInput className="size-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Rename ${folder.name}`}
                  className="shrink-0 text-muted-foreground"
                  onClick={() => openRenameFolder(folder)}
                >
                  <Pencil className="size-4" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${folder.name}`}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete “{folder.name}”?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        The folder and any folders nested inside it are
                        removed. Files in them move back to All files — nothing
                        is deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => handleDeleteFolder(folder)}
                      >
                        Delete folder
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
      </section>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as MediaKind)}
        className="gap-4"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList data-tour="vault-tabs">
            <TabsTrigger value="audio" className="gap-1.5">
              <Music2 className="size-4" />
              Audios
              <Badge variant="secondary" className="ml-1 px-1.5 tabular-nums">
                {inFolder.filter((m) => m.kind === "audio").length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="video" className="gap-1.5">
              <Video className="size-4" />
              Videos
              <Badge variant="secondary" className="ml-1 px-1.5 tabular-nums">
                {inFolder.filter((m) => m.kind === "video").length}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <div data-tour="vault-search" className="relative w-full sm:max-w-xs">
            <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by title, item, or folder…"
              className="pl-9"
              aria-label="Search media by title, item, or folder"
            />
          </div>
        </div>

        {canArrange && inFolder.length > 1 && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GripVertical className="size-3.5 shrink-0" />
            Drag a file’s handle onto another file to set the order — teachers
            and admin decide what the class sees first.
          </p>
        )}

        {/* ---------------------------------------------------- audio */}
        <TabsContent value="audio" className="flex flex-col gap-4">
          {audioItems.length === 0 ? (
            <EmptyVault
              kind="audio"
              action={openUpload}
              filtered={Boolean(query)}
              inFolder={currentFolder !== null}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {audioItems.map((item) => (
                <div
                  key={item.id}
                  onDragOver={(event) => handleTileDragOver(event, item)}
                  onDrop={(event) => handleTileDrop(event, item)}
                  className={tileClass(item)}
                >
                  <MediaRow
                    item={item}
                    dragHandle={reorderHandle(item, "row")}
                    folderLabel={folderLabelFor(item)}
                    onPlay={setPlaying}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {/* ---------------------------------------------------- video */}
        <TabsContent value="video" className="flex flex-col gap-4">
          {videoItems.length === 0 ? (
            <EmptyVault
              kind="video"
              action={openUpload}
              filtered={Boolean(query)}
              inFolder={currentFolder !== null}
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {videoItems.map((item) => (
                <div
                  key={item.id}
                  onDragOver={(event) => handleTileDragOver(event, item)}
                  onDrop={(event) => handleTileDrop(event, item)}
                  className={tileClass(item)}
                >
                  <VideoCard
                    item={item}
                    dragHandle={reorderHandle(item, "overlay")}
                    folderLabel={folderLabelFor(item)}
                    onOpen={setPlaying}
                    onEdit={openEdit}
                    onDelete={handleDelete}
                  />
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {browserMediaBytes > 2 * 1024 * 1024 && (
        <p className="rounded-lg border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-muted-foreground">
          About {megabytes(browserMediaBytes)} of media is still stored in this
          browser. A full browser store makes NatyaVault forget settings and
          sign you out, so delete the files marked “This device only” that you
          no longer need.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {vaultDrive
          ? "Uploads land in the class vault Drive and appear for everyone in your class, on any device."
          : driveReady
            ? "Uploads go to the NatyaVault folder in your own Google Drive and are shared with your class."
            : driveStatus?.configured
            ? driveStatus.canManageVault
              ? `Connect the class vault so uploads land in Drive. Until then, files up to ${megabytes(
                  MAX_PERSISTENT_BYTES,
                )} stay in this browser.`
              : `Uploads stay in this browser until the class vault is connected — up to ${megabytes(
                  MAX_PERSISTENT_BYTES,
                )} per file.`
            : `Uploads are kept in this browser: files up to ${megabytes(
                MAX_PERSISTENT_BYTES,
              )} persist, anything larger needs Google Drive.`}
      </p>

      {/* ------------------------------------------------- upload dialog */}
      <Dialog
        open={uploadOpen}
        onOpenChange={(open) => {
          if (!open) setUploadOpen(false);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Upload a file</DialogTitle>
            <DialogDescription>
              Audios or videos for practice
              {!driveReady
                ? "."
                : vaultDrive
                  ? ", saved to the class vault."
                  : vault.classCode
                    ? ", saved to your Google Drive and shared with your class."
                    : ", saved to your Google Drive."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleUpload} className="flex flex-col gap-4">
            <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/40 px-4 py-6 text-center transition-colors hover:bg-muted">
              <UploadCloud className="size-5 text-muted-foreground" />
              <span className="max-w-full truncate text-sm font-medium">
                {file ? file.name : "Choose a file"}
              </span>
              <span className="text-xs text-muted-foreground">
                MP3, WAV, M4A, MP4, MOV…
              </span>
              <input
                type="file"
                className="sr-only"
                accept="audio/*,video/*"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setUploadError(null);
                }}
              />
            </label>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="media-title">Title</Label>
                <Input
                  id="media-title"
                  value={form.title}
                  onChange={(e) => setField("title", e.target.value)}
                  placeholder="e.g. Alarippu — full run"
                  required
                />
              </div>

              {!classUpload && (
                <div className="flex flex-col gap-1.5">
                  <Label>Folder</Label>
                  <FolderPicker
                    folders={vault.folders}
                    value={form.folderId === ROOT ? null : form.folderId}
                    onChange={(folderId) =>
                      setField("folderId", folderId ?? ROOT)
                    }
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/70 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <HardDrive className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1">
                {vaultDrive
                  ? `Lands in the class vault${
                      driveStatus?.vaultEmail
                        ? ` (${driveStatus.vaultEmail})`
                        : ""
                    } — everyone in your class can play it.`
                  : driveReady
                    ? "Goes to the NatyaVault folder in your own Google Drive and is shared with your class."
                    : driveStatus?.configured
                    ? `No Drive connected — files up to ${megabytes(
                        MAX_PERSISTENT_BYTES,
                      )} stay in this browser; larger ones need Drive.`
                    : `Kept in this browser only — up to ${megabytes(
                        MAX_PERSISTENT_BYTES,
                      )} per file.`}
              </span>
              {/* Only staff can connect a Drive; students just get the size
                  limits and the class vault when it exists. */}
              {!driveReady &&
                driveStatus?.configured &&
                driveStatus.canManageVault && (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="shrink-0"
                    onClick={() => void handleConnectVault()}
                  >
                    <LinkIcon className="size-3.5" />
                    Connect class vault
                  </Button>
                )}
            </div>

            {uploadError && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {uploadError}
              </p>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setUploadOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : "Upload"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------- folder dialog */}
      <Dialog
        open={folderDialog !== null}
        onOpenChange={(open) => {
          if (!open) setFolderDialog(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {folderDialog?.mode === "rename" ? "Rename folder" : "New folder"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleFolderSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="folder-name">Folder name</Label>
              <Input
                id="folder-name"
                value={folderName}
                onChange={(e) => setFolderName(e.target.value)}
                placeholder="e.g. Varnam project"
                autoFocus
                required
              />
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setFolderDialog(null)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {folderDialog?.mode === "rename" ? "Rename" : "Create folder"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------------- move folder dialog */}
      <Dialog
        open={movingFolder !== null}
        onOpenChange={(open) => {
          if (!open) setMovingFolder(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Move folder</DialogTitle>
            <DialogDescription>
              Choose where “{movingFolder?.name}” goes. Everything inside it —
              subfolders and files — moves with it.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleMoveFolder} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>Destination</Label>
              <FolderPicker
                folders={vault.folders}
                value={moveTarget === ROOT ? null : moveTarget}
                onChange={(folderId) => setMoveTarget(folderId ?? ROOT)}
                excludeIds={
                  new Set(
                    movingFolder
                      ? folderSubtreeIds(vault.folders, movingFolder.id)
                      : [],
                  )
                }
              />
              <p className="text-xs text-muted-foreground">
                Click a folder to step inside it; the folder you're viewing is
                where it moves. It can't go inside itself.
              </p>
            </div>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMovingFolder(null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={moveIsNoop}
                title={
                  moveIsNoop ? "Pick a different folder first" : undefined
                }
              >
                Move folder
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------------------- edit dialog */}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Edit file</DialogTitle>
            <DialogDescription>
              {editing?.sharedId
                ? "The new name shows for everyone in your class."
                : "Rename it or move it into a folder."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleEditSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="e.g. Alarippu — full run"
                required
              />
            </div>
            {/* A class upload has no folder: everyone's copy of the shelf
                would need the same folder ids, and folders are per browser.
                A Drive import keeps its own local row, so it still moves. */}
            {(!editing?.sharedId || (editing !== null && isLocalCopy(editing))) && (
              <div className="flex flex-col gap-1.5">
                <Label>Folder</Label>
                <FolderPicker
                  folders={vault.folders}
                  value={editFolder === ROOT ? null : editFolder}
                  onChange={(folderId) => setEditFolder(folderId ?? ROOT)}
                />
              </div>
            )}
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit">Save changes</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* --------------------------------------------- drive folder import */}
      <Dialog
        open={drivePickerOpen}
        onOpenChange={(open) => {
          if (!open) setDrivePickerOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import from Google Drive</DialogTitle>
            <DialogDescription>
              Browse your whole Drive and add a file, or a whole folder with
              its subfolders, to your vault
              {currentFolder ? ` under “${currentFolder.name}”` : ""}.
            </DialogDescription>
          </DialogHeader>

          {/* Breadcrumb along the picker's path. */}
          <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {driveTrail.map((crumb, index) => {
              const last = index === driveTrail.length - 1;
              return (
                <Fragment key={`${crumb.id ?? "root"}-${index}`}>
                  {index > 0 && <ChevronRight className="size-3 shrink-0" />}
                  <button
                    type="button"
                    className={`max-w-[10rem] truncate rounded px-1 py-0.5 hover:bg-muted ${
                      last ? "font-medium text-foreground" : ""
                    }`}
                    onClick={() => goToDriveCrumb(index)}
                    disabled={last}
                  >
                    {crumb.name}
                  </button>
                </Fragment>
              );
            })}
          </div>

          <div className="max-h-[50vh] overflow-y-auto">
            {loadingDrive && driveBrowse === null ? (
              <p className="px-1 py-8 text-center text-sm text-muted-foreground">
                Reading your Google Drive…
              </p>
            ) : driveFolders.length === 0 && driveFiles.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center">
                <HardDrive className="size-5 text-muted-foreground" />
                <p className="text-sm font-medium">Nothing in this folder</p>
                <p className="text-xs text-muted-foreground">
                  Go up a level, or add files and folders in Google Drive and
                  Refresh.
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {driveFolders.map((folder) => (
                  <li
                    key={folder.id}
                    className="flex items-center gap-2 rounded-lg border border-border/70 px-2 py-2"
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gold/25 text-gold-foreground">
                      <FolderIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {folder.name}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      onClick={() => enterDriveFolder(folder)}
                    >
                      <FolderOpen className="size-4" />
                      Open
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="shrink-0"
                      disabled={busyDriveFolder !== null}
                      onClick={() => void handleAddDriveFolder(folder)}
                    >
                      <Plus className="size-4" />
                      {busyDriveFolder === folder.id ? "Adding…" : "Add"}
                    </Button>
                  </li>
                ))}
                {driveFiles.map((file) => {
                  const inVault = importedDriveIds.has(file.fileId);
                  const kind = driveKind(file.mimeType, file.name);
                  return (
                    <li
                      key={file.fileId}
                      className="flex items-center gap-3 rounded-lg border border-border/70 px-3 py-2"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-gold/25 text-gold-foreground">
                        {kind === "video" ? (
                          <Video className="size-4" />
                        ) : (
                          <Music2 className="size-4" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {file.name}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {kind === "video" ? "Video" : "Audio"}
                          {file.size ? ` · ${formatBytes(file.size)}` : ""}
                        </span>
                      </span>
                      {inVault ? (
                        <Badge variant="secondary" className="shrink-0">
                          In vault
                        </Badge>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="shrink-0"
                          onClick={() => handleAddDriveFile(file)}
                        >
                          <Plus className="size-4" />
                          Add
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex items-center gap-1">
              {driveTrail.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => goToDriveCrumb(driveTrail.length - 2)}
                  disabled={loadingDrive}
                >
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void loadDriveFolder(
                    driveTrail[driveTrail.length - 1]?.id ?? null,
                    driveTrail,
                  )
                }
                disabled={loadingDrive}
              >
                <RefreshCw className="size-4" />
                Refresh
              </Button>
            </div>
            <Button
              type="button"
              onClick={() => void handleImportAll()}
              disabled={loadingDrive || levelPendingCount === 0}
            >
              {levelPendingCount > 1
                ? `Add all (${levelPendingCount})`
                : "Add all"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <VideoDialog
        item={playing}
        open={playing !== null}
        onOpenChange={(open) => {
          if (!open) setPlaying(null);
        }}
        onEdit={(item) => {
          // Close the player so the edit form is the only dialog on screen.
          setPlaying(null);
          openEdit(item);
        }}
        onDelete={(item) => {
          setPlaying(null);
          void handleDelete(item);
        }}
      />
    </div>
  );
}

function EmptyVault({
  kind,
  action,
  filtered,
  inFolder,
}: {
  kind: MediaKind;
  action: () => void;
  filtered: boolean;
  inFolder: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/60 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted">
        {kind === "audio" ? (
          <Music2 className="size-5 text-muted-foreground" />
        ) : (
          <Video className="size-5 text-muted-foreground" />
        )}
      </span>
      <div>
        <p className="text-sm font-medium">
          {filtered
            ? "Nothing matches that search"
            : inFolder
              ? "This folder is empty"
              : "No media yet"}
        </p>
        <p className="text-xs text-muted-foreground">
          {filtered
            ? "Try a different search."
            : inFolder
              ? "Upload a file straight into this folder."
              : kind === "audio"
                ? "Upload your first practice track."
                : "Upload the first dance clip."}
        </p>
      </div>
      {!filtered && (
        <Button type="button" size="sm" onClick={action}>
          <UploadCloud />
          Upload a file
        </Button>
      )}
    </div>
  );
}
