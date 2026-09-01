"use client";

import { useEffect, useState } from "react";
import { sessionEventSchema } from "@axiom/protocol";
import { z } from "zod";
import { LiveLessonShell } from "@/features/lesson/LiveLessonShell";
import {
  clearActiveSessionId,
  readActiveSessionId,
  writeActiveSessionId,
} from "@/lib/session-storage";
import {
  activeLessonStateSchema,
  sessionIdSchema,
} from "@/lib/server/session/schemas";

interface CreateSessionResponse {
  sessionId: string;
}
const recoverSessionResponseSchema = z.strictObject({
  sessionId: sessionIdSchema,
  state: activeLessonStateSchema,
  events: z.array(sessionEventSchema),
  cursor: z.number().int().nonnegative(),
});
const eventPageResponseSchema = z.strictObject({
  events: z.array(sessionEventSchema),
  nextCursor: z.number().int().nonnegative(),
});
const guestSessionResponseSchema = z.strictObject({
  learner: z.object({
    learnerId: z.string().min(1),
  }).passthrough(),
});

type RecoveredSession = z.infer<typeof recoverSessionResponseSchema>;

interface LessonRecovery {
  state: RecoveredSession["state"];
  events: RecoveredSession["events"];
}

interface LessonSession {
  sessionId: string;
  recovery?: LessonRecovery;
  backfillEvents: RecoveredSession["events"];
  backfillCursor: number | null;
}

async function createGuestSession(): Promise<string> {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) {
    throw new Error("H3 Max Realtime Education could not create a guest session. Please reload and try again.");
  }
  const parsed = guestSessionResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("H3 Max Realtime Education returned an invalid guest session.");
  }
  return parsed.data.learner.learnerId;
}

async function createNewSession(): Promise<string> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idempotencyKey: `lesson:${crypto.randomUUID()}` }),
  });
  if (!response.ok) {
    throw new Error("H3 Max Realtime Education could not prepare this lesson. Please reload and try again.");
  }
  const created = (await response.json()) as CreateSessionResponse;
  writeActiveSessionId(created.sessionId);
  return created.sessionId;
}

const RECOVERY_PAGE_SIZE = 100;

async function recoverStoredSession(sessionId: string): Promise<LessonSession | null> {
  const response = await fetch(
    `/api/session/${sessionId}/recover`,
    { cache: "no-store" },
  );
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    throw new Error("H3 Max Realtime Education could not recover this lesson. Please reload and try again.");
  }

  const body: unknown = await response.json().catch(() => undefined);
  const parsed = recoverSessionResponseSchema.safeParse(body);
  if (
    !parsed.success
    || parsed.data.sessionId !== sessionId
    || parsed.data.cursor !== parsed.data.events.length
  ) {
    return null;
  }

  return {
    sessionId,
    recovery: {
      state: parsed.data.state,
      events: [...parsed.data.state.lastEvents],
    },
    backfillEvents: parsed.data.events,
    backfillCursor: parsed.data.events.length === RECOVERY_PAGE_SIZE
      ? parsed.data.cursor
      : null,
  };
}

export interface LearnClientProps {
  readonly learnerId?: string;
}

export function LearnLoadingShell() {
  return (
    <main
      className="grid min-h-screen place-items-center bg-slate-950 px-6 text-slate-100"
      aria-busy="true"
    >
      <p role="status" className="text-sm font-medium tracking-wide text-slate-300">
        Preparing your science companion…
      </p>
    </main>
  );
}

