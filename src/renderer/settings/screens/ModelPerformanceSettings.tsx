import type { ReactNode } from "react";
import type {
  ModelPerformanceMode,
  ModelPerformanceTier,
} from "../../../shared/contracts";

export const MODEL_MODE_CHOICES = [
  { id: "auto", label: "Auto" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
] as const satisfies readonly { id: ModelPerformanceMode; label: string }[];

export type ModelModeChoice = ModelPerformanceMode;
export type ConcreteModelTier = ModelPerformanceTier;
export type ModelVerificationState = "missing" | "invalid" | "verified";
export type ModelActionState = {
  action: "installing" | "repairing" | "removing";
  tier: ConcreteModelTier;
} | null;

export interface ModelTierView {
  tier: ConcreteModelTier;
  displayName: string;
  backend: string;
  precision: string;
  downloadBytes: number;
  acceleratorMemory: {
    minimumBytes: number;
    maximumBytes: number;
    basis: "measured" | "estimated";
  };
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

export interface ModelPerformanceSettingsProps {
  mode: ModelModeChoice;
  resolvedTier: ConcreteModelTier | null;
  fitsMemoryBudget: boolean | null;
  resolutionReason: string | null;
  hardware: ModelHardwareView | null;
  tiers: readonly ModelTierView[];
  action: ModelActionState;
  feedback: { message: string; isError: boolean } | null;
  onModeChange(mode: ModelModeChoice): void;
  onInstall(tier: ConcreteModelTier): void;
  onRepair(tier: ConcreteModelTier): void;
  onRemove(tier: ConcreteModelTier): void;
  onRefresh(): void;
}

export function modelVerificationPresentation(status: ModelVerificationState): {
  label: string;
  tone: "ready" | "missing" | "repair";
} {
  if (status === "verified") return { label: "Verified", tone: "ready" };
  if (status === "invalid") return { label: "Repair required", tone: "repair" };
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

export function ModelPerformanceSettings({
  mode,
  resolvedTier,
  fitsMemoryBudget,
  resolutionReason,
  hardware,
  tiers,
  action,
  feedback,
  onModeChange,
  onInstall,
  onRepair,
  onRemove,
  onRefresh,
}: ModelPerformanceSettingsProps) {
  const platformCopy = platformModelCopy(hardware?.platform ?? null);
  const resolvedLabel = resolvedTier
    ? MODEL_MODE_CHOICES.find((choice) => choice.id === resolvedTier)?.label ?? resolvedTier
    : "Checking";
  const autoResolutionLabel = fitsMemoryBudget === false ? "No tier fits" : resolvedLabel;
  const requestedLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === mode)?.label ?? mode;
  const orderedTiers = MODEL_MODE_CHOICES.flatMap((choice) => (
    choice.id === "auto" ? [] : tiers.filter((tier) => tier.tier === choice.id)
  ));
  const usesSharedWindowsArtifact = hardware?.platform === "win32";

  return (
    <div className="ls-model-performance">
      <section className="ls-model-auto-card" aria-labelledby="model-auto-heading">
        <div>
          <span>Local performance</span>
          <h2 id="model-auto-heading">
            {mode === "auto" ? <>Auto resolves to <strong>{autoResolutionLabel}</strong></> : <>Using <strong>{requestedLabel}</strong></>}
          </h2>
          <p>{platformCopy.summary} Recheck after platform memory changes to resolve it again.</p>
        </div>
        <button type="button" className="ls-secondary-button" onClick={onRefresh}>
          Recheck memory
        </button>
      </section>

      <fieldset className="ls-model-mode-picker">
        <legend>Performance mode</legend>
        <p>Choose Auto or one concrete quality and memory tier.</p>
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
                      : "Checking"}
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

      {hardware && (
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
      )}

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
            <h2 id="model-catalog-heading">Local speech models</h2>
            <p>Download sizes, memory ranges, and evidence labels come from the packaged model catalog.</p>
            {usesSharedWindowsArtifact && (
              <p>
                Windows uses one verified large-v3 download for all three modes.
                Installing, repairing, or removing it affects High, Medium, and Low together.
              </p>
            )}
          </div>
        </div>

        {orderedTiers.length === 0 ? (
          <div className="ls-model-empty" role="status">Checking the local model catalog…</div>
        ) : (
          <div className="ls-model-tier-list">
            {orderedTiers.map((tier) => (
              <ModelTierRow
                key={tier.tier}
                tier={tier}
                selected={mode === tier.tier || (
                  mode === "auto"
                  && fitsMemoryBudget === true
                  && resolvedTier === tier.tier
                )}
                sharedArtifact={usesSharedWindowsArtifact}
                action={action}
                onInstall={onInstall}
                onRepair={onRepair}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ModelTierRow({
  tier,
  selected,
  sharedArtifact,
  action,
  onInstall,
  onRepair,
  onRemove,
}: {
  tier: ModelTierView;
  selected: boolean;
  sharedArtifact: boolean;
  action: ModelActionState;
  onInstall(tier: ConcreteModelTier): void;
  onRepair(tier: ConcreteModelTier): void;
  onRemove(tier: ConcreteModelTier): void;
}) {
  const status = modelVerificationPresentation(tier.verificationStatus);
  const activeAction = action?.tier === tier.tier ? action.action : null;
  const anyAction = action !== null;
  const tierLabel = MODEL_MODE_CHOICES.find((choice) => choice.id === tier.tier)?.label ?? tier.tier;

  let control: ReactNode;
  if (tier.verificationStatus === "verified") {
    control = (
      <button
        type="button"
        className="ls-small-button ls-model-remove-button"
        disabled={anyAction}
        onClick={() => onRemove(tier.tier)}
        aria-label={`Remove ${tierLabel} model`}
      >
        {activeAction === "removing" ? "Removing…" : "Remove"}
      </button>
    );
  } else if (tier.verificationStatus === "invalid") {
    control = (
      <button
        type="button"
        className="ls-small-button ls-model-repair-button"
        disabled={anyAction}
        onClick={() => onRepair(tier.tier)}
        aria-label={`Repair ${tierLabel} model`}
      >
        {activeAction === "repairing" ? "Repairing…" : "Repair"}
      </button>
    );
  } else {
    control = (
      <button
        type="button"
        className="ls-small-button"
        disabled={anyAction}
        onClick={() => onInstall(tier.tier)}
        aria-label={`Install ${tierLabel} model`}
      >
        {activeAction === "installing" ? "Installing…" : "Install"}
      </button>
    );
  }

  return (
    <article className={selected ? "ls-model-tier-row is-selected" : "ls-model-tier-row"}>
      <div className="ls-model-tier-heading">
        <span className="ls-model-tier-label">{tierLabel}</span>
        <span className={`ls-model-state is-${status.tone}`}>{status.label}</span>
      </div>
      <div className="ls-model-tier-title">
        <strong>{tier.displayName}</strong>
        {selected && <span>{selected && "Selected"}</span>}
      </div>
      <dl className="ls-model-tier-facts">
        <div><dt>Backend</dt><dd>{tier.backend}</dd></div>
        <div><dt>Precision</dt><dd>{tier.precision}</dd></div>
        <div><dt>Download</dt><dd>{formatModelBytes(tier.downloadBytes)}</dd></div>
        <div><dt>Accelerator memory</dt><dd>{formatMemoryRange(tier.acceleratorMemory)}</dd></div>
      </dl>
      <div className="ls-model-tier-footer">
        <p>{tier.qualityNote}</p>
        {sharedArtifact && !selected
          ? <span className="ls-model-shared-label">Shared download</span>
          : control}
      </div>
    </article>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}
