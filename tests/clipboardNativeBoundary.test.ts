import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { clipboardAdvancedExactlyOnce } from "../src/main/insertion/safeInsertion";

// No Electron process or general pasteboard is used in this test. The AppKit
// fixture owns a UUID-named pasteboard and releases it on exit.
vi.mock("electron", () => ({ clipboard: {}, nativeImage: {} }));

describe.skipIf(process.platform !== "darwin")("private AppKit pasteboard boundary", () => {
  it("distinguishes one text write from a concurrent same-text copy and rejects unsupported images", async () => {
    const { clipboardFormatMatchers } = await import("../src/main/insertion/electronClipboard");
    const source = `
import AppKit
import Foundation
let board = NSPasteboard(name: NSPasteboard.Name("localscribe-test-" + UUID().uuidString))
defer { board.releaseGlobally() }
let before = board.changeCount
board.clearContents()
guard board.setString("synthetic dictation", forType: .string) else { fatalError("write failed") }
let afterWrite = board.changeCount
board.clearContents()
guard board.setString("synthetic dictation", forType: .string) else { fatalError("copy failed") }
let afterForeignCopy = board.changeCount
board.clearContents()
let item = NSPasteboardItem()
item.setData(Data("<svg/>".utf8), forType: NSPasteboard.PasteboardType("public.svg-image"))
guard board.writeObjects([item]) else { fatalError("image write failed") }
let formats = (board.types ?? []).map { $0.rawValue }
let payload: [String: Any] = ["before": before, "afterWrite": afterWrite,
  "afterForeignCopy": afterForeignCopy, "formats": formats]
let data = try JSONSerialization.data(withJSONObject: payload)
FileHandle.standardOutput.write(data)
`;
    const payload = JSON.parse(execFileSync("/usr/bin/swift", ["-e", source], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024,
    })) as { before: number; afterWrite: number; afterForeignCopy: number; formats: string[] };

    expect(clipboardAdvancedExactlyOnce(payload.before, payload.afterWrite)).toBe(true);
    expect(clipboardAdvancedExactlyOnce(payload.before, payload.afterForeignCopy)).toBe(false);
    expect(payload.formats).toContain("public.svg-image");
    expect(payload.formats.every(clipboardFormatMatchers.isRestorableFormat)).toBe(false);
  }, 35_000);
});
