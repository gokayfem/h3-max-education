import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScienceCanvas } from "../ScienceCanvas";
import type { VisualState } from "../types";

const visual: VisualState = {
  revision: 3,
  phase: "live",
  spec: {
    concept: "orbital motion",
    teachingIntent: "Connect velocity and gravity",
    visualDescription: "A planet follows a curved path around a star",
    durationSeconds: 5,
    continuityKey: "physics-orbits",
  },
};

describe("ScienceCanvas", () => {

  it("shows a static opening state before the first visual exists", () => {
    const videoRef = vi.fn();
    const { container } = render(
      <ScienceCanvas visual={null} videoRef={videoRef} />,
    );

    expect(screen.getByText("Your learning journey starts here")).toBeTruthy();
    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByText("Awaiting a concept")).toBeNull();
    expect(screen.queryByText("Ask a question to begin.")).toBeNull();
    expect(videoRef).not.toHaveBeenCalled();
  });

  it("does not substitute an animated diagram when no generated stream is attached", () => {
    const { container } = render(
      <ScienceCanvas visual={visual} />,
    );

    expect(container.querySelector("svg")).toBeNull();
    expect(container.querySelector("video")).toBeNull();
    expect(screen.getByText("Your learning journey starts here")).toBeTruthy();
  });

  it("keeps the opening message visible until the first video frame is ready", () => {
    const videoRef = vi.fn();
    const { container, rerender } = render(
      <ScienceCanvas visual={visual} videoRef={videoRef} videoReady={false} />,
    );

    expect(container.querySelector("video")).toHaveAttribute("data-ready", "false");
    expect(screen.getByText("Your learning journey starts here")).toBeTruthy();

    rerender(<ScienceCanvas visual={visual} videoRef={videoRef} videoReady />);

    expect(container.querySelector("video")).toHaveAttribute("data-ready", "true");
    expect(screen.queryByText("Your learning journey starts here")).toBeNull();
  });

  it("renders and attaches the generated stream when its first frame is ready", () => {
    const videoRef = vi.fn();
    const { container } = render(
      <ScienceCanvas visual={visual} videoRef={videoRef} videoReady />,
    );

    const video = container.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.loop).toBe(true);
    expect(container.querySelector("svg")).toBeNull();
    expect(videoRef).toHaveBeenCalledWith(expect.any(HTMLVideoElement));
    expect(screen.getByText("Continuous live visual")).toBeTruthy();
    expect(screen.getByLabelText(/Lesson visual: orbital motion/u).getAttribute("aria-label"))
      .not.toContain(visual.spec.visualDescription);
  });

  it("keeps the current scene visible without a changing-direction treatment", () => {
    const { container } = render(
      <ScienceCanvas
        visual={{ ...visual, phase: "redirecting" }}
        videoRef={vi.fn()}
        videoReady
      />,
    );

    expect(container.querySelector("video")).toBeTruthy();
    expect(screen.getByText("Continuous live visual")).toBeTruthy();
    expect(screen.queryByText("Changing direction…")).toBeNull();
  });

  it("never labels a preserved generated clip as unavailable", () => {
    render(
      <ScienceCanvas
        visual={{ ...visual, phase: "held", stopReason: "failed" }}
        videoRef={vi.fn()}
        videoReady
      />,
    );

    expect(screen.getByText("Continuous visual · holding current scene")).toBeTruthy();
    expect(screen.queryByText(/Visual unavailable/u)).toBeNull();
  });

});
