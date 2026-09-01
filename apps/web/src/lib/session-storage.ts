import { z } from "zod";

export const ACTIVE_SESSION_STORAGE_KEY = "axiom.activeSessionId";

const opaqueSessionIdSchema = z.string().uuid();

export function readActiveSessionId(storage: Storage = window.sessionStorage): string | null {
  const value = storage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  if (value === null) return null;
  const parsed = opaqueSessionIdSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  storage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
  return null;
}

export function writeActiveSessionId(sessionId: string, storage: Storage = window.sessionStorage): void {
  storage.setItem(ACTIVE_SESSION_STORAGE_KEY, opaqueSessionIdSchema.parse(sessionId));
}

export function clearActiveSessionId(sessionId?: string, storage: Storage = window.sessionStorage): void {
  if (sessionId !== undefined && storage.getItem(ACTIVE_SESSION_STORAGE_KEY) !== sessionId) return;
  storage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
}
