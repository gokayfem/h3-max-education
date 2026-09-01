/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusBar } from "../StatusBar";

describe("StatusBar", () => {
  it("labels an unavailable server allowance honestly", () => {
    render(
      <StatusBar
        status="text_only"
        quotaSecondsRemaining={null}
        quotaTotal={null}
      />,
    );

    expect(screen.getByText("Text only")).toBeInTheDocument();
    expect(screen.getByText("Visual allowance is currently unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("does not promise voice when text-only mode has exhausted its allowance", () => {
    render(
      <StatusBar
        status="text_only"
        quotaSecondsRemaining={0}
        quotaTotal={120}
      />,
    );

    expect(screen.getByText("Visual budget used — continuing with text and cards")).toBeInTheDocument();
    expect(screen.queryByText(/continuing with voice/i)).not.toBeInTheDocument();
  });

  it("renders the authoritative daily allowance", () => {
    render(
      <StatusBar
        status="listening"
        quotaSecondsRemaining={35}
        quotaTotal={90}
      />,
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "90");
    expect(screen.getByText("35s of daily visual generation remaining")).toBeInTheDocument();
  });
  it("offers an explicit recovery action for a recoverable connection error", () => {
    const onRetry = vi.fn();
    render(
      <StatusBar
        status="text_only"
        detail="The connection stalled."
        quotaSecondsRemaining={null}
        quotaTotal={null}
        onRetry={onRetry}
      />,
    );

    screen.getByRole("button", { name: "Retry connection" }).click();

    expect(onRetry).toHaveBeenCalledOnce();
  });

});
