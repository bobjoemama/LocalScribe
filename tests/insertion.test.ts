import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clipboardAdvancedExactlyOnce,
  SafeInsertionCoordinator,
  sameTarget,
} from "../src/main/insertion/safeInsertion";
import type {
  ActiveTarget,
  ClipboardPort,
  ClipboardSnapshot,
  PasteInjectionResult,
  PlatformInsertionBridge,
} from "../src/main/insertion/types";

const electronMocks = vi.hoisted(() => ({
  availableFormats: vi.fn<() => string[]>(),
  readText: vi.fn<() => string>(),
  readHTML: vi.fn<() => string>(),
  readRTF: vi.fn<() => string>(),
  readImage: vi.fn<() => { isEmpty(): boolean; toPNG(): Buffer }>(),
  writeText: vi.fn(),
  write: vi.fn(),
  clear: vi.fn(),
  createFromBuffer: vi.fn((buffer: Buffer) => ({ png: buffer })),
}));

const inputMocks = vi.hoisted(() => ({
  keyTap: vi.fn(),
}));

vi.mock("electron", () => ({
  clipboard: {
    availableFormats: electronMocks.availableFormats,
    readText: electronMocks.readText,
    readHTML: electronMocks.readHTML,
    readRTF: electronMocks.readRTF,
    readImage: electronMocks.readImage,
    writeText: electronMocks.writeText,
    write: electronMocks.write,
    clear: electronMocks.clear,
  },
  nativeImage: { createFromBuffer: electronMocks.createFromBuffer },
}));
vi.mock("uiohook-napi", () => ({
  uIOhook: { keyTap: inputMocks.keyTap },
  UiohookKey: { Meta: 3675, Ctrl: 29, V: 47 },
}));

const TARGET_A: ActiveTarget = {
  platform: "darwin",
  processId: 41,
  applicationId: "com.example.Editor",
  windowFingerprint: "a".repeat(64),
  focusedEditable: true,
  focusedElementFingerprint: "f".repeat(64),
};
const TARGET_B: ActiveTarget = {
  ...TARGET_A,
  windowFingerprint: "b".repeat(64),
};

class FakeBridge implements PlatformInsertionBridge {
  sequence = 100;
  private sequenceReads = 0;

  constructor(
    private readonly targets: Array<ActiveTarget | null | Promise<ActiveTarget | null>>,
    private readonly onSequenceRead?: (readNumber: number, bridge: FakeBridge) => void,
  ) {}

  async captureActiveTarget(): Promise<ActiveTarget | null> {
    return await (this.targets.shift() ?? null);
  }

  async clipboardSequence(): Promise<number> {
    this.sequenceReads += 1;
    this.onSequenceRead?.(this.sequenceReads, this);
    return this.sequence;
  }
}

class FakeClipboard implements ClipboardPort {
  currentText = "old clipboard";
  restoreCalls: ClipboardSnapshot[] = [];

  constructor(
    private readonly bridge: FakeBridge,
    private readonly saved: ClipboardSnapshot = { text: "old clipboard", restorable: true },
  ) {}

  snapshot(): ClipboardSnapshot {
    return this.saved;
  }

  writeText(text: string): void {
    this.currentText = text;
    this.bridge.sequence += 1;
  }

  restore(snapshot: ClipboardSnapshot): void {
    this.restoreCalls.push(snapshot);
    this.currentText = snapshot.text ?? "";
    this.bridge.sequence += 1;
  }
}

function coordinator(
  bridge: FakeBridge,
  clipboard: FakeClipboard,
  paste: () => PasteInjectionResult | Promise<PasteInjectionResult> = () => ({ status: "injected" }),
  options: { pasteSettleMs?: number; sleep?: (milliseconds: number) => Promise<void> } = {},
): SafeInsertionCoordinator {
  return new SafeInsertionCoordinator(clipboard, bridge, { paste }, {
    pasteSettleMs: options.pasteSettleMs ?? 0,
    sleep: options.sleep ?? (async () => undefined),
  });
}

