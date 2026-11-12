import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBar } from "./StatusBar";

describe("StatusBar", () => {
  it("renders plain detail text without a link", () => {
    render(
      <StatusBar status="text_only" detail="Voice is unavailable." quotaSecondsRemaining={null} />,
    );

    expect(screen.getByText("Voice is unavailable.")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("turns a URL inside the detail into a link that opens in a new tab", () => {
    render(
      <StatusBar
        status="text_only"
        detail="Your fal.ai balance is exhausted. Top up at https://fal.ai/dashboard/billing, then retry voice."
        quotaSecondsRemaining={null}
      />,
    );

    const link = screen.getByRole("link", { name: "fal.ai/dashboard/billing" });
    expect(link).toHaveAttribute("href", "https://fal.ai/dashboard/billing");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link.closest("p")).toHaveAttribute("title", expect.stringContaining("Top up at"));
  });
});
