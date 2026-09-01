import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthError, getSession } from "@/lib/server/auth";
import LearnPage from "./page";

vi.mock("@/lib/server/auth", () => ({
  AuthError: class AuthError extends Error {
    constructor(
      readonly status: 401 | 403,
      readonly code: "authentication_required" | "invalid_origin",
      message: string,
    ) {
      super(message);
      this.name = "AuthError";
    }
  },
  getSession: vi.fn(),
}));

vi.mock("./LearnClient", () => ({
  LearnClient: ({ learnerId }: { learnerId?: string }) => (
    <div data-testid="learn-client">{learnerId ?? "new-guest"}</div>
  ),
}));

const mockedGetSession = vi.mocked(getSession);

describe("LearnPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the learner identity from a valid session cookie", async () => {
    mockedGetSession.mockResolvedValue({
      v: 1,
      sid: "registry-session",
      learnerId: "learner-existing",
      displayName: "Guest",
      ageBand: "13-15",
    });

    render(await LearnPage());

    expect(screen.getByTestId("learn-client").textContent).toBe(
      "learner-existing",
    );
  });

  it("lets the client provision a guest when no session cookie exists", async () => {
    mockedGetSession.mockResolvedValue(null);

    render(await LearnPage());

    expect(screen.getByTestId("learn-client").textContent).toBe("new-guest");
  });

  it("lets the client replace an expired or invalid session cookie", async () => {
    mockedGetSession.mockRejectedValue(
      new AuthError(401, "authentication_required", "Session expired."),
    );

    render(await LearnPage());

    expect(screen.getByTestId("learn-client").textContent).toBe("new-guest");
  });

  it("does not hide registry availability failures", async () => {
    mockedGetSession.mockRejectedValue(new Error("registry unavailable"));

    await expect(LearnPage()).rejects.toThrow("registry unavailable");
  });
});