describe("safe insertion", () => {
  it("rechecks the captured target and restores only after target consumption is acknowledged", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge, {
      text: "plain",
      html: "<b>plain</b>",
      rtf: "{\\rtf1 plain}",
      imagePng: new Uint8Array([1, 2, 3]),
      restorable: true,
    });
    const paste = vi.fn(() => ({
      status: "injected" as const,
      consumptionAcknowledgement: Promise.resolve(),
    }));
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("pasted");

    expect(paste).toHaveBeenCalledOnce();
    expect(paste).toHaveBeenCalledWith(TARGET_A, 101);
    expect(clipboard.restoreCalls).toHaveLength(1);
  });

  it("reports a clipboard-backed paste when injection has no consumption acknowledgment", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn(() => ({ status: "injected" as const }));
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("pasted-with-copy");

    expect(paste).toHaveBeenCalledOnce();
    expect(clipboard.currentText).toBe("dictated");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("exposes the application identity captured at dictation start", async () => {
    const bridge = new FakeBridge([TARGET_A]);
    const insertion = coordinator(bridge, new FakeClipboard(bridge));

    insertion.beginSession();
    await expect(insertion.targetAppId()).resolves.toBe(TARGET_A.applicationId);
  });

  it("waits for start-target capture before exposing the profile identity", async () => {
    let releaseCapture!: (target: ActiveTarget | null) => void;
    const delayedTarget = new Promise<ActiveTarget | null>((resolve) => {
      releaseCapture = resolve;
    });
    const bridge = new FakeBridge([delayedTarget]);
    const insertion = coordinator(bridge, new FakeClipboard(bridge));

    insertion.beginSession();
    const pendingIdentity = insertion.targetAppId();
    let settled = false;
    void pendingIdentity.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseCapture(TARGET_A);
    await expect(pendingIdentity).resolves.toBe(TARGET_A.applicationId);
  });

  it("does not let a cancelled capture overwrite the next session identity", async () => {
    let releaseOldCapture!: (target: ActiveTarget | null) => void;
    const oldCapture = new Promise<ActiveTarget | null>((resolve) => {
      releaseOldCapture = resolve;
    });
    const bridge = new FakeBridge([oldCapture, TARGET_B]);
    const insertion = coordinator(bridge, new FakeClipboard(bridge));

    insertion.beginSession();
    insertion.cancelSession();
    insertion.beginSession();
    await expect(insertion.targetAppId()).resolves.toBe(TARGET_B.applicationId);

    releaseOldCapture(TARGET_A);
    await oldCapture;
    await expect(insertion.targetAppId()).resolves.toBe(TARGET_B.applicationId);
  });

  it("prevents native paste when cancellation arrives after the clipboard write", async () => {
    let releasePasteTarget!: (target: ActiveTarget | null) => void;
    const delayedPasteTarget = new Promise<ActiveTarget | null>((resolve) => {
      releasePasteTarget = resolve;
    });
    const bridge = new FakeBridge([TARGET_A, delayedPasteTarget]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn(() => ({ status: "injected" as const }));
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    const pendingInsertion = insertion.insert("dictated", true);
    await vi.waitFor(() => expect(clipboard.currentText).toBe("dictated"));

    insertion.cancelSession();
    releasePasteTarget(TARGET_A);

    await expect(pendingInsertion).resolves.toBe("copied");
    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("does not let a late insertion revive an already cancelled session", async () => {
    const bridge = new FakeBridge([TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const writeText = vi.spyOn(clipboard, "writeText");
    const paste = vi.fn(() => ({ status: "injected" as const }));
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    insertion.cancelSession();

    await expect(insertion.insert("late transcription", true)).resolves.toBe("copied");
    expect(writeText).not.toHaveBeenCalled();
    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("old clipboard");
  });

  it("invalidates a cancelled insertion while it is waiting in the serial queue", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A, TARGET_B]);
    const clipboard = new FakeClipboard(bridge);
    const writeText = vi.spyOn(clipboard, "writeText");
    let releaseFirstPaste!: () => void;
    const firstPasteGate = new Promise<void>((resolve) => {
      releaseFirstPaste = resolve;
    });
    const paste = vi.fn(async () => {
      await firstPasteGate;
      return { status: "injected" as const };
    });
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    const first = insertion.insert("first", true);
    await vi.waitFor(() => expect(paste).toHaveBeenCalledOnce());

    insertion.beginSession();
    const cancelledWhileQueued = insertion.insert("second", true);
    insertion.cancelSession();
    releaseFirstPaste();

    await expect(first).resolves.toBe("copied");
    await expect(cancelledWhileQueued).resolves.toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("first");
    expect(paste).toHaveBeenCalledTimes(1);
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("falls back to copy-only when the target changes", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_B]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("dictated");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("falls back to copy-only when start capture is missing", async () => {
    const bridge = new FakeBridge([TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("dictated");
  });

  it("falls back to copy-only when macOS has no editable control focused", async () => {
    const nonEditable = { ...TARGET_A, focusedEditable: false };
    const bridge = new FakeBridge([TARGET_A, nonEditable]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("dictated");
  });

  it("falls back to copy-only when macOS cannot inspect the focused control", async () => {
    const unconfirmed = { ...TARGET_A, focusedEditable: null };
    const bridge = new FakeBridge([TARGET_A, unconfirmed]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("dictated");
  });

  it("does not restore when another process changes the clipboard", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const insertion = coordinator(bridge, clipboard, () => {
      bridge.sequence += 1;
      clipboard.currentText = "user copied this";
      return {
        status: "injected",
        consumptionAcknowledgement: Promise.resolve(),
      };
    });

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("pasted");

    expect(clipboard.currentText).toBe("user copied this");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("does not paste if the clipboard changes between the write and paste", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A], (readNumber, activeBridge) => {
      if (readNumber === 4) {
        activeBridge.sequence += 1;
        clipboard.currentText = "new user clipboard";
      }
    });
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("new user clipboard");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("does not bless a foreign clipboard write before the first post-write sequence read", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A], (readNumber, activeBridge) => {
      if (readNumber === 3) {
        activeBridge.sequence += 1;
        clipboard.currentText = "external clipboard";
      }
    });
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn();
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("external clipboard");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("leaves dictated text copied when paste injection fails", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const paste = vi.fn(() => ({ status: "failed" as const }));
    const insertion = coordinator(bridge, clipboard, paste);

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("copied");

    expect(paste).toHaveBeenCalledOnce();
    expect(clipboard.currentText).toBe("dictated");
    expect(clipboard.restoreCalls).toHaveLength(0);
  });

  it("retains dictated text when a consumption acknowledgment times out", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    let resolveAcknowledgement!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      resolveAcknowledgement = resolve;
    });
    const sleep = vi.fn(async () => undefined);
    const insertion = coordinator(
      bridge,
      clipboard,
      () => ({ status: "injected", consumptionAcknowledgement: acknowledgement }),
      { pasteSettleMs: 123, sleep },
    );

    insertion.beginSession();
    await expect(insertion.insert("dictated", true)).resolves.toBe("pasted-with-copy");

    expect(sleep).toHaveBeenCalledWith(123);
    expect(clipboard.currentText).toBe("dictated");
    expect(clipboard.restoreCalls).toHaveLength(0);
    resolveAcknowledgement();
  });

  it("serializes overlapping paste requests", async () => {
    const bridge = new FakeBridge([TARGET_A, TARGET_A, TARGET_B, TARGET_B]);
    const clipboard = new FakeClipboard(bridge);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let pasteCount = 0;
    const insertion = coordinator(bridge, clipboard, async () => {
      pasteCount += 1;
      order.push(`start-${pasteCount}`);
      if (pasteCount === 1) await firstGate;
      order.push(`end-${pasteCount}`);
      return { status: "injected" };
    });

    insertion.beginSession();
    const first = insertion.insert("first", true);
    await vi.waitFor(() => expect(order).toEqual(["start-1"]));
    insertion.beginSession();
    const second = insertion.insert("second", true);
    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });

  it("treats loss of a previously available window fingerprint as a target change", () => {
    expect(sameTarget(TARGET_A, { ...TARGET_A, windowFingerprint: null })).toBe(false);
    expect(sameTarget({ ...TARGET_A, windowFingerprint: null }, { ...TARGET_A, windowFingerprint: null })).toBe(false);
  });

  it("treats a different editable control in the same macOS window as a target change", () => {
    expect(sameTarget(TARGET_A, {
      ...TARGET_A,
      focusedElementFingerprint: "e".repeat(64),
    })).toBe(false);
    expect(sameTarget(TARGET_A, TARGET_A)).toBe(true);
  });

  it("requires exactly one clipboard sequence advance", () => {
    expect(clipboardAdvancedExactlyOnce(100, 101)).toBe(true);
    expect(clipboardAdvancedExactlyOnce(100, 102)).toBe(false);
  });
});

describe("Electron rich clipboard adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.availableFormats.mockReturnValue([]);
    electronMocks.readText.mockReturnValue("");
    electronMocks.readHTML.mockReturnValue("");
    electronMocks.readRTF.mockReturnValue("");
    electronMocks.readImage.mockReturnValue({
      isEmpty: () => true,
      toPNG: () => Buffer.alloc(0),
    });
  });

  it("snapshots and restores text, HTML, RTF, and image in one clipboard write", async () => {
    const { ElectronClipboardPort } = await import("../src/main/insertion/electronClipboard");
    electronMocks.availableFormats.mockReturnValue([
      "text/plain",
      "text/html",
      "text/rtf",
      "image/png",
    ]);
    electronMocks.readText.mockReturnValue("plain");
    electronMocks.readHTML.mockReturnValue("<b>plain</b>");
    electronMocks.readRTF.mockReturnValue("{\\rtf1 plain}");
    electronMocks.readImage.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => Buffer.from([7, 8, 9]),
    });
    const port = new ElectronClipboardPort();

    const snapshot = port.snapshot();
    port.restore(snapshot);

    expect(snapshot.restorable).toBe(true);
    expect(electronMocks.write).toHaveBeenCalledOnce();
    expect(electronMocks.write).toHaveBeenCalledWith({
      text: "plain",
      html: "<b>plain</b>",
      rtf: "{\\rtf1 plain}",
      image: { png: Buffer.from([7, 8, 9]) },
    });
  });

  it("refuses a partial restore when the clipboard has an unsupported format", async () => {
    const { ElectronClipboardPort } = await import("../src/main/insertion/electronClipboard");
    electronMocks.availableFormats.mockReturnValue(["text/plain", "application/x-custom-secret"]);
    electronMocks.readText.mockReturnValue("plain");
    const port = new ElectronClipboardPort();

    const snapshot = port.snapshot();
    port.restore(snapshot);

    expect(snapshot.restorable).toBe(false);
    expect(electronMocks.write).not.toHaveBeenCalled();
    expect(electronMocks.clear).not.toHaveBeenCalled();
  });
});

