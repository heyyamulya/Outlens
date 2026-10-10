// Users of this device and their color-vision type, saved only here (localStorage). No
// accounts, nothing sent anywhere. Two demo users are built in, so the demo can show
// different kinds of color blindness. Storage can fail (private mode, blocked site data),
// so reads and writes are wrapped and a copy is kept in memory for this visit.
// Read it in React with useSyncExternalStore(subscribeUsers, usersSnapshot, () => DEFAULT_USERS_JSON).

import type { CvdType } from "./cvd";

export type User = { id: string; name: string; type: CvdType };
export type UsersState = { users: User[]; activeId: string };

const KEY = "outlens.users.v1";
const EVENT = "outlens-users-change";

const DEFAULT_STATE: UsersState = {
  users: [
    { id: "maya", name: "Maya", type: "deutan" },
    { id: "leo", name: "Leo", type: "tritan" },
  ],
  activeId: "maya",
};
export const DEFAULT_USERS_JSON = JSON.stringify(DEFAULT_STATE);

let memory: string | null = null;

/** The saved state as a string (stable between calls, as React needs). */
export function usersSnapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? memory ?? DEFAULT_USERS_JSON;
  } catch {
    return memory ?? DEFAULT_USERS_JSON;
  }
}

export function subscribeUsers(onChange: () => void): () => void {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const TYPES = ["protan", "deutan", "tritan"];

export function parseUsers(raw: string): UsersState {
  try {
    const s = JSON.parse(raw) as UsersState;
    const users = (s?.users ?? []).filter(
      (u) => typeof u?.id === "string" && typeof u?.name === "string" && TYPES.includes(u?.type),
    );
    if (users.length === 0) return DEFAULT_STATE;
    const activeId = users.some((u) => u.id === s.activeId) ? s.activeId : users[0].id;
    return { users, activeId };
  } catch {
    return DEFAULT_STATE;
  }
}

export function saveUsers(state: UsersState) {
  memory = JSON.stringify(state);
  try {
    localStorage.setItem(KEY, memory);
  } catch {
    // Not saved on the device; the in-memory copy still works for this visit.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function activeUser(state: UsersState): User {
  return state.users.find((u) => u.id === state.activeId) ?? state.users[0];
}

/** Adds a user (name trimmed to 20 characters) and makes them active. */
export function addUser(state: UsersState, name: string, type: CvdType): UsersState {
  const clean = name.trim().slice(0, 20) || "New user";
  const id = `u${Date.now().toString(36)}`;
  return { users: [...state.users, { id, name: clean, type }], activeId: id };
}
