import { uIOhook, UiohookKey } from "uiohook-napi";
import { ElectronClipboardPort } from "./electronClipboard";
import { createDefaultInsertionBridge } from "./nativePlatformBridge";
import { SafeInsertionCoordinator } from "./safeInsertion";
import type {
  ClipboardPort,
  InsertionOutcome,
  PasteInjector,
  PlatformInsertionBridge,
} from "./types";

export interface InsertionServiceDependencies {
  clipboard?: ClipboardPort;
  platformBridge?: PlatformInsertionBridge;
  pasteInjector?: PasteInjector;
  pasteSettleMs?: number;
  allowNativeHelperEnvironmentOverride?: boolean;
  /** Test seam; production callers use the current Node platform. */
  platform?: NodeJS.Platform;
}

export class InsertionService {
  private readonly coordinator: SafeInsertionCoordinator;
  private readonly platformBridge: PlatformInsertionBridge;
  private readonly platform: NodeJS.Platform;

  constructor(dependencies: InsertionServiceDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.platformBridge = dependencies.platformBridge ?? createDefaultInsertionBridge({
      allowEnvironmentOverride: dependencies.allowNativeHelperEnvironmentOverride,
    });
    const pasteInjector: PasteInjector = dependencies.pasteInjector ?? {
      paste: async () => {
        if (this.platformBridge.paste) return this.platformBridge.paste();
        // Windows auto-paste is owned by the helper because it rechecks UI
        // Automation focus immediately before SendInput. Never bypass that
        // guard with a lower-level key tap when the helper is unavailable.
        if (this.platform === "win32") return { status: "failed" };
        try {
          const modifier = this.platform === "darwin" ? UiohookKey.Meta : UiohookKey.Ctrl;
          uIOhook.keyTap(UiohookKey.V, [modifier]);
          // uiohook only confirms dispatch of the key event; it cannot
          // acknowledge that the focused application consumed clipboard data.
          return { status: "injected" };
        } catch {
          return { status: "failed" };
        }
      },
    };
    this.coordinator = new SafeInsertionCoordinator(
      dependencies.clipboard ?? new ElectronClipboardPort(),
      this.platformBridge,
      pasteInjector,
      { pasteSettleMs: dependencies.pasteSettleMs },
    );
  }

  /** Must be called synchronously when dictation begins, before focus can move. */
  beginSession(): void {
    this.coordinator.beginSession();
  }

  cancelSession(): void {
    this.coordinator.cancelSession();
  }

  /** Returns the app identity captured at dictation start once capture resolves. */
  targetAppId(): Promise<string | null> {
    return this.coordinator.targetAppId();
  }

  copyAndPaste(text: string, autoPaste: boolean): Promise<InsertionOutcome> {
    return this.coordinator.insert(text, autoPaste);
  }

  accessibilityReady(): Promise<boolean> {
    return this.platformBridge.accessibilityReady?.() ?? Promise.resolve(this.platform !== "darwin");
  }

  requestAccessibility(): Promise<boolean> {
    return this.platformBridge.requestAccessibility?.() ?? Promise.resolve(false);
  }
}
