/**
 * Studios, as the app sees them.
 *
 * The platform admin can open several studios, so the shell keeps one selected:
 * it lives in this browser (per device, like the class that is on screen) and
 * every list that depends on it follows. A teacher's studio is decided by the
 * deployment and cannot be switched; a student only ever has their own.
 */
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useQuery } from "convex/react";
import { useCallback, useEffect, useState } from "react";

/** The studio the shell is looking at, remembered for this browser. */
const ACTIVE_STUDIO_KEY = "natyavault.studio.v1";
const STUDIO_EVENT = "natyavault:studio";

function readActiveStudio(): Id<"studios"> | null {
  try {
    return (localStorage.getItem(ACTIVE_STUDIO_KEY) as Id<"studios"> | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * The selected studio, shared by every component that asks for it.
 *
 * State is mirrored into localStorage and a window event, so a change made in
 * the sidebar switcher updates the class list, the Classes page and anything
 * else in the same render pass.
 */
export function useActiveStudio(): {
  studioId: Id<"studios"> | null;
  setStudioId: (id: string | null) => void;
} {
  const [studioId, setState] = useState<Id<"studios"> | null>(readActiveStudio);

  useEffect(() => {
    const sync = () => setState(readActiveStudio());
    window.addEventListener(STUDIO_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(STUDIO_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const setStudioId = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(ACTIVE_STUDIO_KEY, id);
      else localStorage.removeItem(ACTIVE_STUDIO_KEY);
    } catch {
      // Storage refused the write: the choice lasts this visit only.
    }
    window.dispatchEvent(new Event(STUDIO_EVENT));
    setState((id as Id<"studios"> | null) ?? null);
  }, []);

  return { studioId, setStudioId };
}

export interface StudioSummary {
  id: Id<"studios">;
  name: string;
  code: string;
  folderName: string;
  ownerName: string;
  members: number;
  classes: number;
  suspended: boolean;
}

/** Every studio — the platform admin's view. Empty for everyone else. */
export function useStudios(): {
  studios: StudioSummary[];
  ok: boolean;
  isLoading: boolean;
} {
  const data = useQuery(api.studios.listStudios);
  return {
    studios: (data?.studios ?? []) as StudioSummary[],
    ok: data?.ok ?? false,
    isLoading: data === undefined,
  };
}

/** The studio this account belongs to (null for the operator and students). */
export function useMyStudio(): {
  studio: {
    id: Id<"studios">;
    name: string;
    code: string;
    role: "owner" | "teacher" | "student";
    folderName: string;
    suspended: boolean;
  } | null;
  isPlatformAdmin: boolean;
  isLoading: boolean;
} {
  const data = useQuery(api.studios.myStudio);
  return {
    studio: data?.studio ?? null,
    isPlatformAdmin: data?.isPlatformAdmin ?? false,
    isLoading: data === undefined,
  };
}

/** The studio's Drive folder name, e.g. "nvshubhastudioofarts". */
export function studioFolderName(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
  return `nv${slug || "studio"}`;
}
