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
      paste: async (expectedTarget) => {
        // Native auto-paste owns the final editable-target recheck on both
        // platforms. A missing helper deliberately degrades to copy-only.
        return this.platformBridge.paste?.(expectedTarget) ?? { status: "failed" };
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
