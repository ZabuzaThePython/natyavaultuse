import { toast } from "sonner";
import { useSyncExternalStore } from "react";

/**
 * NatyaVault local store.
 *
 * Everything (role switch, folders, practice logs, media metadata + small
 * files) lives in localStorage under one key so the whole app survives a
 * refresh, exactly as the MVP spec asks.
 */

export type Role = "student" | "teacher";

export type MediaKind = "audio" | "video";

export interface MediaItem {
  id: string;
  kind: MediaKind;
  title: string;
  /** Optional dance item tag, e.g. Alarippu. */
  piece?: string;
  talam?: string;
  ragam?: string;
  /** Owner of the vault this clip belongs to. */
  performer: string;
  uploadedBy: string;
  /** Folder this item lives in; undefined/null means the vault root. */
  folderId?: string | null;
  /** Practice/rehearsal date, YYYY-MM-DD. */
  date: string;
  createdAt: number;
  /**
   * Playback source:
   * - data:…      persisted upload (localStorage)
   * - blob:…      session-only upload (too large to persist)
   * - https:…     sample clip shipped with the demo
   * - synth:beats:bpm:cycles  generated talam click track
   */
  src: string;
  storage: "persistent" | "session" | "sample" | "drive";
  mimeType: string;
  /** Google Drive file id — present for media stored in the user's Drive. */
  driveFileId?: string;
}

export interface PracticeEntry {
  id: string;
  date: string;
  minutes: number;
  item: string;
  author: string;
  createdAt: number;
}

/**
 * How a person was marked for one class day. `away` is the student telling
 * the teacher ahead of time that they can't make the class; `absent` is the
 * teacher's own record that someone didn't turn up.
 */
export type AttendanceStatus = "present" | "late" | "absent" | "away";

/**
 * One attendance mark: a person, a day, and the status the day was marked
 * with. A person has at most one mark per day — re-marking overwrites it.
 */
export interface AttendanceEntry {
  id: string;
  /** Class day, YYYY-MM-DD. */
  date: string;
  /** Account name of the person the mark is about. */
  name: string;
  status: AttendanceStatus;
  /** Account that recorded the mark — the teacher, or the student themselves. */
  markedBy: string;
  createdAt: number;
}

/** A folder in the media vault (Drive-style grouping). */
export interface Folder {
  id: string;
  name: string;
  /** Parent folder id; null/undefined = top level. Folders can be nested. */
  parentId?: string | null;
  createdAt: number;
}

/** A file attached to a chat message (image, audio, video, or document). */
export interface MessageAttachment {
  /** Original file name. */
  name: string;
  mimeType: string;
  size: number;
  /**
   * data: URL when it fits in localStorage, a session blob URL for oversized
   * files, or the Drive file id when it lives in the user's Google Drive.
   */
  src: string;
  storage: "persistent" | "session" | "drive";
  /** Google Drive file id — present for files stored in the user's Drive. */
  driveFileId?: string;
}

/** A free-text chat message between the student and the teacher. */
export interface ChatMessage {
  id: string;
  author: Role;
  /**
   * Account that sent the message. Two people can share a role (e.g. two
   * students), so this is what identifies the author — a student may only
   * delete the messages they sent themselves. Older messages have none.
   */
  authorName?: string;
  text: string;
  createdAt: number;
  /** Teachers (or an unlocked admin) can pin messages to the top. */
  pinned: boolean;
  /** Optional file sent with the message. */
  attachment?: MessageAttachment;
  /** Set on soft delete: cleared content leaves a tombstone in the thread. */
  deletedBy?: "author" | "teacher";
  /** Account that removed the message, shown in the tombstone. */
  deletedByName?: string;
}

/**
 * Everything that belongs to one class. Each class has
 * its own media vault, folders, practice entries, chat, and attendance; only
 * the Google Drive connection is shared, because that lives on the account
 * rather than on the class.
 */
export interface ClassVaultData {
  media: MediaItem[];
  folders: Folder[];
  logs: PracticeEntry[];
  messages: ChatMessage[];
  /** Attendance marks for this class, one row per person per class day. */
  attendance: AttendanceEntry[];
  /**
   * Names the teacher has added to this class's sheet. The roll also picks up
   * every name the class already knows (practice entries, messages, and past
   * marks), so students never have to be entered twice.
   */
  attendanceRoster: string[];
  /**
   * The order teachers arranged the files in, as a list of media ids. Anything
   * not listed (a file uploaded before this existed) falls back to newest
   * first, so an untouched vault looks exactly as it did before.
   */
  mediaOrder: string[];
}

