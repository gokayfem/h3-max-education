/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LessonSession } from "../types";
import { LessonView } from "../LessonShell";

vi.mock("../ScienceCanvas", () => ({ ScienceCanvas: () => <div /> }));
vi.mock("../Transcript", () => ({ Transcript: () => <div /> }));
vi.mock("../CardDock", () => ({ CardDock: () => <div /> }));
vi.mock("../MasteryRail", () => ({ MasteryRail: () => <div /> }));
vi.mock("../TopicGraph", () => ({ TopicGraph: () => <div /> }));
vi.mock("../StatusBar", () => ({ StatusBar: () => <div /> }));
vi.mock("../Composer", () => ({ Composer: () => <div /> }));

function lessonSession(overrides: Partial<LessonSession> = {}): LessonSession {
  return {
    status: "listening",
    turns: [],
    activeCards: null,
    mastery: [],
    graph: { nodes: [], edges: [], activeId: "" },
    visual: null,
    quotaSecondsRemaining: null,
    micEnabled: true,
    micAvailable: true,
    sendText: vi.fn(),
    selectCard: vi.fn(),
    interrupt: vi.fn(),
    toggleMic: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe("LessonView session truth", () => {
  it("treats a manual end as abandonment rather than inferred completion", () => {
    const close = vi.fn();
    render(<LessonView session={lessonSession({ close })} />);

    expect(screen.getByRole("button", { name: "End session" })).toHaveTextContent("End session");

    fireEvent.click(screen.getByRole("button", { name: "End session" }));

    expect(close).toHaveBeenCalledWith("abandoned");
  });

  it("describes saved learning without promising a nonexistent profile view", () => {
    render(<LessonView session={lessonSession({ status: "ended" })} />);

    expect(screen.getByText("Session ended. Your learning is saved for the next session.")).toBeInTheDocument();
    expect(screen.queryByText(/saved to your profile/i)).not.toBeInTheDocument();
  });
});
