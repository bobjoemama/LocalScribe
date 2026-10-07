import { ElectronClipboardPort } from "./electronClipboard";
import { createDefaultInsertionBridge } from "./nativePlatformBridge";
import { SafeInsertionCoordinator } from "./safeInsertion";
import type {
  ClipboardPort,
  AccessibilityStatus,
  InsertionOutcome,
  InsertionResult,
  PasteInjector,
  PlatformInsertionBridge,
} from "./types";

export interface InsertionServiceDependencies {
  clipboard?: ClipboardPort;
  platformBridge?: PlatformInsertionBridge;
  pasteInjector?: PasteInjector;
  pasteSettleMs?: number;
  allowNativeHelperEnvironmentOverride?: boolean;
  /**
   * Electron's application root. Development launches must not depend on the
   * shell's current working directory to discover the source-tree helper.
   */
  nativeHelperWorkingDirectory?: string;
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
      workingDirectory: dependencies.nativeHelperWorkingDirectory,
    });
    const pasteInjector: PasteInjector = dependencies.pasteInjector ?? {
      paste: async (expectedTarget, expectedClipboardSequence) => {
        // Native auto-paste owns the final editable-target recheck. A missing
        // helper deliberately degrades to copy-only.
        return this.platformBridge.paste?.(
          expectedTarget,
          expectedClipboardSequence,
        ) ?? { status: "failed", reason: "helper_unavailable" };
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
    return this.copyAndPasteDetailed(text, autoPaste).then(({ outcome }) => outcome);
  }

  /** Detailed result used by privacy-safe diagnostics; public outcome remains unchanged. */
  copyAndPasteDetailed(text: string, autoPaste: boolean): Promise<InsertionResult> {
    return this.coordinator.insert(text, autoPaste);
  }

  pinNativeHelperIntegrity(): boolean {
    const pinned = this.platformBridge.pinExecutableIntegrity?.() ?? false;
    return pinned;
  }

  async automaticPasteReady(): Promise<boolean> {
    if (this.platform !== "darwin") return false;
    // The bridge owns successful self-test caching and validates pinned helper
    // authority on every request. Caching here bypasses that revalidation and
    // makes a transient failure sticky for the rest of the app's lifetime.
    const ready = await (this.platformBridge.ready?.() ?? Promise.resolve(false))
      .catch(() => false);
    if (!ready) return false;
    // Accessibility is intentionally not cached: the user can revoke it while
    // LocalScribe is running. Both the pinned helper protocol and the current
    // OS grants must be true at the insertion boundary.
    return this.accessibilityReady();
  }

  async accessibilityStatus(): Promise<AccessibilityStatus> {
    try {
      if (this.platformBridge.accessibilityStatus) {
        return await this.platformBridge.accessibilityStatus();
      }
      if (this.platformBridge.accessibilityReady) {
        return await this.platformBridge.accessibilityReady() ? "granted" : "denied";
      }
    } catch {
      // A helper exception cannot establish the current OS grant.
    }
    return "unavailable";
  }

  async accessibilityReady(): Promise<boolean> {
    return await this.accessibilityStatus() === "granted";
  }

  requestAccessibility(): Promise<boolean> {
    return this.platformBridge.requestAccessibility?.() ?? Promise.resolve(false);
  }
}
