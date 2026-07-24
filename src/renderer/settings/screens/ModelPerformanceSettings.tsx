import type { ReactNode } from "react";
import {
  DEFAULT_MODEL_FAMILY_ID,
  type ModelCatalog,
  type ModelFamilyId,
  type ModelPerformanceMode,
  type ModelPerformanceTier,
} from "../../../shared/contracts";

export const MODEL_MODE_CHOICES = [
  { id: "auto", label: "Auto" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
] as const satisfies readonly { id: ModelPerformanceMode; label: string }[];

const TIER_ORDER: readonly ModelPerformanceTier[] = ["high", "medium", "low"];

export type ModelModeChoice = ModelPerformanceMode;
export type ConcreteModelTier = ModelPerformanceTier;
export type ModelVerificationState = "missing" | "invalid" | "verified" | "unknown";
export type ModelActionState = {
  action: "installing" | "repairing" | "removing";
  familyId: ModelFamilyId;
  tier: ConcreteModelTier;
} | null;

/** Runtime-only facts. Catalog metadata remains usable when these are unavailable. */
export interface ModelTierRuntimeStatus {
  familyId: ModelFamilyId;
  tier: ConcreteModelTier;
  artifactId: string;
  qualityNote: string;
  verificationStatus: Exclude<ModelVerificationState, "unknown">;
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
  platform: "darwin" | "win32" | "linux" | "unsupported";
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
  onModeChange(mode: ModelModeChoice): void;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onAddFamily(familyId: ModelFamilyId): void;
  onActivateFamily(familyId: ModelFamilyId): void;
  onRefresh(): void;
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

export function platformModelCopy(platform: ModelHardwareView["platform"] | null): {
  summary: string;
  memoryLabel: string;
} {
  if (platform === "darwin") {
    return {
      summary: "Auto uses available unified memory to choose the best MLX tier for this Mac.",
      memoryLabel: "Unified memory",
    };
  }
  if (platform === "win32") {
    return {
      summary: "Auto uses available NVIDIA VRAM to choose the best faster-whisper tier for this PC.",
      memoryLabel: "NVIDIA VRAM",
    };
  }
  return {
    summary: "Auto uses the platform memory reported by LocalScribe to choose a supported tier.",
    memoryLabel: "Accelerator memory",
  };
}

export function platformEngineLabel(platform: ModelHardwareView["platform"] | null): string {
  if (platform === "darwin") return "MLX Whisper";
  if (platform === "win32") return "faster-whisper/CTranslate2 CUDA";
  return "Curated local speech runtime";
}

export function friendlyPrecision(precision: string): string {
  const normalized = precision.toLowerCase();
  if (normalized === "fp16" || normalized === "float16") return "FP16";
  if (normalized === "int8_float16" || normalized === "int8-float16") {
    return "INT8 weights + FP16 compute";
  }
  if (normalized === "int8") return "INT8";
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
 * identity. This intentionally does not assume that Windows artifacts share
 * just because the platform is Windows.
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
        qualityNote: runtime?.qualityNote ?? "Curated local speech profile. Activate this family to verify its installed data.",
        verificationStatus: runtime?.verificationStatus ?? "unknown",
      };
    });
}