/**
 * What components read: the active class's data plus the app-wide settings.
 * Callers keep using `vault.media`, `vault.logs`, and so on, and get the
 * class they are currently in without any extra plumbing.
 */
export interface VaultState extends ClassVaultData {
  role: Role;
  /**
   * Admin-controlled switch: while false the Practice Log is greyed out and
   * unclickable for everyone. The value is authoritative on the Convex
   * deployment (convex/admin.ts) and mirrored into this local store so the
   * nav, dashboard, and page can gate themselves reactively.
   */
  practiceLogEnabled: boolean;
  /**
   * Admin-controlled switch: while true NatyaVault is open to the public and
   * other dance studios can sign up for their own vault on a storage plan.
   * Off by default, so the app ships as a private vault for one class. Like
   * the Practice Log switch, the Convex deployment holds the authoritative
   * value (convex/admin.ts) and this local copy mirrors it for the UI.
   */
  publicMode: boolean;
  /**
   * Per-account timestamp (ms) of the last time each account opened the
   * Messages page. A message is unread when it was sent by someone else and
   * is newer than this marker. Keyed by account name.
   */
  messagesSeen: Record<string, number>;
  /**
   * Join code of the class on screen, or null when this browser has no class
   * yet (nothing signed up, or an account with no class).
   */
  classCode: string | null;
  /**
   * How much content is still in the pre-classes vault. A browser that was
   * used before classes existed keeps its old content in the class-less
   * bucket until the owner moves it into a class.
   */
  classless: {
    media: number;
    logs: number;
    messages: number;
    attendance: number;
  };
}

/**
 * What is actually written to localStorage: one bucket of class data per join
 * code, so every class keeps its own vault. The "" key is the class-less
 * bucket — where a vault from before classes existed is migrated to.
 */
interface StoredState {
  role: Role;
  practiceLogEnabled: boolean;
  publicMode: boolean;
  messagesSeen: Record<string, number>;
  activeClassCode: string;
  classes: Record<string, ClassVaultData>;
}

export const STORAGE_KEY = "natyavault.v1";

/** Files larger than this become session-only (localStorage quota). */
export const MAX_PERSISTENT_BYTES = 4 * 1024 * 1024;

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Ids of the placeholder content older builds seeded into every vault —
 * sample clips, talam tracks, practice logs, and a demo chat thread, all
 * credited to invented people. Fresh vaults start empty, and any existing
 * vault is scrubbed of these on load so no fabricated name survives.
 */
const DEMO_MEDIA_IDS = new Set([
  "m-video-1",
  "m-video-2",
  "m-video-3",
  "m-audio-1",
  "m-audio-2",
  "m-audio-3",
  "m-audio-4",
]);
const DEMO_FOLDER_IDS = new Set([
  "folder-varnam",
  "folder-varnam-jathis",
  "folder-talam",
  "folder-adavus",
]);
const DEMO_LOG_IDS = new Set(["p-1", "p-2", "p-3", "p-4", "p-5", "p-6", "p-7"]);
const DEMO_MESSAGE_IDS = new Set(["msg-1", "msg-2"]);

/** An empty vault for a class that has nothing in it yet. */
function emptyClass(): ClassVaultData {
  return {
    media: [],
    folders: [],
    logs: [],
    messages: [],
    attendance: [],
    attendanceRoster: [],
    mediaOrder: [],
  };
}

/**
 * A brand-new store: the shipped switches (Practice Log off, public launch
 * off) and one empty, class-less vault under the "" key.
 */
function seed(): StoredState {
  return {
    role: "student",
    // Ships off — the admin turns the Practice Log on from the Admin area.
    practiceLogEnabled: false,
    // Ships private — the admin opens the public launch from the Admin area.
    publicMode: false,
    messagesSeen: {},
    activeClassCode: "",
    classes: { "": emptyClass() },
  };
}

