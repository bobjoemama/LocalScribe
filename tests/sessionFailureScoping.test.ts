import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

describe("renderer recorder failure scoping", () => {
  it("validates and carries the originating session through preload", () => {
    const preload = source("src/preload.ts");
    expect(preload).toContain("const input = sessionFailureSchema.parse(failure);");
    expect(preload).toContain("ipcRenderer.invoke(IPC.sessionFail, input)");
    expect(source("src/renderer/pill/Pill.tsx")).toContain(
      "window.localScribe.session.fail({ sessionId, message })",
    );
  });

  it("ignores a late renderer failure unless both main session authorities still match", () => {
    const main = source("src/main.ts");
    const start = main.indexOf("handle(IPC.sessionFail");
    const end = main.indexOf("handle(IPC.sessionBeginLive", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const handler = main.slice(start, end);
    expect(handler).toContain("sessionFailureSchema.parse(rawFailure)");
    expect(handler).toContain("activeSessionId !== failure.sessionId");
    expect(handler).toContain("session.sessionId !== failure.sessionId");
    expect(handler).toContain("return session;");
    expect(handler.indexOf("return session;")).toBeLessThan(handler.indexOf("failSession(failure.message)"));
  });
});
