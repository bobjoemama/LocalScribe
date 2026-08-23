import {
  DEFAULT_MODEL_FAMILY_ID,
  type ModelCatalog,
  type ModelFamilyId,
  type ModelPerformanceMode,
  type ModelPerformanceTier,
} from "../../../shared/contracts";
import { useState } from "react";
import { modelPerformanceTierLabel } from "../../../shared/modelPerformance";
import { dictationLanguagePresentation } from "../dictationLanguages";

/*
 * Tier labels come from the shared source so main-composed status copy and
 * these renderer labels cannot spell the same tier two different ways.
 */
export const MODEL_MODE_CHOICES = [
  { id: "auto", label: "Auto" },
  { id: "high", label: modelPerformanceTierLabel("high") },
  { id: "medium", label: modelPerformanceTierLabel("medium") },
  { id: "low", label: modelPerformanceTierLabel("low") },
] as const satisfies readonly { id: ModelPerformanceMode; label: string }[];

const TIER_ORDER: readonly ModelPerformanceTier[] = ["high", "medium", "low"];

type CatalogFamily = ModelCatalog["families"][number];

/**
 * The current IPC catalog deliberately has no UI-only marketing/capability
 * fields yet. Keep this compatibility layer local to the renderer so the
 * model workers remain the authority for what can actually run. New catalog
 * families automatically get a conservative, usable presentation until the
 * shared capability descriptor lands.
 */
export type RecognitionExperience = "after-stop" | "live";
export interface ModelFamilyPresentation {
  experience: RecognitionExperience;
  experiences: readonly RecognitionExperience[];
  recommendation: "recommended" | "accurate" | "balanced" | "legacy" | "live";
  summary: string;
  languageLabel: string;
  latencyLabel: string;
}

export function modelFamilyPresentation(family: CatalogFamily): ModelFamilyPresentation {
  const identity = `${family.familyId} ${family.displayName} ${catalogFamilyBackendLabel(family)}`.toLowerCase();
  const experiences = family.capabilities.modes;
  const languageLabel = family.capabilities.supportedLanguages.includes("auto")
    ? "Multilingual"
    : family.capabilities.supportedLanguages.length === 1
      ? family.capabilities.supportedLanguages[0] === "en"
        ? "English"
        : family.capabilities.supportedLanguages[0]!
      : `${family.capabilities.supportedLanguages.length} languages`;
  /*
   * Keep this recognizable at the decision point. Parakeet is the NVIDIA
   * family people look for when they want a fast, polished result after they
   * release the shortcut — it must not read like the separate live-preview
   * choice. `experiences` still comes from the catalog, which remains the
   * runtime authority for modes that may actually be selected.
   */
  if (identity.includes("parakeet")) {
    return {
      experience: "after-stop",
      experiences,
      recommendation: family.recommendedDefault ? "recommended" : "balanced",
      summary: "Fast final dictation after you stop speaking. Recommended for a polished local result.",
      languageLabel,
      latencyLabel: "Fast final dictation",
    };
  }
  if (experiences.length === 1 && experiences[0] === "live") {
    return {
      experience: "live",
      experiences: ["live"],
      recommendation: "live",
      summary: "Recognizes while you speak, then finalizes before insertion.",
      languageLabel,
      latencyLabel: "Live recognition",
    };
  }
  if (experiences.includes("live")) {
    return {
      experience: "after-stop",
      experiences,
      recommendation: family.recommendedDefault ? "recommended" : "live",
      summary: "One verified local model for either final-only dictation or live recognition.",
      languageLabel,
      latencyLabel: "Fast after stop",
    };
  }
  if (identity.includes("qwen")) {
    return {
      experience: "after-stop",
      experiences: ["after-stop"],
      recommendation: "accurate",
      summary: "Strong multilingual recognition with a little more model weight.",
      languageLabel,
      latencyLabel: "Balanced after stop",
    };
  }
  if (identity.includes("whisper") && identity.includes("v2")) {
    return {
      experience: "after-stop",
      experiences: ["after-stop"],
      recommendation: "legacy",
      summary: "Older Whisper generation retained for compatibility.",
      languageLabel,
      latencyLabel: "After stop",
    };
  }
  return {
    experience: "after-stop",
    experiences,
    recommendation: family.recommendedDefault ? "recommended" : "balanced",
    summary: "Reliable local transcription after you finish speaking.",
    languageLabel,
    latencyLabel: "After stop",
  };
}

export function supportedModeChoices(family: CatalogFamily | undefined): readonly typeof MODEL_MODE_CHOICES[number][] {
  if (!family) return MODEL_MODE_CHOICES;
  const profileTiers = new Set(family.profiles.map((profile) => profile.tier));
  return MODEL_MODE_CHOICES.filter((choice) => choice.id === "auto" || profileTiers.has(choice.id));
}

export type ModelModeChoice = ModelPerformanceMode;
export type ConcreteModelTier = ModelPerformanceTier;
export interface ModelSelectionDraft {
  familyId: ModelFamilyId;
  asrMode: RecognitionExperience;
  performanceMode: ModelPerformanceMode;
}
export type ModelVerificationState = "missing" | "invalid" | "verified" | "unknown";
/**
 * Progress is reported from the runtime's real downloader. Missing byte counts
 * deliberately render as an indeterminate operation rather than a fabricated
 * percentage.
 */
export interface ModelActionProgress {
  phase: "preparing" | "downloading" | "verifying" | "complete" | "failed";
  completedBytes?: number;
  totalBytes?: number;
  /** Safe, runtime-supplied failure context (never a raw worker diagnostic). */
  message?: string;
}
export interface ModelTierActionState {
  action: "installing" | "repairing" | "removing";
  familyId: ModelFamilyId;
  tier: ConcreteModelTier;
  progress?: ModelActionProgress;
}
export type ModelActionState = ModelTierActionState | {
  action: "adding";
  familyId: ModelFamilyId;
} | null;

/** Runtime-only facts. Catalog metadata remains usable when these are unavailable. */
export interface ModelTierRuntimeStatus {
  familyId: ModelFamilyId;
  tier: ConcreteModelTier;
  artifactId: string;
  qualityNote?: string;
  verificationStatus: ModelVerificationState;
}