/** Read one class bucket out of stored JSON, tolerating anything missing. */
function readClass(data: Partial<ClassVaultData> | undefined): ClassVaultData {
  return {
    media: Array.isArray(data?.media) ? data.media : [],
    folders: Array.isArray(data?.folders) ? data.folders : [],
    logs: Array.isArray(data?.logs) ? data.logs : [],
    messages: Array.isArray(data?.messages) ? data.messages : [],
    attendance: Array.isArray(data?.attendance) ? data.attendance : [],
    attendanceRoster: Array.isArray(data?.attendanceRoster)
      ? data.attendanceRoster.filter(
          (name): name is string => typeof name === "string",
        )
      : [],
    mediaOrder: Array.isArray(data?.mediaOrder)
      ? data.mediaOrder.filter((id): id is string => typeof id === "string")
      : [],
  };
}

/** Strip the old demo content out of one class's vault. */
function scrubClass(data: ClassVaultData): ClassVaultData {
  const folders = data.folders.filter((f) => !DEMO_FOLDER_IDS.has(f.id));
  const folderIds = new Set(folders.map((f) => f.id));
  const media = data.media
    .filter((m) => !DEMO_MEDIA_IDS.has(m.id))
    .map((m) =>
      m.folderId && !folderIds.has(m.folderId)
        ? { ...m, folderId: undefined }
        : m,
    );
  const logs = data.logs.filter((l) => !DEMO_LOG_IDS.has(l.id));
  const messages = data.messages.filter((m) => !DEMO_MESSAGE_IDS.has(m.id));
  return { ...data, media, folders, logs, messages };
}

function load(): StoredState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const fresh = seed();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
      return fresh;
    }
    const parsed = JSON.parse(raw) as Partial<StoredState> &
      Partial<ClassVaultData> & {
        classes?: Record<string, Partial<ClassVaultData>>;
      };

    const switches = {
      practiceLogEnabled: parsed.practiceLogEnabled === true,
      publicMode: parsed.publicMode === true,
      messagesSeen:
        parsed.messagesSeen && typeof parsed.messagesSeen === "object"
          ? (parsed.messagesSeen as Record<string, number>)
          : {},
    };

    // Current shape: one bucket of content per class join code.
    if (parsed.classes && typeof parsed.classes === "object") {
      const classes: Record<string, ClassVaultData> = {};
      for (const [code, data] of Object.entries(parsed.classes)) {
        classes[code] = scrubClass(readClass(data));
      }
      const activeClassCode =
        typeof parsed.activeClassCode === "string" &&
        classes[parsed.activeClassCode]
          ? parsed.activeClassCode
          : (Object.keys(classes)[0] ?? "");
      return {
        role: parsed.role === "teacher" ? "teacher" : "student",
        activeClassCode,
        classes,
        ...switches,
      };
    }

    // Vault written before classes existed: it becomes the class-less bucket,
    // so nothing anyone already had is lost.
    return {
      role: parsed.role === "teacher" ? "teacher" : "student",
      activeClassCode: "",
      classes: { "": scrubClass(readClass(parsed)) },
      ...switches,
    };
  } catch {
    return seed();
  }
}

let state: StoredState = load();
let snapshot: VaultState = derive(state);
const listeners = new Set<() => void>();

/** Project the active class's data plus the app-wide settings for components. */
function derive(current: StoredState): VaultState {
  const data = current.classes[current.activeClassCode] ?? emptyClass();
  return {
    role: current.role,
    practiceLogEnabled: current.practiceLogEnabled,
    publicMode: current.publicMode,
    messagesSeen: current.messagesSeen,
    classCode: current.activeClassCode === "" ? null : current.activeClassCode,
    classless: classlessSummary(current),
    ...data,
  };
}

/** Counts of the content sitting in the class-less (pre-classes) vault. */
function classlessSummary(current: StoredState) {
  const data = current.classes[""] ?? emptyClass();
  return {
    media: data.media.length,
    logs: data.logs.length,
    messages: data.messages.length,
    attendance: data.attendance.length,
  };
}

/** The active class's data (never null, even for the class-less bucket). */
function activeClass(): ClassVaultData {
  return state.classes[state.activeClassCode] ?? emptyClass();
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    toast.error(
      "Browser storage is full — this change lives only until you refresh.",
    );
    return false;
  }
}