export function ModelPerformanceSettings({
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
  onModeChange,
  onInstall,
  onRepair,
  onRemove,
  onAddFamily,
  onActivateFamily,
  onRefresh,
}: ModelPerformanceSettingsProps) {
  const platform = hardware?.platform ?? platformFromCatalog(catalog);
  const platformCopy = platformModelCopy(platform);
  const resolvedLabel = resolvedTier
    ? MODEL_MODE_CHOICES.find((choice) => choice.id === resolvedTier)?.label ?? resolvedTier
    : "Run eligibility unavailable";
  const autoResolutionLabel = fitsMemoryBudget === false ? "No tier fits" : resolvedLabel;
  const requestedLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === mode)?.label ?? mode;
  const eligibilityUnknown = hardware === null || hardware.availableMemoryBytes === null;

  return (
    <div className="ls-model-performance">
      <section className="ls-model-auto-card" aria-labelledby="model-auto-heading">
        <div>
          <span>Performance within the active family</span>
          <h2 id="model-auto-heading">
            {mode === "auto" ? <>Auto resolves to <strong>{autoResolutionLabel}</strong></> : <>Using <strong>{requestedLabel}</strong></>}
          </h2>
          <p>{platformCopy.summary} Family selection changes the speech model; Auto, High, Medium, and Low choose a profile only within that active family.</p>
        </div>
        <button type="button" className="ls-secondary-button" onClick={onRefresh}>
          Refresh model status
        </button>
      </section>

      <fieldset className="ls-model-mode-picker">
        <legend>Performance mode</legend>
        <p>Choose Auto or one concrete quality and memory profile for the active speech-model family.</p>
        <div>
          {MODEL_MODE_CHOICES.map((choice) => (
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

      {mode === "auto" && resolutionReason && (
        <p className="ls-model-resolution-note" role="status">
          <InfoIcon />
          <span>{resolutionReason}</span>
        </p>
      )}

      <MemoryStatus
        hardware={hardware}
        memoryRequirement={memoryRequirement}
        platformCopy={platformCopy}
        eligibilityUnknown={eligibilityUnknown}
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
            <h2 id="model-catalog-heading">Curated local speech-model catalog</h2>
            <p>Fixed local runtime; model packages are pinned data files that LocalScribe verifies. Custom paths, URLs, and loaders are not accepted.</p>
          </div>
        </div>

        {catalogError ? (
          <div className="ls-model-empty is-error" role="alert">
            Could not load the curated model catalog: {catalogError}. Model-library actions are unavailable until it loads.
          </div>
        ) : !catalog ? (
          <div className="ls-model-empty" role="status">Loading curated model catalog…</div>
        ) : (
          <div className="ls-model-family-list">
            {catalog.families.map((family) => (
              <ModelFamilyCard
                key={family.familyId}
                family={family}
                mode={mode}
                resolvedTier={resolvedTier}
                fitsMemoryBudget={fitsMemoryBudget}
                runtimeTierStatuses={runtimeTierStatuses}
                action={action}
                runEligibilityUnknown={eligibilityUnknown}
                platformEngine={platformEngineLabel(platform)}
                onInstall={onInstall}
                onRepair={onRepair}
                onRemove={onRemove}
                onAddFamily={onAddFamily}
                onActivateFamily={onActivateFamily}
              />
            ))}
          </div>
        )}

        {platform === "darwin" && (
          <p className="ls-model-compatibility-note">
            Additional model families appear here only after their complete High, Medium, and Low MLX profiles have pinned manifests and package validation.
          </p>
        )}
      </section>
    </div>
  );
}

function MemoryStatus({
  hardware,
  memoryRequirement,
  platformCopy,
  eligibilityUnknown,
}: {
  hardware: ModelHardwareView | null;
  memoryRequirement: ModelMemoryRequirementView | null;
  platformCopy: ReturnType<typeof platformModelCopy>;
  eligibilityUnknown: boolean;
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
  return (
    <>
      <section className="ls-model-hardware" aria-label="Detected accelerator memory">
        <span>
          <strong>{hardware.displayName}</strong>
          <small>{platformCopy.memoryLabel}</small>
        </span>
        <span>
          <strong>{hardware.totalMemoryBytes === null ? "Unavailable" : formatAcceleratorBytes(hardware.totalMemoryBytes)}</strong>
          <small>Total</small>
        </span>
        <span>
          <strong>{hardware.availableMemoryBytes === null ? "Unavailable" : formatAcceleratorBytes(hardware.availableMemoryBytes)}</strong>
          <small>Available now · {hardware.memoryBasis}</small>
        </span>
      </section>
      {requirement !== null && requirement !== undefined ? (
        <p className="ls-model-memory-note">
          <InfoIcon />
          <span>
            This selected profile requires <strong>{formatAcceleratorBytes(requirement)}</strong> free {platformCopy.memoryLabel.toLowerCase()}, including {headroom === null || headroom === undefined ? "the reserved runtime headroom" : `${formatAcceleratorBytes(headroom)} reserved headroom`}.
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
  resolvedTier,
  fitsMemoryBudget,
  runtimeTierStatuses,
  action,
  runEligibilityUnknown,
  platformEngine,
  onInstall,
  onRepair,
  onRemove,
  onAddFamily,
  onActivateFamily,
}: {
  family: ModelCatalog["families"][number];
  mode: ModelModeChoice;
  resolvedTier: ConcreteModelTier | null;
  fitsMemoryBudget: boolean | null;
  runtimeTierStatuses: readonly ModelTierRuntimeStatus[];
  action: ModelActionState;
  runEligibilityUnknown: boolean;
  platformEngine: string;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onAddFamily(familyId: ModelFamilyId): void;
  onActivateFamily(familyId: ModelFamilyId): void;
}) {
  const tiers = catalogTierViews(family, runtimeTierStatuses);
  const sharedArtifactIds = new Set(
    tiers.filter((tier) => tiers.filter((candidate) => candidate.artifactId === tier.artifactId).length > 1)
      .map((tier) => tier.artifactId),
  );
  const firstTierForArtifact = new Map<string, ConcreteModelTier>();
  for (const tier of tiers) {
    if (!firstTierForArtifact.has(tier.artifactId)) firstTierForArtifact.set(tier.artifactId, tier.tier);
  }
  const isDefault = family.familyId === DEFAULT_MODEL_FAMILY_ID;

  return (
    <article className={family.active ? "ls-model-family-card is-active" : "ls-model-family-card"}>
      <header className="ls-model-family-heading">
        <div>
          <div className="ls-model-family-badges">
            {isDefault && <span className="ls-model-family-badge">Built-in default</span>}
            {family.active && <span className="ls-model-family-badge is-active">Active family</span>}
            {!family.active && family.inLibrary && <span className="ls-model-family-badge">Added to library</span>}
            {!family.inLibrary && <span className="ls-model-family-badge">Available to add</span>}
          </div>
          <h3>{family.displayName}</h3>
          <p>Platform engine: {platformEngine}</p>
        </div>
        {!family.inLibrary ? (
          <button type="button" className="ls-small-button ls-model-primary-action" onClick={() => onAddFamily(family.familyId)}>
            Add to library
          </button>
        ) : !family.active ? (
          <button type="button" className="ls-small-button ls-model-primary-action" onClick={() => onActivateFamily(family.familyId)}>
            Activate
          </button>
        ) : (
          <span className="ls-model-active-label">Used for dictation</span>
        )}
      </header>

      {!family.active && family.inLibrary && (
        <p className="ls-model-family-note">Added locally and ready to activate. Performance mode will continue to apply to the currently active family until you activate this one.</p>
      )}
      {!family.inLibrary && (
        <p className="ls-model-family-note">This curated family is available but is not part of your local library yet. Add it before activation or model-data actions.</p>
      )}

      <div className="ls-model-tier-list">
        {tiers.map((tier) => (
          <ModelTierRow
            key={tier.profileId}
            tier={tier}
            selected={family.active && (mode === tier.tier || (
              mode === "auto"
              && fitsMemoryBudget === true
              && resolvedTier === tier.tier
            ))}
            activeFamily={family.active}
            sharedArtifact={sharedArtifactIds.has(tier.artifactId)}
            isArtifactControl={firstTierForArtifact.get(tier.artifactId) === tier.tier}
            artifactControlTier={firstTierForArtifact.get(tier.artifactId) ?? tier.tier}
            action={action}
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
  sharedArtifact,
  isArtifactControl,
  artifactControlTier,
  action,
  runEligibilityUnknown,
  onInstall,
  onRepair,
  onRemove,
}: {
  tier: ModelTierView;
  selected: boolean;
  activeFamily: boolean;
  sharedArtifact: boolean;
  isArtifactControl: boolean;
  artifactControlTier: ConcreteModelTier;
  action: ModelActionState;
  runEligibilityUnknown: boolean;
  onInstall(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRepair(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
  onRemove(familyId: ModelFamilyId, tier: ConcreteModelTier): void;
}) {
  const status = modelVerificationPresentation(tier.verificationStatus);
  const activeAction = action?.familyId === tier.familyId && action.tier === tier.tier ? action.action : null;
  const anyAction = action !== null;
  const tierLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === tier.tier)?.label ?? tier.tier;
  const sharedWith = sharedArtifact ? "Shared artifact" : null;

  return (
    <article className={selected ? "ls-model-tier-row is-selected" : "ls-model-tier-row"}>
      <div className="ls-model-tier-heading">
        <span className="ls-model-tier-label">{tierLabel}</span>
        <span className={`ls-model-state is-${status.tone}`}>{status.label}</span>
      </div>
      <div className="ls-model-tier-title">
        <strong>{tier.displayName}</strong>
        {selected && <span>Selected</span>}
      </div>
      <dl className="ls-model-tier-facts">
        <div><dt>Backend</dt><dd>{tier.backend}</dd></div>
        <div><dt>Precision</dt><dd>{tier.precision}</dd></div>
        <div><dt>Artifact</dt><dd>{formatModelBytes(tier.downloadBytes)}</dd></div>
        <div><dt>Memory</dt><dd>{formatMemoryRange(tier.acceleratorMemory)}</dd></div>
        <div><dt>License</dt><dd>{tier.license}</dd></div>
      </dl>
      <div className="ls-model-tier-footer">
        <p>{tier.qualityNote}{runEligibilityUnknown && activeFamily ? " Run eligibility is unknown until accelerator memory can be read." : ""}</p>
        {!activeFamily ? (
          <span className="ls-model-shared-label">{tier.familyId === DEFAULT_MODEL_FAMILY_ID ? "Built-in family" : "Activate to manage"}</span>
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
  activeAction: "installing" | "repairing" | "removing" | null;
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
      {activeAction === actionStateFor(operation) ? progressLabelFor(operation) : label}
    </button>
  );

  if (tier.verificationStatus === "verified") return operationButton("remove", "Remove", "ls-model-remove-button");
  if (tier.verificationStatus === "invalid") return operationButton("repair", "Repair", "ls-model-repair-button");
  if (tier.verificationStatus === "missing") return operationButton("install", "Download");
  return operationButton("install", "Check / download");
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

function platformFromCatalog(catalog: ModelCatalog | null): ModelHardwareView["platform"] | null {
  if (catalog?.platform === "darwin-arm64") return "darwin";
  if (catalog?.platform === "win32-x64-cuda") return "win32";
  return null;
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
