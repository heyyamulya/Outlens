// The user's color-vision profile, saved only on this device (localStorage). No account,
// nothing sent anywhere. Storage can fail (private mode, blocked site data), so every read
// and write is wrapped, and a copy is kept in memory so the choice still works this visit.
// Read it in React with useSyncExternalStore(subscribeProfile, profileSnapshot, () => null).

import type { CvdType } from "./cvd";

export type Profile = { type: CvdType | "unsure" };

const KEY = "outlens.profile.v1";
const EVENT = "outlens-profile-change";
let memory: string | null = null;

/** The saved profile as a string (stable between calls, as React needs), or null. */
export function profileSnapshot(): string | null {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

export function subscribeProfile(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function parseProfile(raw: string | null): Profile | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Profile;
    return ["protan", "deutan", "tritan", "unsure"].includes(p?.type) ? p : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: Profile) {
  memory = JSON.stringify(profile);
  try {
    localStorage.setItem(KEY, memory);
  } catch {
    // Not saved on the device; the in-memory copy still works for this visit.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** The type used for enhancement. "Not sure" uses deutan, the most common type. */
export function enhancementType(profile: Profile | null): CvdType {
  return profile && profile.type !== "unsure" ? profile.type : "deutan";
}