export interface ModelTierView {
  familyId: ModelFamilyId;
  tier: ConcreteModelTier;
  profileId: string;
  artifactId: string;
  displayName: string;
  backend: string;
  precision: string;
  downloadBytes: number;
  acceleratorMemory: {
    minimumBytes: number;
    maximumBytes: number;
    basis: "measured" | "estimated";
  };
  license: string;
  qualityNote: string;
  verificationStatus: ModelVerificationState;
}

export interface ModelHardwareView {
  platform: "darwin";
  displayName: string;
  totalMemoryBytes: number | null;
  availableMemoryBytes: number | null;
  memoryBasis: "measured" | "estimated" | "unavailable";
}

export interface ModelMemoryRequirementView {
  reservedHeadroomBytes: number | null;
  requiredFreeMemoryBytes: number | null;
}

export interface ModelPerformanceSettingsProps {
  currentSelection: ModelSelectionDraft;
  currentModelLoaded: boolean;
  pendingSelection: ModelSelectionDraft;
  mode: ModelModeChoice;
  resolvedTier: ConcreteModelTier | null;
  fitsMemoryBudget: boolean | null;
  resolutionReason: string | null;
  hardware: ModelHardwareView | null;
  memoryRequirement: ModelMemoryRequirementView | null;
  catalog: ModelCatalog | null;
  catalogError: string | null;
  runtimeTierStatuses: readonly ModelTierRuntimeStatus[];
  action: ModelActionState;
  feedback: { message: string; isError: boolean } | null;
  applying: boolean;
  /** The currently staged General-language value, used to prevent an invalid model switch. */
  selectedLanguage?: string;
  languageHasUnsavedChange?: boolean;
  /**
   * Optional until the shared streaming-mode setting reaches this branch.
   * When supplied, the renderer becomes fully controlled by main; until then
   * the picker only filters the catalog and cannot claim it changed inference.
   */
  recognitionExperience?: RecognitionExperience;
  onRecognitionExperienceChange?(experience: RecognitionExperience): void;
  onModeChange(mode: ModelModeChoice): void;
  onFamilyChange(familyId: ModelFamilyId): void;
  onApply(): void;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onAddFamily(familyId: ModelFamilyId): void;
  onRefresh(): void;
}

export interface ModelApplyEligibility {
  enabled: boolean;
  reason: string;
  targetTier: ConcreteModelTier | null;
  targetVerification: ModelVerificationState;
}

/**
 * Renderer-side affordance only. Main repeats every check against fresh state
 * before it unloads or persists anything.
 */
export function modelApplyEligibility({
  currentSelection,
  currentModelLoaded,
  pendingSelection,
  resolvedTier,
  catalog,
  catalogError,
  runtimeTierStatuses,
  hardware,
  memoryRequirement,
  action,
  applying,
  selectedLanguage,
  languageHasUnsavedChange,
}: Pick<ModelPerformanceSettingsProps,
  | "currentSelection"
  | "currentModelLoaded"
  | "pendingSelection"
  | "resolvedTier"
  | "catalog"
  | "catalogError"
  | "runtimeTierStatuses"
  | "hardware"
  | "memoryRequirement"
  | "action"
  | "applying"
  | "selectedLanguage"
  | "languageHasUnsavedChange"
>): ModelApplyEligibility {
  const unavailable = (
    reason: string,
    targetTier: ConcreteModelTier | null = null,
    targetVerification: ModelVerificationState = "unknown",
  ): ModelApplyEligibility => ({ enabled: false, reason, targetTier, targetVerification });

  if (applying) return unavailable("Applying the selected model…");
  if (action) return unavailable("Finish the current model-library action first.");
  if (catalogError) return unavailable("Refresh the model catalog before applying.");
  if (!catalog) return unavailable("The model catalog is still loading.");
  if (
    currentSelection.familyId === pendingSelection.familyId
    && currentSelection.asrMode === pendingSelection.asrMode
    && currentSelection.performanceMode === pendingSelection.performanceMode
    && currentModelLoaded
  ) {
    return unavailable("Current model is loaded and ready.");
  }

  const family = catalog.families.find((candidate) => candidate.familyId === pendingSelection.familyId);
  if (!family) return unavailable("The selected model is not available in this macOS build.");
  if (!family.capabilities.modes.includes(pendingSelection.asrMode)) {
    return unavailable("The selected model does not support this dictation experience.");
  }
  if (selectedLanguage) {
    const language = dictationLanguagePresentation(selectedLanguage, family.capabilities);
    const compatible = language.options.some((option) => (
      option.value === selectedLanguage && option.disabled !== true
    ));
    if (!compatible) {
      return unavailable(`Choose a language supported by ${family.displayName} in General Settings before applying.`);
    }
    if (languageHasUnsavedChange) {
      return unavailable("Save the language change in General Settings before applying this model.");
    }
  }
  if (!family.inLibrary) return unavailable(`Add ${family.displayName} to your library first.`);
  if (!hardware || hardware.totalMemoryBytes === null || hardware.availableMemoryBytes === null) {
    return unavailable("Refresh accelerator memory before applying.");
  }
  const totalMemoryBytes = hardware.totalMemoryBytes;
  const availableMemoryBytes = hardware.availableMemoryBytes;
  const currentFamily = catalog.families.find(
    (candidate) => candidate.familyId === currentSelection.familyId,
  );
  const currentProfile = resolvedTier === null
    ? undefined
    : currentFamily?.profiles.find((profile) => profile.tier === resolvedTier);
  // Apply unloads the current runtime before loading the target. Use the
  // current profile's minimum estimated allocation as a conservative lower
  // bound for memory that will become available; using its maximum could
  // overstate capacity. The hardware display itself remains the raw reading.
  const availableAfterUnloadBytes = Math.min(
    totalMemoryBytes,
    availableMemoryBytes + (
      currentModelLoaded ? currentProfile?.expectedMemoryMinBytes ?? 0 : 0
    ),
  );
  const headroom = memoryRequirement?.reservedHeadroomBytes;
  if (headroom === null || headroom === undefined) {
    return unavailable("Reserved runtime memory is unavailable. Refresh model status.");
  }

  const orderedProfiles = [...family.profiles].sort(
    (left, right) => TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier),
  );
  const fits = (profile: ModelCatalog["families"][number]["profiles"][number]) => {
    const required = profile.expectedMemoryMaxBytes + headroom;
    return totalMemoryBytes >= required && availableAfterUnloadBytes >= required;
  };
  const targetProfile = pendingSelection.performanceMode === "auto"
    ? orderedProfiles.find(fits)
    : orderedProfiles.find((profile) => profile.tier === pendingSelection.performanceMode);
  if (!targetProfile) {
    return unavailable(pendingSelection.performanceMode === "auto"
      ? "No profile in this model family fits the available memory."
      : "The selected performance profile is missing from the catalog.");
  }
  if (!fits(targetProfile)) {
    const required = targetProfile.expectedMemoryMaxBytes + headroom;
    return unavailable(
      `${tierLabelFor(targetProfile.tier)} needs ${formatAcceleratorBytes(required)} available after unloading the current model, but ${formatAcceleratorBytes(availableAfterUnloadBytes)} is conservatively available.`,
      targetProfile.tier,
    );
  }

  const runtime = runtimeTierStatuses.find((candidate) => (
    candidate.familyId === family.familyId
    && candidate.tier === targetProfile.tier
    && candidate.artifactId === targetProfile.artifactId
  ));
  const catalogVerification = catalog.verifications.find((candidate) => (
    candidate.familyId === family.familyId
    && candidate.artifactId === targetProfile.artifactId
  ));
  const verification = runtime?.verificationStatus
    ?? catalogVerification?.verificationStatus
    ?? "unknown";
  if (verification === "missing") {
    return unavailable("Download the selected model profile before applying.", targetProfile.tier, verification);
  }
  if (verification === "invalid") {
    return unavailable("Repair the selected model profile before applying.", targetProfile.tier, verification);
  }
  if (verification !== "verified") {
    return unavailable("Verify the selected model profile before applying.", targetProfile.tier, verification);
  }
  return {
    enabled: true,
    reason: currentSelection.familyId === pendingSelection.familyId
      && currentSelection.asrMode === pendingSelection.asrMode
      && currentSelection.performanceMode === pendingSelection.performanceMode
      ? "Ready to verify and load the current model."
      : "Ready to unload the current model and load this selection.",
    targetTier: targetProfile.tier,
    targetVerification: verification,
  };
}

