import { describe, expect, it } from "vitest";
import { StreamingSubjectBuffer } from "./streaming-subjects";

describe("StreamingSubjectBuffer", () => {
  it("emits a stable subject before the tutor transcript finishes", () => {
    const buffer = new StreamingSubjectBuffer();

    expect(
      buffer.pushDelta(
        "turn-1",
        "Heat moves through metal as particles collide ",
      ),
    ).toEqual(["Heat moves through metal as particles collide"]);
    expect(buffer.pushDelta("turn-1", "and transfer energy ")).toEqual([]);
  });

  it("preserves spoken decimals when recognizing sentence boundaries", () => {
    const buffer = new StreamingSubjectBuffer();

    expect(
      buffer.pushDelta(
        "turn-1",
        "Water boils at 99.97 degrees Celsius. ",
      ),
    ).toEqual(["Water boils at 99.97 degrees Celsius"]);
  });

  it("emits consecutive subjects while the same tutor turn is streaming", () => {
    const buffer = new StreamingSubjectBuffer();

    expect(
      buffer.pushDelta(
        "turn-1",
        "Pressure squeezes the gas into a smaller volume. ",
      ),
    ).toEqual(["Pressure squeezes the gas into a smaller volume"]);
    expect(
      buffer.pushDelta(
        "turn-1",
        "Collisions with the container become more frequent. ",
      ),
    ).toEqual(["Collisions with the container become more frequent"]);
  });

  it("flushes a short useful remainder at final without duplicating emitted text", () => {
    const buffer = new StreamingSubjectBuffer();
    const fullText =
      "Heat moves through metal as particles collide and transfer energy. It spreads outward.";

    expect(
      buffer.pushDelta(
        "turn-1",
        "Heat moves through metal as particles collide ",
      ),
    ).toEqual(["Heat moves through metal as particles collide"]);
    expect(
      buffer.finish("turn-1", fullText, false),
    ).toEqual(["and transfer energy", "It spreads outward"]);
  });

  it("drops an interrupted remainder and bounds each tutor turn to six clips", () => {
    const buffer = new StreamingSubjectBuffer();
    const emitted = Array.from({ length: 8 }, (_, index) =>
      buffer.pushDelta(
        "turn-1",
        `Distinct scientific mechanism number ${index + 1} changes visibly. `,
      ),
    ).flat();

    expect(emitted).toHaveLength(6);
    expect(buffer.finish("turn-1", "unfinished explanation", true)).toEqual([]);
  });
});