/** Write the whole store, refresh the snapshot, and tell React about it. */
function commit(next: StoredState) {
  state = next;
  snapshot = derive(next);
  persist();
  listeners.forEach((l) => l());
}

/** Change only the class that is currently on screen. */
function updateClassData(
  patch: (data: ClassVaultData) => Partial<ClassVaultData>,
) {
  const code = state.activeClassCode;
  const current = state.classes[code] ?? emptyClass();
  commit({
    ...state,
    classes: { ...state.classes, [code]: { ...current, ...patch(current) } },
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Reactive read of the class on screen. */
export function useVault(): VaultState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
}

/** Non-reactive read (for event handlers). */
export function getVault(): VaultState {
  return snapshot;
}

// ------------------------------------------------------------ class buckets

/** Join codes this browser already holds vault data for. */
export function storedClassCodes(): string[] {
  return Object.keys(state.classes).filter((code) => code !== "");
}

/**
 * Move the whole pre-classes vault into a class. Folders, files, practice
 * entries, messages, and attendance marks are merged into `code` (a new class
 * is normally still empty), and the class-less bucket is emptied so the
 * content is never in two places at once.
 */
export function adoptClasslessVault(code: string) {
  if (code === "") return;
  const source = state.classes[""] ?? emptyClass();
  const target = state.classes[code] ?? emptyClass();
  const summary = classlessSummary(state);
  if (
    summary.media + summary.logs + summary.messages + summary.attendance ===
      0 &&
    source.folders.length === 0
  ) {
    return;
  }
  commit({
    ...state,
    classes: {
      ...state.classes,
      [code]: {
        media: [...target.media, ...source.media],
        folders: [...target.folders, ...source.folders],
        logs: [...target.logs, ...source.logs],
        messages: [...target.messages, ...source.messages],
        attendance: [...target.attendance, ...source.attendance],
        attendanceRoster: [
          ...new Set([...target.attendanceRoster, ...source.attendanceRoster]),
        ],
        mediaOrder: [...target.mediaOrder, ...source.mediaOrder],
      },
      "": emptyClass(),
    },
  });
}

/**
 * Show another class's vault — `null` for the class-less bucket. The bucket is
 * created empty on first use, so every class starts with a clean vault.
 */
export function setActiveClass(code: string | null) {
  const key = code ?? "";
  if (state.activeClassCode === key) return;
  const classes = state.classes[key]
    ? state.classes
    : { ...state.classes, [key]: emptyClass() };
  commit({ ...state, activeClassCode: key, classes });
}

/**
 * Forget a class this browser kept a vault for — used when the class itself is
 * deleted. Its files, logs, and messages stop taking up storage and the code
 * stops being listed. If it was the class on screen, the app falls back to the
 * class-less bucket until another class is opened.
 */
export function forgetClass(code: string) {
  if (code === "" || state.classes[code] === undefined) return;
  const classes = { ...state.classes };
  delete classes[code];
  commit({
    ...state,
    classes,
    activeClassCode:
      state.activeClassCode === code ? "" : state.activeClassCode,
  });
}

// ---------------------------------------------------------------- actions

export function setRole(role: Role) {
  commit({ ...state, role });
}

/**
 * Admin control: turn the Practice Log on or off for everyone. Called after
 * the authoritative value is read from the Convex deployment.
 */
export function setPracticeLogEnabled(enabled: boolean) {
  if (state.practiceLogEnabled === enabled) return;
  commit({ ...state, practiceLogEnabled: enabled });
}

/**
 * Admin control: open or close the public launch for everyone. Called after
 * the authoritative value is read from the Convex deployment.
 */
export function setPublicMode(enabled: boolean) {
  if (state.publicMode === enabled) return;
  commit({ ...state, publicMode: enabled });
}

/**
 * Send a message as the current role (student/teacher). `text` may be empty
 * when a file is attached, so a photo or clip can be sent on its own.
 *
 * `authorName` is the signed-in account, stored so deletion can be limited to
 * the sender's own messages even when several people share a role.
 */
export function addMessage(
  text: string,
  authorName: string,
  attachment?: MessageAttachment,
) {
  const trimmed = text.trim();
  if (!trimmed && !attachment) return;
  const message: ChatMessage = {
    id: uid(),
    author: state.role,
    authorName,
    text: trimmed,
    createdAt: Date.now(),
    pinned: false,
    ...(attachment ? { attachment } : {}),
  };
  updateClassData((data) => ({ messages: [...data.messages, message] }));
}

/** Pin/unpin a message (teacher or unlocked admin only — gated in the UI). */
export function togglePinMessage(id: string) {
  updateClassData((data) => ({
    messages: data.messages.map((m) =>
      m.id === id ? { ...m, pinned: !m.pinned } : m,
    ),
  }));
}

/**
 * Soft-delete a message: the content is cleared but a tombstone stays in
 * the thread, recording whether it was removed by its author or by the
 * teacher. Callers gate who may delete (teacher, or the author themselves).
 */
export function removeMessage(id: string, deletedBy: "author" | "teacher") {
  updateClassData((data) => ({
    messages: data.messages.map((m) => {
      if (m.id !== id) return m;
      // Drop the attachment too, so deleted files don't linger in the store.
      const rest = { ...m };
      delete rest.attachment;
      // Remember who removed it, for the tombstone text.
      const deletedByName =
        deletedBy === "author" ? rest.authorName : undefined;
      return {
        ...rest,
        text: "",
        pinned: false,
        deletedBy,
        ...(deletedByName ? { deletedByName } : {}),
      };
    }),
  }));
}

// ------------------------------------------------------- unread messages

/**
 * Messages the account hasn't seen yet: not sent by the account itself, not
 * soft-deleted, and newer than the last time the account opened Messages.
 */
export function unreadMessageCount(
  vault: VaultState,
  accountName: string,
): number {
  const seen = vault.messagesSeen[accountName] ?? 0;
  return vault.messages.filter(
    (m) => !m.deletedBy && m.authorName !== accountName && m.createdAt > seen,
  ).length;
}

/** Mark every current message as read for the account (called on Messages). */
export function markMessagesSeen(accountName: string) {
  const current = state.messagesSeen[accountName] ?? 0;
  const newest = activeClass().messages.reduce(
    (max, m) => (m.createdAt > max ? m.createdAt : max),
    0,
  );
  const next = Math.max(current, newest, Date.now());
  if (next <= current) return;
  commit({
    ...state,
    messagesSeen: { ...state.messagesSeen, [accountName]: next },
  });
}

export function addMedia(item: Omit<MediaItem, "id" | "createdAt">) {
  const media: MediaItem = { ...item, id: uid(), createdAt: Date.now() };
  updateClassData((data) => ({
    media: [media, ...data.media],
    // A fresh upload goes to the front, wherever staff put the older files.
    mediaOrder: [media.id, ...data.mediaOrder],
  }));
  return media;
}

export function removeMedia(id: string) {
  updateClassData((data) => ({
    media: data.media.filter((m) => m.id !== id),
    mediaOrder: data.mediaOrder.filter((mediaId) => mediaId !== id),
  }));
}

/** Rename a file and/or move it into a folder (null = the vault root). */
export function updateMedia(
  id: string,
  patch: { title?: string; folderId?: string | null },
) {
  updateClassData((data) => ({
    media: data.media.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

/** A folder to create during a Google Drive import. */
export interface DriveImportFolder {
  /** Temporary key identifying the folder within one import. */
  key: string;
  name: string;
  /** Parent folder key, or null for the import's target folder. */
  parentKey: string | null;
}

/** A media file to create during a Google Drive import. */
export interface DriveImportFile {
  title: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  /** Google Drive file id — playback resolves a URL on demand. */
  driveFileId: string;
  /** Folder key this file lives in, or null for the target folder. */
  folderKey: string | null;
  performer: string;
  uploadedBy: string;
  date: string;
}

/**
 * Recreate a Google Drive folder tree in the vault in a single write: folders
 * are created first (parents before children), then each file is attached to
 * its folder. `targetFolderId` is where the top-level folders and files land
 * (null = the vault root).
 */
export function importFromDrive(
  folders: DriveImportFolder[],
  files: DriveImportFile[],
  targetFolderId: string | null,
): { folders: number; media: number } {
  if (folders.length === 0 && files.length === 0) {
    return { folders: 0, media: 0 };
  }
  const keyToId = new Map<string, string>();
  const newFolders: Folder[] = folders.map((folder) => {
    const parentId =
      folder.parentKey === null
        ? targetFolderId
        : (keyToId.get(folder.parentKey) ?? targetFolderId);
    const created: Folder = {
      id: uid(),
      name: folder.name,
      parentId,
      createdAt: Date.now(),
    };
    keyToId.set(folder.key, created.id);
    return created;
  });
  const newMedia: MediaItem[] = files.map((file) => ({
    id: uid(),
    kind: file.kind,
    title: file.title,
    performer: file.performer,
    uploadedBy: file.uploadedBy,
    folderId:
      file.folderKey === null
        ? targetFolderId
        : (keyToId.get(file.folderKey) ?? targetFolderId),
    date: file.date,
    createdAt: Date.now(),
    src: `drive:${file.driveFileId}`,
    storage: "drive",
    mimeType: file.mimeType,
    driveFileId: file.driveFileId,
  }));
  updateClassData((data) => ({
    folders: [...data.folders, ...newFolders],
    media: [...newMedia, ...data.media],
    mediaOrder: [...newMedia.map((m) => m.id), ...data.mediaOrder],
  }));
  return { folders: newFolders.length, media: newMedia.length };
}

export function addLog(entry: Omit<PracticeEntry, "id" | "createdAt">) {
  const log: PracticeEntry = { ...entry, id: uid(), createdAt: Date.now() };
  updateClassData((data) => ({ logs: [log, ...data.logs] }));
  return log;
}

export function removeLog(id: string) {
  updateClassData((data) => ({
    logs: data.logs.filter((l) => l.id !== id),
  }));
}

// ------------------------------------------------------------- attendance

/**
 * The people the class sheet lists, alphabetically: the names the teacher
 * added plus everyone the vault already knows about (practice entries,
 * messages, and previous marks). The signed-in account is added by the page,
 * so a brand-new vault still has a row for its owner.
 */
export function classRoster(vault: VaultState): string[] {
  const names = new Set<string>();
  for (const name of vault.attendanceRoster) names.add(name);
  for (const entry of vault.attendance) names.add(entry.name);
  for (const log of vault.logs) names.add(log.author);
  for (const message of vault.messages) {
    if (message.authorName) names.add(message.authorName);
  }
  return [...names]
    .filter((name) => name.trim().length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * The names on a class's attendance sheet, alphabetically.
 *
 * Three sources come together: what this browser's vault knows (practice
 * entries, messages, names left over from before attendance was shared), the
 * accounts that joined the class on the deployment, and the names a teacher
 * added there — so everyone in the class shows up for both the teacher and the
 * students, whichever device they are on.
 *
 * A teacher is never on the sheet and can never be marked. The class's staff
 * (owner and any teacher account) is removed, and a teacher's own name is
 * removed too, even though their practice entries and messages would otherwise
 * put it on the roll. `blocked` is returned so callers can refuse to mark
 * those names as well.
 */
export function attendanceSheetNames(
  vault: VaultState,
  options: {
    /** Signed-in account name. */
    accountName: string;
    /** True when the signed-in account is the teacher. */
    viewerIsTeacher: boolean;
    /** Students who joined the class (from the deployment). */
    students?: string[];
    /** Names the teacher added by hand (from the deployment). */
    added?: string[];
    /** The class's staff — owner and any teacher (from the deployment). */
    teachers?: string[];
  },
): { names: string[]; blocked: string[] } {
  const key = (name: string) => name.trim().toLowerCase();
  const blocked = new Set<string>();
  for (const name of options.teachers ?? []) {
    if (key(name)) blocked.add(key(name));
  }
  if (options.viewerIsTeacher) blocked.add(key(options.accountName));

  const names = new Set<string>();
  for (const name of classRoster(vault)) names.add(name);
  for (const name of options.students ?? []) names.add(name);
  for (const name of options.added ?? []) names.add(name);
  // A student always gets a row, even before anything else knows their name.
  if (!options.viewerIsTeacher) names.add(options.accountName);

  return {
    names: [...names]
      .filter((name) => name.trim().length > 0 && !blocked.has(key(name)))
      .sort((a, b) => a.localeCompare(b)),
    blocked: [...blocked],
  };
}

/**
 * The mark recorded for one person on one day, or null when unmarked. `marks`
 * are the class's marks from the deployment (see useClassAttendance).
 */
export function attendanceFor(
  marks: AttendanceEntry[],
  date: string,
  name: string,
): AttendanceEntry | null {
  return marks.find((e) => e.date === date && e.name === name) ?? null;
}

/** Month-to-date attendance summary for one person. */
export function attendanceSummary(
  marks: AttendanceEntry[],
  name: string,
): { present: number; late: number; absent: number; away: number; total: number } {
  const prefix = new Date().toISOString().slice(0, 7);
  const mine = marks.filter(
    (e) => e.name === name && e.date.startsWith(prefix),
  );
  return {
    present: mine.filter((e) => e.status === "present").length,
    late: mine.filter((e) => e.status === "late").length,
    absent: mine.filter((e) => e.status === "absent").length,
    away: mine.filter((e) => e.status === "away").length,
    total: mine.length,
  };
}

// ---------------------------------------------------------------- folders

/** Folders directly inside `parentId` (null = top level). */
export function childFolders(
  folders: Folder[],
  parentId: string | null,
): Folder[] {
  return folders.filter((f) => (f.parentId ?? null) === parentId);
}

/**
 * The chain of folders from the top level down to `id` (inclusive), used for
 * breadcrumbs and for labelling nested folders in pickers. Cycle-safe.
 */
export function folderPath(folders: Folder[], id: string | null): Folder[] {
  const path: Folder[] = [];
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const folder = folders.find((f) => f.id === current);
    if (!folder) break;
    path.unshift(folder);
    current = folder.parentId ?? null;
  }
  return path;
}

/** `id` plus every folder nested beneath it. */
export function folderSubtreeIds(
  folders: Folder[],
  id: string,
): string[] {
  const ids: string[] = [];
  const walk = (folderId: string) => {
    ids.push(folderId);
    for (const child of childFolders(folders, folderId)) walk(child.id);
  };
  walk(id);
  return ids;
}

/** Create a folder inside `parentId` (null = top level). */
export function addFolder(
  name: string,
  parentId: string | null = null,
): Folder | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const folder: Folder = {
    id: uid(),
    name: trimmed,
    parentId,
    createdAt: Date.now(),
  };
  updateClassData((data) => ({ folders: [...data.folders, folder] }));
  return folder;
}

export function renameFolder(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateClassData((data) => ({
    folders: data.folders.map((f) =>
      f.id === id ? { ...f, name: trimmed } : f,
    ),
  }));
}

/**
 * Move a folder — with every folder and file inside it — into another folder,
 * or back to the top level when `parentId` is null. Returns false when the
 * target doesn't exist or would put the folder inside itself.
 */
export function moveFolder(id: string, parentId: string | null): boolean {
  const data = activeClass();
  const folder = data.folders.find((f) => f.id === id);
  if (!folder) return false;
  const target = parentId ?? null;
  if (target !== null) {
    if (!data.folders.some((f) => f.id === target)) return false;
    if (folderSubtreeIds(data.folders, id).includes(target)) return false;
  }
  if ((folder.parentId ?? null) === target) return true;
  updateClassData(() => ({
    folders: data.folders.map((f) =>
      f.id === id ? { ...f, parentId: target } : f,
    ),
  }));
  return true;
}

/**
 * Delete a folder and every folder nested inside it; all files that were in
 * that subtree move back to the vault root — nothing is deleted.
 */
export function removeFolder(id: string) {
  const data = activeClass();
  const doomed = new Set(folderSubtreeIds(data.folders, id));
  updateClassData(() => ({
    folders: data.folders.filter((f) => !doomed.has(f.id)),
    media: data.media.map((m) =>
      m.folderId && doomed.has(m.folderId) ? { ...m, folderId: null } : m,
    ),
  }));
}

/**
 * Wipe every post, log, mark, and folder of the class on screen (the other
 * classes keep theirs) while keeping the account signed in.
 */
export function clearContent() {
  updateClassData(() => emptyClass());
}

// ------------------------------------------------------------- formatting

export function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(new Date(ts).toISOString().slice(0, 10));
}

/**
 * The media shown for a vault view.
 *
 * The general area (`folderId` null) shows every file — including the ones
 * kept inside a folder — while opening a folder narrows the list to just
 * that folder's own files.
 */
export function mediaForFolderView(
  items: MediaItem[],
  folderId: string | null,
): MediaItem[] {
  return folderId === null
    ? items
    : items.filter((m) => m.folderId === folderId);
}

/**
 * Files in the order staff arranged them. Files missing from the order (an
 * upload from before it existed, or one added on another device) come after
 * the arranged ones, newest first.
 */
export function orderMedia(
  items: MediaItem[],
  order: readonly string[] = [],
): MediaItem[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return b.createdAt - a.createdAt || b.date.localeCompare(a.date);
  });
}

/**
 * Drop `draggedId` where `targetId` sits, shifting the files in between — what
 * dragging one file onto another does. Returns false when either is unknown.
 */
export function reorderMedia(draggedId: string, targetId: string): boolean {
  if (draggedId === targetId) return false;
  const data = activeClass();
  const ids = orderMedia(data.media, data.mediaOrder).map((m) => m.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return false;
  // The dragged file takes the target's place; everything between shifts over.
  const next = ids.filter((id) => id !== draggedId);
  next.splice(next.indexOf(targetId), 0, draggedId);
  updateClassData(() => ({ mediaOrder: next }));
  return true;
}

/** Newest first. */
export function sortByRecency(items: MediaItem[]): MediaItem[] {
  return [...items].sort(
    (a, b) => b.createdAt - a.createdAt || b.date.localeCompare(a.date),
  );
}

// -------------------------------------------------------------- file utils

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Persist the file when it fits in localStorage, otherwise keep it for this
 * session only (blob URL) so large studio recordings still play right away.
 */
export async function storeFile(file: File): Promise<{
  src: string;
  storage: "persistent" | "session";
}> {
  if (file.size <= MAX_PERSISTENT_BYTES) {
    const src = await fileToDataUrl(file);
    // Verify it actually fits before committing.
    try {
      const probe = `natyavault.probe`;
      localStorage.setItem(probe, src);
      localStorage.removeItem(probe);
      return { src, storage: "persistent" };
    } catch {
      return { src: URL.createObjectURL(file), storage: "session" };
    }
  }
  return { src: URL.createObjectURL(file), storage: "session" };
}

// ------------------------------------------------- synth talam click tracks

const synthCache = new Map<string, string>();

function encodeWav8(data: Uint8Array<ArrayBuffer>, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + data.length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true); // byte rate (8-bit mono)
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  writeString(36, "data");
  view.setUint32(40, data.length, true);

  return new Blob([header, data], { type: "audio/wav" });
}

/**
 * Generates a metronome-style talam cycle (accented sam + plain beats) so the
 * demo vault has genuinely playable practice tracks without shipping binaries.
 */
function synthesize(beats: number, bpm: number, cycles: number): Blob {
  const sampleRate = 22050;
  const beatSec = 60 / Math.max(20, bpm);
  const totalBeats = beats * cycles;
  const length = Math.floor(totalBeats * beatSec * sampleRate);
  const data = new Uint8Array(length).fill(128);

  for (let b = 0; b < totalBeats; b++) {
    const start = Math.floor(b * beatSec * sampleRate);
    const isSam = b % beats === 0;
    const freq = isSam ? 1320 : 880;
    const amplitude = isSam ? 92 : 58;
    const clickLen = Math.min(
      Math.floor(0.06 * sampleRate),
      length - start,
    );
    for (let i = 0; i < clickLen; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-t * 70);
      const value = 128 + amplitude * env * Math.sin(2 * Math.PI * freq * t);
      data[start + i] = Math.max(0, Math.min(255, Math.round(value)));
    }
  }
  return encodeWav8(data, sampleRate);
}

/** Resolve a media `src` (synth specs become object URLs, cached). */
export function resolveSrc(src: string): string {
  if (!src.startsWith("synth:")) return src;
  const cached = synthCache.get(src);
  if (cached) return cached;
  const [, beats, bpm, cycles] = src.split(":");
  const blob = synthesize(
    Number(beats) || 8,
    Number(bpm) || 60,
    Number(cycles) || 4,
  );
  const url = URL.createObjectURL(blob);
  synthCache.set(src, url);
  return url;
}