export function modelVerificationPresentation(status: ModelVerificationState): {
  label: string;
  tone: "ready" | "missing" | "repair" | "unknown";
} {
  if (status === "verified") return { label: "Verified", tone: "ready" };
  if (status === "invalid") return { label: "Repair required", tone: "repair" };
  if (status === "unknown") return { label: "Status unavailable", tone: "unknown" };
  return { label: "Missing", tone: "missing" };
}

export function modelMemoryCopy(): {
  summary: string;
  memoryLabel: string;
} {
  return {
    summary: "Auto uses available unified memory to choose the highest profile that fits in the active family.",
    memoryLabel: "Unified memory",
  };
}

export function catalogFamilyBackendLabel(
  family: ModelCatalog["families"][number],
): string {
  return [...new Set(family.artifacts.map((artifact) => artifact.backend))].join(" · ");
}

export function friendlyPrecision(precision: string): string {
  const normalized = precision.toLowerCase();
  if (normalized === "fp16" || normalized === "float16" || normalized === "coreml-fp16") return "FP16";
  if (normalized === "bf16" || normalized === "bfloat16") return "BF16";
  if (normalized === "int8_float16" || normalized === "int8-float16") {
    return "INT8 weights + FP16 compute";
  }
  if (normalized === "int8") return "INT8";
  if (normalized === "coreml-int8") return "INT8";
  if (normalized === "q8_0") return "Q8_0";
  if (normalized === "q4_k") return "Q4_K";
  if (normalized === "8-bit") return "8-bit";
  if (normalized === "4-bit") return "4-bit";
  return precision;
}

export function friendlyLicense(license: string): string {
  return license.toLowerCase() === "undeclared" ? "Undeclared — review required" : license;
}

export function formatModelBytes(bytes: number): string {
  if (bytes <= 0) return "0 GB";
  const gigabytes = bytes / 1_000_000_000;
  return `${gigabytes.toFixed(gigabytes >= 10 ? 1 : 2)} GB`;
}

