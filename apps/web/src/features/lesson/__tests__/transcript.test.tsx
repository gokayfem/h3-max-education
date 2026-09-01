import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Transcript } from "../Transcript";
import type { TranscriptTurn } from "../types";

const turns: TranscriptTurn[] = [
  { turnId: "t1", role: "learner", text: "Why doesn't the Moon fall?", interrupted: false, final: true },
  { turnId: "t2", role: "tutor", text: "It is falling — but sideways too.", interrupted: true, final: true },
];
const activeTurn: TranscriptTurn = {
  turnId: "t3",
  role: "tutor",
  text: "Let me finish that thought.",
  interrupted: false,
  final: false,
};

describe("Transcript", () => {
  it("renders every turn with its role", () => {
    render(<Transcript turns={turns} textFor={(t) => t.text} />);
    expect(screen.getByText("Why doesn't the Moon fall?")).toBeTruthy();
    expect(screen.getByText("It is falling — but sideways too.")).toBeTruthy();
  });

  it("marks interrupted tutor turns", () => {
    render(<Transcript turns={turns} textFor={(t) => t.text} />);
    expect(screen.getByText("interrupted")).toBeTruthy();
  });

  it("shows a streaming caret only on the active turn", () => {
    const { container } = render(
      <Transcript turns={turns} activeTurn={activeTurn} textFor={(t) => t.text} />,
    );
    expect(container.querySelectorAll("[class*='caret']")).toHaveLength(1);
  });

  it("keeps the scroll region quiet so streaming deltas do not flood screen readers", () => {
    render(<Transcript turns={turns} textFor={(t) => t.text} />);
    const region = screen.getByRole("region", { name: "Live transcript" });
    expect(region.getAttribute("aria-live")).toBeNull();
    expect(region.querySelector("ol")).not.toBeNull();
  });

  it("announces only the latest final turn, never in-progress streams", () => {
    const { rerender } = render(
      <Transcript turns={turns} activeTurn={activeTurn} textFor={(t) => t.text} />,
    );
    expect(screen.getByRole("status").textContent).toBe("");

    const finished: TranscriptTurn[] = [...turns, { ...activeTurn, final: true }];
    rerender(<Transcript turns={finished} activeTurn={null} textFor={(t) => t.text} />);
    expect(screen.getByRole("status").textContent).toBe("Tutor: Let me finish that thought.");
  });

  it("appends an interruption note to the announcement", () => {
    const interruptedLast = [turns[0], turns[1]];
    render(<Transcript turns={interruptedLast} activeTurn={null} textFor={(t) => t.text} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Tutor: It is falling — but sideways too. Interrupted.",
    );
  });

  it("bounds the rendered turn window for long transcripts", () => {
    const longTranscript = Array.from({ length: 500 }, (_, index) => ({
      turnId: `turn-${index}`,
      role: index % 2 === 0 ? "learner" as const : "tutor" as const,
      text: `Turn ${index}`,
      interrupted: false,
      final: true,
    }));

    const { container } = render(
      <Transcript turns={longTranscript} activeTurn={null} textFor={(turn) => turn.text} />,
    );

    expect(container.querySelectorAll("li")).toHaveLength(5);
    expect(screen.getByText("Turn 499")).toBeTruthy();
    expect(screen.getByText("Turn 495")).toBeTruthy();
    expect(screen.queryByText("Turn 0")).toBeNull();
  });
});
