import { describe, expect, it } from "vitest";
import { decideOnClose } from "../closeBehavior";

describe("decideOnClose", () => {
  it("is always silent when no session is alive, regardless of setting", () => {
    expect(decideOnClose("ask", false)).toBe("silent");
    expect(decideOnClose("keep-running", false)).toBe("silent");
    expect(decideOnClose("stop-all", false)).toBe("silent");
  });

  it("mirrors the setting when a session is alive", () => {
    expect(decideOnClose("ask", true)).toBe("ask");
    expect(decideOnClose("keep-running", true)).toBe("keep-running");
    expect(decideOnClose("stop-all", true)).toBe("stop-all");
  });
});
