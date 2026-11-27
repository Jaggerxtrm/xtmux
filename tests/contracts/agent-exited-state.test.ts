// CORE-2801: a pane whose agent exited must not read as live.
import { describe, expect, it } from "bun:test";
import { applyExited } from "../../src/tmux.ts";

describe("applyExited", () => {
  it("reads a live state on a login shell as exited", () => {
    for (const shell of ["zsh", "bash", "sh", "fish"]) {
      expect(applyExited("running", shell)).toBe("exited");
      expect(applyExited("idle", shell)).toBe("exited");
      expect(applyExited("needs-input", shell)).toBe("exited");
      expect(applyExited("stale", shell)).toBe("exited");
    }
  });
  it("keeps the state while an agent process runs", () => {
    expect(applyExited("running", "claude")).toBe("running");
    expect(applyExited("running", "node")).toBe("running");
  });
  it("leaves terminal and unknown states alone", () => {
    expect(applyExited("done", "zsh")).toBe("done");
    expect(applyExited("off", "zsh")).toBe("off");
    expect(applyExited("unknown", "zsh")).toBe("unknown");
    expect(applyExited("running", undefined)).toBe("running");
  });
});
