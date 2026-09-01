import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CardDock } from "../CardDock";
import type { CardSet } from "../types";

const set: CardSet = {
  purpose: "branch",
  prompt: "Where next?",
  revision: 7,
  cards: [
    { id: "a", title: "First branch", description: "Go left.", spokenAliases: [] },
    { id: "b", title: "Second branch", description: "Go right.", spokenAliases: [] },
  ],
};

describe("CardDock", () => {
  it("renders one card per option with purpose and prompt", () => {
    render(<CardDock cardSet={set} onSelect={() => {}} />);
    expect(screen.getByText("Choose a branch")).toBeTruthy();
    expect(screen.getByText("Where next?")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("clicking a card reports the card id and current revision", () => {
    const onSelect = vi.fn();
    render(<CardDock cardSet={set} onSelect={onSelect} />);
    fireEvent.click(screen.getByText("First branch"));
    expect(onSelect).toHaveBeenCalledWith("a", 7);
  });

  it("number keys select cards without focusing them", () => {
    const onSelect = vi.fn();
    render(<CardDock cardSet={set} onSelect={onSelect} />);
    fireEvent.keyDown(window, { key: "2" });
    expect(onSelect).toHaveBeenCalledWith("b", 7);
  });

  it("number keys are ignored while typing in an input", () => {
    const onSelect = vi.fn();
    render(
      <div>
        <input aria-label="composer" />
        <CardDock cardSet={set} onSelect={onSelect} />
      </div>,
    );
    const input = screen.getByLabelText("composer");
    fireEvent.keyDown(input, { key: "1" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not select while disabled", () => {
    const onSelect = vi.fn();
    render(<CardDock cardSet={set} onSelect={onSelect} disabled />);
    fireEvent.click(screen.getByText("First branch"));
    fireEvent.keyDown(window, { key: "1" });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("exposes screen-reader descriptions for each card", () => {
    render(<CardDock cardSet={set} onSelect={() => {}} />);
    expect(
      screen.getByLabelText("Option 1 of 2: First branch. Go left."),
    ).toBeTruthy();
  });

  it("announces the option count and number-key shortcuts once per card set", () => {
    render(<CardDock cardSet={set} onSelect={() => {}} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Choose a branch. Where next? 2 options available; press keys 1 through 2 to choose.",
    );
  });

  it("restores focus to the first card when a revised set replaces the focused one", () => {
    const revised: CardSet = {
      ...set,
      revision: 8,
      prompt: "New checkpoint?",
      cards: [
        { id: "c", title: "Third branch", description: "Go up.", spokenAliases: [] },
        { id: "d", title: "Fourth branch", description: "Go down.", spokenAliases: [] },
      ],
    };
    const { rerender } = render(<CardDock cardSet={set} onSelect={() => {}} />);
    const firstCard = screen.getByLabelText("Option 1 of 2: First branch. Go left.");
    firstCard.focus();
    expect(document.activeElement).toBe(firstCard);

    rerender(<CardDock cardSet={revised} onSelect={() => {}} />);
    const replacement = screen.getByLabelText("Option 1 of 2: Third branch. Go up.");
    expect(document.activeElement).toBe(replacement);
  });

  it("leaves focus alone on revision changes when the dock was not focused", () => {
    const revised: CardSet = { ...set, revision: 8 };
    const { rerender } = render(<CardDock cardSet={set} onSelect={() => {}} />);
    rerender(<CardDock cardSet={revised} onSelect={() => {}} />);
    expect(document.activeElement).toBe(document.body);
  });
});
