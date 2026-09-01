import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "../Composer";

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    status: "listening" as const,
    micEnabled: true,
    micAvailable: true,
    onToggleMic: vi.fn(),
    onInterrupt: vi.fn(),
    ...overrides,
  };
  render(<Composer {...props} />);
  return props;
}

describe("Composer", () => {
  it("exposes only microphone input with no text composer", () => {
    renderComposer();

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toBeTruthy();
    expect(screen.getByText("Listening")).toBeTruthy();
  });

  it("toggles microphone audio input", () => {
    const props = renderComposer();

    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));

    expect(props.onToggleMic).toHaveBeenCalledOnce();
  });

  it("offers an audio interruption while H3 Max Realtime Education is responding", () => {
    const props = renderComposer({ status: "speaking" });

    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));

    expect(props.onInterrupt).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("requires voice reconnection when microphone audio is unavailable", () => {
    renderComposer({ status: "text_only", micEnabled: false, micAvailable: false });

    expect(screen.getByRole("button", { name: "Enable microphone" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Voice connection unavailable")).toBeTruthy();
    expect(screen.getByText("Reconnect voice to continue the lesson.")).toBeTruthy();
  });
});