describe("native helper boundary", () => {
  it("accepts explicit macOS focus metadata but rejects an omitted field", async () => {
    const { nativeBridgeInternals } = await import("../src/main/insertion/nativePlatformBridge");
    const base = {
      platform: "darwin",
      processId: 41,
      applicationId: "com.example.Editor",
    };

    expect(nativeBridgeInternals.parseTarget(JSON.stringify({
      ...base,
      windowFingerprint: null,
      focusedEditable: null,
      focusedElementFingerprint: null,
    }))).toEqual({
      ...base,
      windowFingerprint: null,
      focusedEditable: null,
      focusedElementFingerprint: null,
    });
    expect(nativeBridgeInternals.parseTarget(JSON.stringify({ ...base, windowFingerprint: null }))).toBeNull();
  });

  it("requires both focused-control and event-posting access", async () => {
    const { nativeBridgeInternals } = await import("../src/main/insertion/nativePlatformBridge");

    expect(nativeBridgeInternals.parseAccessibility(JSON.stringify({
      accessibility: true,
      postEvents: true,
    }))).toBe(true);
    expect(nativeBridgeInternals.parseAccessibility(JSON.stringify({
      accessibility: true,
      postEvents: false,
    }))).toBe(false);
    expect(nativeBridgeInternals.parseAccessibility("not json")).toBe(false);
  });

  it("fails closed on malformed native paste acknowledgements", async () => {
    const { nativeBridgeInternals } = await import("../src/main/insertion/nativePlatformBridge");

    expect(nativeBridgeInternals.parsePaste(JSON.stringify({ injected: true }))).toEqual({
      status: "injected",
    });
    expect(nativeBridgeInternals.parsePaste(JSON.stringify({ injected: "yes" }))).toEqual({
      status: "failed",
      reason: "invalid_response",
    });
    expect(nativeBridgeInternals.parsePaste(JSON.stringify({
      injected: false,
      reason: "target_changed",
    }))).toEqual({ status: "failed", reason: "target_changed" });
    expect(nativeBridgeInternals.parsePaste(JSON.stringify({
      injected: false,
      reason: "private dictated transcript",
    }))).toEqual({ status: "failed", reason: "invalid_response" });
    expect(nativeBridgeInternals.parsePaste("not json")).toEqual({
      status: "failed",
      reason: "invalid_response",
    });
  });
});

describe("macOS insertion service", () => {
  it("degrades to copy-only instead of using a uiohook paste when the helper is unavailable", async () => {
    const { InsertionService } = await import("../src/main/insertion/insertionService");
    const bridge = new FakeBridge([TARGET_A, TARGET_A]);
    const clipboard = new FakeClipboard(bridge);
    const insertion = new InsertionService({
      clipboard,
      platformBridge: bridge,
      platform: "darwin",
      pasteSettleMs: 0,
    });

    insertion.beginSession();
    await expect(insertion.copyAndPaste("dictated", true)).resolves.toBe("copied");
    expect(inputMocks.keyTap).not.toHaveBeenCalled();
    expect(clipboard.currentText).toBe("dictated");
  });
});