export function formatStorageBytes(bytes: number | null): string {
  if (bytes === null) return "Size unavailable";
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

export function formatAcceleratorBytes(bytes: number): string {
  if (bytes <= 0) return "0 GiB";
  const gibibytes = bytes / 1_073_741_824;
  return `${gibibytes.toFixed(gibibytes >= 10 ? 1 : 2)} GiB`;
}

export function formatMemoryRange(
  memory: ModelTierView["acceleratorMemory"],
): string {
  const range = memory.minimumBytes === memory.maximumBytes
    ? formatAcceleratorBytes(memory.minimumBytes)
    : `${formatAcceleratorBytes(memory.minimumBytes)}–${formatAcceleratorBytes(memory.maximumBytes)}`;
  return `${range} ${memory.basis}`;
}

/**
 * Joins static curated metadata to runtime verification by immutable artifact
 * identity. Profiles share verification only when they reference the same
 * immutable artifact.
 */
export function catalogTierViews(
  family: ModelCatalog["families"][number],
  runtimeStatuses: readonly ModelTierRuntimeStatus[],
): ModelTierView[] {
  const artifacts = new Map(family.artifacts.map((artifact) => [artifact.artifactId, artifact]));
  return [...family.profiles]
    .sort((left, right) => TIER_ORDER.indexOf(left.tier) - TIER_ORDER.indexOf(right.tier))
    .map((profile) => {
      const artifact = artifacts.get(profile.artifactId);
      if (!artifact) throw new Error(`Curated profile ${profile.profileId} has no artifact metadata.`);
      const runtime = runtimeStatuses.find((candidate) => (
        candidate.familyId === family.familyId
        && candidate.tier === profile.tier
        && candidate.artifactId === profile.artifactId
      ));
      return {
        familyId: family.familyId,
        tier: profile.tier,
        profileId: profile.profileId,
        artifactId: profile.artifactId,
        displayName: artifact.displayName,
        backend: artifact.backend,
        precision: friendlyPrecision(profile.precision),
        downloadBytes: artifact.expectedDownloadBytes,
        acceleratorMemory: {
          minimumBytes: profile.expectedMemoryMinBytes,
          maximumBytes: profile.expectedMemoryMaxBytes,
          basis: profile.memoryBasis,
        },
        license: friendlyLicense(artifact.license),
        qualityNote: runtime?.qualityNote
          ?? (family.active
            ? "Runtime quality details are unavailable until model diagnostics refresh."
            : family.inLibrary
              ? "Select and apply this family to load its runtime quality details."
              : "Add this family to your library, then select and apply it to load runtime quality details."),
        verificationStatus: runtime?.verificationStatus ?? "unknown",
      };
    });
}

export function ModelPerformanceSettings({
  currentSelection,
  currentModelLoaded,
  pendingSelection,
  mode,
  resolvedTier,
  fitsMemoryBudget,
  resolutionReason,
  hardware,
  memoryRequirement,
  catalog,
  catalogError,
  runtimeTierStatuses,
  action,
  feedback,
  applying,
  selectedLanguage,
  languageHasUnsavedChange,
  recognitionExperience,
  onRecognitionExperienceChange,
  onModeChange,
  onFamilyChange,
  onApply,
  onInstall,
  onRepair,
  onRemove,
  onAddFamily,
  onRefresh,
}: ModelPerformanceSettingsProps) {
  const memoryCopy = modelMemoryCopy();
  const inlineMemoryLabel = memoryCopy.memoryLabel.toLowerCase();
  const resolvedLabel = resolvedTier
    ? MODEL_MODE_CHOICES.find((choice) => choice.id === resolvedTier)?.label ?? resolvedTier
    : "Run eligibility unavailable";
  const autoResolutionLabel = fitsMemoryBudget === false ? "No tier fits" : resolvedLabel;
  const requestedLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === mode)?.label ?? mode;
  const eligibilityUnknown = hardware === null || hardware.availableMemoryBytes === null;
  const currentFamily = catalog?.families.find((family) => family.familyId === currentSelection.familyId);
  const pendingFamily = catalog?.families.find((family) => family.familyId === pendingSelection.familyId);
  const currentModeLabel = modeLabel(currentSelection.performanceMode);
  const pendingModeLabel = modeLabel(pendingSelection.performanceMode);
  const initialBrowsingFamily = pendingFamily ?? currentFamily ?? catalog?.families[0];
  const [uncontrolledBrowsingExperience, setUncontrolledBrowsingExperience] = useState<RecognitionExperience>(() => (
    initialBrowsingFamily ? modelFamilyPresentation(initialBrowsingFamily).experience : "after-stop"
  ));
  const browsingExperience = recognitionExperience ?? uncontrolledBrowsingExperience;
  const chooseExperience = (experience: RecognitionExperience) => {
    if (onRecognitionExperienceChange) onRecognitionExperienceChange(experience);
    else setUncontrolledBrowsingExperience(experience);
  };
  const selectionChanged = currentSelection.familyId !== pendingSelection.familyId
    || currentSelection.asrMode !== pendingSelection.asrMode
    || currentSelection.performanceMode !== pendingSelection.performanceMode;
  const applyEligibility = modelApplyEligibility({
    currentSelection,
    currentModelLoaded,
    pendingSelection,
    resolvedTier,
    catalog,
    catalogError,
    runtimeTierStatuses,
    hardware,
    memoryRequirement,
    action,
    applying,
    selectedLanguage,
    languageHasUnsavedChange,
  });
  const availableModeChoices = supportedModeChoices(pendingFamily);
  const liveFamiliesAvailable = catalog?.families.some(
    (family) => modelFamilyPresentation(family).experiences.includes("live"),
  ) ?? false;
  const visibleFamilies = catalog?.families.filter(
    (family) => modelFamilyPresentation(family).experiences.includes(browsingExperience),
  ) ?? [];
  const parakeetFamily = catalog?.families.find((family) => (
    `${family.familyId} ${family.displayName}`.toLowerCase().includes("parakeet")
  ));
  const applyState = applying
    ? "Applying model change"
    : selectionChanged
      ? "Pending model change"
      : currentModelLoaded
        ? "Applied and ready"
        : "Selected model is not loaded";
  const applyStatus = applying
    ? "LocalScribe is safely unloading the previous runtime and loading this selection."
    : selectionChanged
      ? "Nothing changes until you apply this pending selection."
      : currentModelLoaded
        ? "This selection is loaded and ready for dictation."
        : "This selection is saved but its local runtime needs to be loaded.";

  return (
    <div className="ls-model-performance">
      <section className="ls-model-apply-card" aria-labelledby="model-apply-heading" aria-busy={applying || undefined}>
        <div>
          <span className={applying ? "ls-model-apply-state is-busy" : "ls-model-apply-state"} role="status" aria-live="polite">
            {applyState}
          </span>
          <h2 id="model-apply-heading">
            {pendingFamily?.displayName ?? pendingSelection.familyId} · {pendingSelection.asrMode === "live" ? "Live" : "After I stop"} · {pendingModeLabel}
          </h2>
          <dl className="ls-model-selection-summary">
            <div>
              <dt>Currently using</dt>
              <dd>{currentFamily?.displayName ?? currentSelection.familyId} · {currentSelection.asrMode === "live" ? "Live" : "After I stop"} · {currentModeLabel}</dd>
            </div>
            <div>
              <dt>After applying</dt>
              <dd>{pendingFamily?.displayName ?? pendingSelection.familyId} · {pendingSelection.asrMode === "live" ? "Live" : "After I stop"} · {pendingModeLabel}</dd>
            </div>
          </dl>
          <p id="model-apply-status">{applyStatus} {applyEligibility.reason}</p>
        </div>
        <div className="ls-model-apply-actions">
          <button type="button" className="ls-secondary-button" disabled={applying || action !== null} onClick={onRefresh}>
            Refresh status
          </button>
          <button
            type="button"
            className="ls-primary-button ls-model-apply-button"
            disabled={!applyEligibility.enabled}
            aria-disabled={!applyEligibility.enabled}
            aria-describedby="model-apply-status"
            title={applyEligibility.enabled ? "Apply this staged model selection" : applyEligibility.reason}
            onClick={onApply}
          >
            {applying
              ? "Applying model…"
              : !selectionChanged && !currentModelLoaded
                ? "Load current model"
                : "Apply model"}
          </button>
        </div>
      </section>

      <section className="ls-model-experience-picker" aria-labelledby="model-experience-heading">
        <div>
          <span>Dictation experience</span>
          <h2 id="model-experience-heading">Choose when LocalScribe recognizes your speech</h2>
          <p>Both keep audio on this Mac. Live recognition streams while you speak, but LocalScribe inserts final text only after you stop.</p>
        </div>
        <div className="ls-model-experience-options" role="group" aria-label="Dictation experience">
          <button
            type="button"
            className={browsingExperience === "after-stop" ? "is-selected" : ""}
            aria-pressed={browsingExperience === "after-stop"}
            disabled={applying || action !== null}
            onClick={() => chooseExperience("after-stop")}
          >
            <strong>After I stop</strong>
            <span>Fast, polished final dictation</span>
          </button>
          <button
            type="button"
            className={browsingExperience === "live" ? "is-selected" : ""}
            aria-pressed={browsingExperience === "live"}
            disabled={applying || action !== null || !liveFamiliesAvailable}
            onClick={() => chooseExperience("live")}
          >
            <strong>Live</strong>
            <span>{liveFamiliesAvailable ? "Separate streaming recognition while you speak" : "No streaming model in this catalog"}</span>
          </button>
        </div>
        {browsingExperience === "after-stop" && parakeetFamily && (
          <p className="ls-model-experience-recommendation" role="status">
            <strong>Looking for Parakeet?</strong> {parakeetFamily.displayName} is available below for fast final dictation after you stop — it is not the Live preview choice.
          </p>
        )}
        {!liveFamiliesAvailable && (
          <p className="ls-model-experience-unavailable" role="status">
            Live recognition will appear here only when a verified local streaming model is included in your catalog. It is unavailable in this build, so LocalScribe will not silently substitute another model.
          </p>
        )}
      </section>

      <section className="ls-model-auto-card" aria-labelledby="model-auto-heading">
        <div>
          <span>Performance within the selected family</span>
          <h2 id="model-auto-heading">
            {mode === "auto"
              ? <>Auto resolves to <strong>{selectionChanged ? applyEligibility.targetTier ? modeLabel(applyEligibility.targetTier) : "after validation" : autoResolutionLabel}</strong></>
              : <><strong>{requestedLabel}</strong> selected</>}
          </h2>
          <p>{memoryCopy.summary} Changing these controls only stages a choice. LocalScribe unloads the current model and loads the new one only after you press Apply model.</p>
        </div>
      </section>

      <fieldset className="ls-model-mode-picker" disabled={applying || action !== null || Boolean(catalogError) || !catalog}>
        <legend>Performance mode</legend>
        <p>Choose Auto or one concrete quality and memory profile for the active speech-model family.</p>
        <div>
          {availableModeChoices.map((choice) => (
            <label key={choice.id} className={mode === choice.id ? "is-selected" : ""}>
              <input
                type="radio"
                name="model-performance-mode"
                value={choice.id}
                checked={mode === choice.id}
                onChange={() => onModeChange(choice.id)}
              />
              <span>{choice.label}</span>
              {choice.id === "auto" && (
                <small>
                  {fitsMemoryBudget === false
                    ? "No tier fits"
                    : resolvedTier
                      ? `Currently ${resolvedLabel}`
                      : "Memory unavailable"}
                </small>
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {!selectionChanged && mode === "auto" && resolutionReason && (
        <p className="ls-model-resolution-note" role="status">
          <InfoIcon />
          <span>{resolutionReason}</span>
        </p>
      )}
      {mode !== "auto" && fitsMemoryBudget === false && (
        <p className="ls-model-resolution-note" role="status">
          <InfoIcon />
          <span>
            <strong>{requestedLabel}</strong> cannot run with the {inlineMemoryLabel} currently available. Dictation stays blocked until enough {inlineMemoryLabel} is available or you choose a lower profile.
          </span>
        </p>
      )}

      <MemoryStatus
        hardware={hardware}
        memoryRequirement={memoryRequirement}
        memoryCopy={memoryCopy}
        eligibilityUnknown={eligibilityUnknown}
        normalizedForWarmModel={currentModelLoaded}
      />

      {feedback && (
        <p
          className={feedback.isError ? "ls-model-feedback is-error" : "ls-model-feedback"}
          role={feedback.isError ? "alert" : "status"}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      )}

      <section className="ls-model-catalog" aria-labelledby="model-catalog-heading">
        <div className="ls-model-catalog-heading">
          <div>
            <h2 id="model-catalog-heading">{browsingExperience === "live" ? "Live models" : "After I stop models"}</h2>
            <p>{browsingExperience === "live"
              ? "Live preview is a separate streaming experience. Choose a model first, then a profile."
              : "These models produce the finished text after you stop speaking. Choose a model first, then a profile."}</p>
          </div>
        </div>

        {catalogError ? (
          <div className="ls-model-empty is-error" role="alert">
            Could not load the curated model catalog: {catalogError}. Model-library actions are unavailable until it loads.
          </div>
        ) : !catalog ? (
          <div className="ls-model-empty" role="status">Loading curated model catalog…</div>
        ) : (
          <>
            <div className="ls-model-family-list">
              {visibleFamilies.map((family) => (
                <ModelFamilyCard
                  key={family.familyId}
                  family={family}
                  mode={mode}
                  currentFamilyId={currentSelection.familyId}
                  pendingFamilyId={pendingSelection.familyId}
                  resolvedTier={selectionChanged ? applyEligibility.targetTier : resolvedTier}
                  fitsMemoryBudget={fitsMemoryBudget}
                  runtimeTierStatuses={runtimeTierStatuses}
                  action={action}
                  runEligibilityUnknown={eligibilityUnknown}
                  onInstall={onInstall}
                  onRepair={onRepair}
                  onRemove={onRemove}
                  onAddFamily={onAddFamily}
                  onFamilyChange={onFamilyChange}
                  selectionDisabled={applying || action !== null}
                />
              ))}
            </div>
            {visibleFamilies.length === 0 && (
              <div className="ls-model-empty" role="status">
                No {browsingExperience === "live" ? "live" : "after-stop"} model is available in this catalog yet.
              </div>
            )}
            {catalog.unmanagedEntries.length > 0 && (
              <section className="ls-model-unmanaged" aria-labelledby="model-unmanaged-heading">
                <div>
                  <h3 id="model-unmanaged-heading">Other model storage found</h3>
                  <p>These entries are not managed or used by this LocalScribe build. They are listed for transparency and will not be deleted automatically.</p>
                </div>
                <ul>
                  {catalog.unmanagedEntries.map((entry) => (
                    <li key={`${entry.kind}:${entry.name}`}>
                      <strong>{entry.name}</strong>
                      <span>
                        {entry.reason === "interrupted-install" ? "Interrupted model installation" : "Unmanaged model data"}
                        {" · "}{entry.kind}
                        {" · "}{formatStorageBytes(entry.sizeBytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {catalog && (
          <details className="ls-model-advanced-details">
            <summary>Model library and technical details</summary>
            <p>Model packages are pinned local data files that LocalScribe verifies. Custom paths, URLs, and loaders are not accepted.</p>
            <p className="ls-model-compatibility-note">
              Additional model families appear only after their supported profiles have pinned manifests and package validation for this local runtime.
            </p>
          </details>
        )}
      </section>
    </div>
  );
}

function MemoryStatus({
  hardware,
  memoryRequirement,
  memoryCopy,
  eligibilityUnknown,
  normalizedForWarmModel,
}: {
  hardware: ModelHardwareView | null;
  memoryRequirement: ModelMemoryRequirementView | null;
  memoryCopy: ReturnType<typeof modelMemoryCopy>;
  eligibilityUnknown: boolean;
  normalizedForWarmModel: boolean;
}) {
  if (!hardware) {
    return (
      <section className="ls-model-memory-note" role="status">
        <InfoIcon />
        <span>Run eligibility is unknown because LocalScribe could not read accelerator memory. You can still check or download curated model data.</span>
      </section>
    );
  }
  const requirement = memoryRequirement?.requiredFreeMemoryBytes;
  const headroom = memoryRequirement?.reservedHeadroomBytes;
  const inlineMemoryLabel = memoryCopy.memoryLabel.toLowerCase();
  return (
    <>
      <section className="ls-model-hardware" aria-label="Detected accelerator memory">
        <span>
          <strong>{hardware.displayName}</strong>
          <small>{memoryCopy.memoryLabel}</small>
        </span>
        <span>
          <strong>{hardware.totalMemoryBytes === null ? "Unavailable" : formatAcceleratorBytes(hardware.totalMemoryBytes)}</strong>
          <small>Total</small>
        </span>
        <span>
          <strong>{hardware.availableMemoryBytes === null ? "Unavailable" : formatAcceleratorBytes(hardware.availableMemoryBytes)}</strong>
          <small>
            {hardware.availableMemoryBytes === null
              ? "Availability · unavailable"
              /*
               * The number above is the raw reading main reports; diagnostics
               * stay observational and are never normalized. The caption used
               * to claim it was "normalized for the warm model", which is a
               * different, larger figure computed only inside apply
               * eligibility — so the readout and the Apply message quoted two
               * irreconcilable numbers. Describe what is actually shown.
               */
              : normalizedForWarmModel
                ? `Available now (a warm model is resident) · live telemetry · ${hardware.memoryBasis}`
                : `Available now · live telemetry · ${hardware.memoryBasis}`}
          </small>
        </span>
      </section>
      {requirement !== null && requirement !== undefined ? (
        <p className="ls-model-memory-note">
          <InfoIcon />
          <span>
            This selected profile requires <strong>{formatAcceleratorBytes(requirement)}</strong> free {inlineMemoryLabel}, including {headroom === null || headroom === undefined ? "the reserved runtime headroom" : `${formatAcceleratorBytes(headroom)} reserved headroom`}.
          </span>
        </p>
      ) : eligibilityUnknown ? (
        <p className="ls-model-memory-note">
          <InfoIcon />
          <span>Run eligibility is unknown while accelerator memory is unavailable. Model-data actions remain available; dictation cannot claim a runnable profile until LocalScribe can measure memory.</span>
        </p>
      ) : null}
    </>
  );
}

function ModelFamilyCard({
  family,
  mode,
  currentFamilyId,
  pendingFamilyId,
  resolvedTier,
  fitsMemoryBudget,
  runtimeTierStatuses,
  action,
  runEligibilityUnknown,
  onInstall,
  onRepair,
  onRemove,
  onAddFamily,
  onFamilyChange,
  selectionDisabled,
}: {
  family: ModelCatalog["families"][number];
  mode: ModelModeChoice;
  currentFamilyId: ModelFamilyId;
  pendingFamilyId: ModelFamilyId;
  resolvedTier: ConcreteModelTier | null;
  fitsMemoryBudget: boolean | null;
  runtimeTierStatuses: readonly ModelTierRuntimeStatus[];
  action: ModelActionState;
  runEligibilityUnknown: boolean;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onAddFamily(familyId: ModelFamilyId): void;
  onFamilyChange(familyId: ModelFamilyId): void;
  selectionDisabled: boolean;
}) {
  const tiers = catalogTierViews(family, runtimeTierStatuses);
  const presentation = modelFamilyPresentation(family);
  const sharedArtifactIds = new Set(
    tiers.filter((tier) => tiers.filter((candidate) => candidate.artifactId === tier.artifactId).length > 1)
      .map((tier) => tier.artifactId),
  );
  const firstTierForArtifact = new Map<string, ConcreteModelTier>();
  for (const tier of tiers) {
    if (!firstTierForArtifact.has(tier.artifactId)) firstTierForArtifact.set(tier.artifactId, tier.tier);
  }
  const isDefault = family.familyId === DEFAULT_MODEL_FAMILY_ID;
  const isCurrent = family.familyId === currentFamilyId;
  const isPending = family.familyId === pendingFamilyId;

  return (
    <article className={isPending ? "ls-model-family-card is-selected" : isCurrent ? "ls-model-family-card is-active" : "ls-model-family-card"}>
      <header className="ls-model-family-heading">
        <div>
          <div className="ls-model-family-badges">
            {presentation.recommendation === "recommended" && <span className="ls-model-family-badge is-recommended">Recommended</span>}
            {family.familyId.toLowerCase().includes("parakeet") && <span className="ls-model-family-badge is-final">Fast final dictation</span>}
            {presentation.recommendation === "accurate" && <span className="ls-model-family-badge">Accuracy-focused</span>}
            {presentation.recommendation === "legacy" && <span className="ls-model-family-badge">Legacy</span>}
            {presentation.recommendation === "live" && <span className="ls-model-family-badge is-live">Live</span>}
            {isDefault && <span className="ls-model-family-badge">Built-in default</span>}
            {isCurrent && <span className="ls-model-family-badge is-active">Currently active</span>}
            {isPending && !isCurrent && <span className="ls-model-family-badge is-pending">Selected to apply</span>}
            {!isCurrent && family.inLibrary && <span className="ls-model-family-badge">Added to library</span>}
            {!family.inLibrary && <span className="ls-model-family-badge">Available to add</span>}
          </div>
          <h3>{family.displayName}</h3>
          <p>{presentation.summary}</p>
        </div>
        {!family.inLibrary ? (
          <button type="button" className="ls-small-button ls-model-primary-action" disabled={selectionDisabled} onClick={() => onAddFamily(family.familyId)}>
            {selectionDisabled && action?.action === "adding" && action.familyId === family.familyId ? "Adding…" : "Add to library"}
          </button>
        ) : !isPending ? (
          <button type="button" className="ls-small-button ls-model-primary-action" disabled={selectionDisabled} onClick={() => onFamilyChange(family.familyId)}>
            Select
          </button>
        ) : (
          <span className="ls-model-active-label">{isCurrent ? "Current selection" : "Pending selection"}</span>
        )}
      </header>

      {!isCurrent && family.inLibrary && (
        <p className="ls-model-family-note">Added locally. Select it, choose a performance mode, then use Apply model to switch safely.</p>
      )}
      {!family.inLibrary && (
        <p className="ls-model-family-note">This curated family is available but is not part of your local library yet. Add it before selecting it or managing its model data.</p>
      )}
      {presentation.experiences.length > 1 && (
        <p className="ls-model-family-note ls-model-family-note--shared-runtime">
          One downloaded model supports both After I stop and Live. Changing dictation experience does not download a second copy.
        </p>
      )}

      <dl className="ls-model-family-glance">
        <div><dt>Recognition</dt><dd>{presentation.latencyLabel}</dd></div>
        <div><dt>Languages</dt><dd>{presentation.languageLabel}</dd></div>
        <div><dt>Runtime</dt><dd>{catalogFamilyBackendLabel(family)}</dd></div>
      </dl>

      <div className="ls-model-tier-list">
        {tiers.map((tier) => (
          <ModelTierRow
            key={tier.profileId}
            tier={tier}
            selected={isPending && (mode === tier.tier || (
              mode === "auto"
              && fitsMemoryBudget === true
              && resolvedTier === tier.tier
            ))}
            activeFamily={isCurrent}
            familyInLibrary={family.inLibrary}
            sharedArtifact={sharedArtifactIds.has(tier.artifactId)}
            isArtifactControl={firstTierForArtifact.get(tier.artifactId) === tier.tier}
            artifactControlTier={firstTierForArtifact.get(tier.artifactId) ?? tier.tier}
            action={action?.action === "adding" ? null : action}
            operationsDisabled={selectionDisabled}
            runEligibilityUnknown={runEligibilityUnknown}
            onInstall={onInstall}
            onRepair={onRepair}
            onRemove={onRemove}
          />
        ))}
      </div>
    </article>
  );
}

function ModelTierRow({
  tier,
  selected,
  activeFamily,
  familyInLibrary,
  sharedArtifact,
  isArtifactControl,
  artifactControlTier,
  action,
  operationsDisabled,
  runEligibilityUnknown,
  onInstall,
  onRepair,
  onRemove,
}: {
  tier: ModelTierView;
  selected: boolean;
  activeFamily: boolean;
  familyInLibrary: boolean;
  sharedArtifact: boolean;
  isArtifactControl: boolean;
  artifactControlTier: ConcreteModelTier;
  action: ModelActionState;
  operationsDisabled: boolean;
  runEligibilityUnknown: boolean;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
}) {
  const status = modelVerificationPresentation(tier.verificationStatus);
  const activeAction = action
    && action.action !== "adding"
    && action.familyId === tier.familyId
    && action.tier === tier.tier
    ? action
    : null;
  /*
   * Every other control on this screen goes inert while an Apply runs; these
   * did not. Main serialises model operations, so a click during an Apply was
   * never unsafe — it silently queued behind an unload/load that can take tens
   * of seconds, with the button still advertising itself as available.
   */
  const anyAction = action !== null || operationsDisabled;
  const tierLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === tier.tier)?.label ?? tier.tier;
  const sharedWith = sharedArtifact ? "Shared artifact" : null;

  return (
    <article className={selected ? "ls-model-tier-row is-selected" : "ls-model-tier-row"} aria-busy={activeAction !== null || undefined}>
      <div className="ls-model-tier-heading">
        <span className="ls-model-tier-label">{tierLabel}</span>
        <span className={`ls-model-state is-${status.tone}`}>{status.label}</span>
      </div>
      <div className="ls-model-tier-title">
        <strong>{tier.displayName}</strong>
        {selected && <span>Selected</span>}
      </div>
      <dl className="ls-model-tier-facts">
        <div><dt>Precision</dt><dd>{tier.precision}</dd></div>
        <div><dt>Artifact</dt><dd>{formatModelBytes(tier.downloadBytes)}</dd></div>
        <div><dt>Memory</dt><dd>{formatMemoryRange(tier.acceleratorMemory)}</dd></div>
      </dl>
      <div className="ls-model-tier-footer">
        <p>{tier.qualityNote}{runEligibilityUnknown && activeFamily ? " Run eligibility is unknown until accelerator memory can be read." : ""}</p>
        {!familyInLibrary ? (
          <span className="ls-model-shared-label">
            Add to library to manage
          </span>
        ) : sharedArtifact && !isArtifactControl ? (
          <span className="ls-model-shared-label">{sharedWith} · managed from {tierLabelFor(artifactControlTier)}</span>
        ) : (
          <ModelArtifactControl
            tier={tier}
            activeAction={activeAction}
            anyAction={anyAction}
            onInstall={onInstall}
            onRepair={onRepair}
            onRemove={onRemove}
          />
        )}
      </div>
      <details className="ls-model-tier-details">
        <summary>Technical details</summary>
        <dl>
          <div><dt>Runtime</dt><dd>{tier.backend}</dd></div>
          <div><dt>License</dt><dd>{tier.license}</dd></div>
          <div><dt>Package</dt><dd>{tier.artifactId}</dd></div>
        </dl>
      </details>
    </article>
  );
}

function ModelArtifactControl({
  tier,
  activeAction,
  anyAction,
  onInstall,
  onRepair,
  onRemove,
}: {
  tier: ModelTierView;
  activeAction: ModelTierActionState | null;
  anyAction: boolean;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
}) {
  const tierLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === tier.tier)?.label ?? tier.tier;
  const request = (operation: "install" | "repair" | "remove") => {
    if (operation === "install") onInstall(tier.familyId, tier.tier);
    if (operation === "repair") onRepair(tier.familyId, tier.tier);
    if (operation === "remove") onRemove(tier.familyId, tier.tier);
  };
  const operationButton = (operation: "install" | "repair" | "remove", label: string, className = "") => (
    <button
      key={operation}
      type="button"
      className={`ls-small-button ${className}`.trim()}
      disabled={anyAction}
      onClick={() => request(operation)}
      aria-label={`${label} ${tierLabel} profile for ${tier.familyId}`}
    >
      {activeAction?.action === actionStateFor(operation) ? progressLabelFor(operation) : label}
    </button>
  );

  // Keep the confirmed operation visible until it finishes even if a
  // diagnostics or catalog refresh updates the disk status first.
  if (activeAction?.action === "installing") return <>
    {operationButton("install", "Download")}
    <ModelOperationProgress action={activeAction} expectedBytes={tier.downloadBytes} />
  </>;
  if (activeAction?.action === "repairing") return <>
    {operationButton("repair", "Repair", "ls-model-repair-button")}
    <ModelOperationProgress action={activeAction} expectedBytes={tier.downloadBytes} />
  </>;
  if (activeAction?.action === "removing") return <>
    {operationButton("remove", "Remove", "ls-model-remove-button")}
    <ModelOperationProgress action={activeAction} expectedBytes={tier.downloadBytes} />
  </>;
  if (tier.verificationStatus === "verified") return operationButton("remove", "Remove", "ls-model-remove-button");
  if (tier.verificationStatus === "invalid") return operationButton("repair", "Repair", "ls-model-repair-button");
  if (tier.verificationStatus === "missing") return operationButton("install", "Download");
  return operationButton("install", "Check / download");
}

export function modelActionProgressPresentation(
  action: ModelTierActionState,
  expectedBytes: number,
): { label: string; percent: number | null; completedBytes: number | null; totalBytes: number | null } {
  const phase = action.progress?.phase ?? "preparing";
  if (action.action === "removing") {
    return { label: "Removing local model data…", percent: null, completedBytes: null, totalBytes: null };
  }
  if (phase === "verifying") {
    const completedBytes = action.progress?.completedBytes;
    const totalBytes = action.progress?.totalBytes;
    if (completedBytes === undefined || totalBytes === undefined || totalBytes <= 0) {
      return { label: "Verifying local model files…", percent: null, completedBytes: null, totalBytes: null };
    }
    const boundedCompleted = Math.min(Math.max(0, completedBytes), totalBytes);
    const percent = Math.floor((boundedCompleted / totalBytes) * 100);
    return {
      label: `Verifying ${formatModelBytes(boundedCompleted)} of ${formatModelBytes(totalBytes)} (${percent}%)`,
      percent,
      completedBytes: boundedCompleted,
      totalBytes,
    };
  }
  if (phase === "complete") {
    return { label: "Download verified.", percent: 100, completedBytes: null, totalBytes: null };
  }
  if (phase === "failed") {
    return {
      label: action.progress?.message ?? "Download did not finish. See the message above and try again.",
      percent: null,
      completedBytes: null,
      totalBytes: null,
    };
  }
  if (phase === "preparing") {
    return {
      label: action.action === "repairing" ? "Preparing repair…" : "Preparing secure download…",
      percent: null,
      completedBytes: null,
      totalBytes: null,
    };
  }
  const completedBytes = Math.max(0, action.progress?.completedBytes ?? 0);
  const totalBytes = Math.max(0, action.progress?.totalBytes ?? expectedBytes);
  if (totalBytes <= 0) {
    return { label: "Downloading model data…", percent: null, completedBytes: null, totalBytes: null };
  }
  const boundedCompleted = Math.min(completedBytes, totalBytes);
  const percent = Math.floor((boundedCompleted / totalBytes) * 100);
  return {
    label: `Downloading ${formatModelBytes(boundedCompleted)} of ${formatModelBytes(totalBytes)} (${percent}%)`,
    percent,
    completedBytes: boundedCompleted,
    totalBytes,
  };
}

function ModelOperationProgress({ action, expectedBytes }: {
  action: ModelTierActionState;
  expectedBytes: number;
}) {
  const presentation = modelActionProgressPresentation(action, expectedBytes);
  return (
    <div className="ls-model-operation-progress" role="status" aria-live="polite">
      <span
        className={presentation.percent === null ? "ls-model-operation-progress__bar is-indeterminate" : "ls-model-operation-progress__bar"}
        role="progressbar"
        aria-label={presentation.label}
        aria-valuemin={presentation.percent === null ? undefined : 0}
        aria-valuemax={presentation.percent === null ? undefined : 100}
        aria-valuenow={presentation.percent ?? undefined}
      >
        <i style={presentation.percent === null ? undefined : { width: `${presentation.percent}%` }} />
      </span>
      <span>{presentation.label}</span>
    </div>
  );
}

function actionStateFor(operation: "install" | "repair" | "remove"): "installing" | "repairing" | "removing" {
  if (operation === "install") return "installing";
  if (operation === "repair") return "repairing";
  return "removing";
}

function progressLabelFor(operation: "install" | "repair" | "remove"): string {
  if (operation === "install") return "Downloading…";
  if (operation === "repair") return "Repairing…";
  return "Removing…";
}

function tierLabelFor(tier: ConcreteModelTier): string {
  return MODEL_MODE_CHOICES.find((choice) => choice.id === tier)?.label ?? tier;
}

function modeLabel(mode: ModelPerformanceMode): string {
  return MODEL_MODE_CHOICES.find((choice) => choice.id === mode)?.label ?? mode;
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