export function LearnClient({ learnerId }: LearnClientProps) {
  const [activeLearnerId, setActiveLearnerId] = useState<string | null>(learnerId ?? null);

  const [lessonSession, setLessonSession] = useState<LessonSession | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [backfillError, setBackfillError] = useState<string | null>(null);
  const [backfillAttempt, setBackfillAttempt] = useState(0);

  useEffect(() => {
    const clearClosedSession = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail as { sessionId?: unknown } | null;
      if (typeof detail?.sessionId !== "string") return;
      const closedSessionId = detail.sessionId;
      clearActiveSessionId(closedSessionId);
      setLessonSession((current) =>
        current?.sessionId === closedSessionId
          ? { ...current, recovery: undefined, backfillEvents: [], backfillCursor: null }
          : current);
    };
    window.addEventListener("axiom:session-closed", clearClosedSession);
    return () => window.removeEventListener("axiom:session-closed", clearClosedSession);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const preparedLearnerId = learnerId ?? await createGuestSession();
        const storedSessionId = readActiveSessionId();
        let preparedSession: LessonSession;
        if (storedSessionId) {
          const recoveredSession = await recoverStoredSession(storedSessionId);
          if (recoveredSession) {
            preparedSession = recoveredSession;
          } else {
            clearActiveSessionId(storedSessionId);
            preparedSession = {
              sessionId: await createNewSession(),
              backfillEvents: [],
              backfillCursor: null,
            };
          }
        } else {
          preparedSession = {
            sessionId: await createNewSession(),
            backfillEvents: [],
            backfillCursor: null,
          };
        }
        if (!cancelled) {
          setActiveLearnerId(preparedLearnerId);
          setLessonSession(preparedSession);
        }
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : "H3 Max Realtime Education could not prepare this lesson.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [learnerId]);

  useEffect(() => {
    const sessionId = lessonSession?.sessionId;
    const cursor = lessonSession?.backfillCursor;
    if (!sessionId || cursor === null || cursor === undefined) return;
    const controller = new AbortController();
    void (async () => {
      const response = await fetch(
        `/api/session/${sessionId}/events?cursor=${cursor}&once=1`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) {
        if (!controller.signal.aborted) {
          if (response.status === 404 || response.status === 410) {
            setLessonSession((current) =>
              current?.sessionId === sessionId
                ? { ...current, backfillCursor: null }
                : current);
          } else {
            setBackfillError("Earlier lesson history could not be restored.");
          }
        }
        return;
      }
      const body: unknown = await response.json().catch(() => undefined);
      const parsed = eventPageResponseSchema.safeParse(body);
      if (
        !parsed.success
        || parsed.data.nextCursor !== cursor + parsed.data.events.length
      ) {
        if (!controller.signal.aborted) {
          setBackfillError("Earlier lesson history could not be restored.");
        }
        return;
      }
      if (!controller.signal.aborted) {
        setBackfillError(null);
        setLessonSession((current) =>
          current?.sessionId === sessionId && current.backfillCursor === cursor
            ? {
                ...current,
                backfillEvents: parsed.data.events,
                backfillCursor: parsed.data.events.length === RECOVERY_PAGE_SIZE
                  ? parsed.data.nextCursor
                  : null,
              }
            : current);
      }
    })().catch(() => {
      if (!controller.signal.aborted) {
        setBackfillError("Earlier lesson history could not be restored.");
      }
    });
    return () => controller.abort();
  }, [backfillAttempt, lessonSession?.backfillCursor, lessonSession?.sessionId]);

  if (bootError) {
    return <main><p role="alert">{bootError}</p></main>;
  }
  if (!lessonSession || !activeLearnerId) {
    return <LearnLoadingShell />;
  }
  return (
    <>
      {backfillError ? (
        <aside
          className="fixed inset-x-4 top-4 z-50 mx-auto flex max-w-xl items-center justify-between gap-4 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950 shadow-lg"
          role="alert"
        >
          <span>{backfillError}</span>
          <button
            className="font-semibold underline underline-offset-2"
            type="button"
            onClick={() => setBackfillAttempt((attempt) => attempt + 1)}
          >
            Retry
          </button>
        </aside>
      ) : null}
      <LiveLessonShell
        sessionId={lessonSession.sessionId}
        learnerId={activeLearnerId}
        initialState={lessonSession.recovery?.state}
        initialEvents={lessonSession.recovery?.events}
        backfillEvents={lessonSession.backfillEvents}
      />
    </>
  );
}
