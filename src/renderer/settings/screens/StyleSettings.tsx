import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_SETTINGS,
  HISTORY_RETENTION_OPTIONS,
  historyRetentionLabel,
  type AppProfile,
  type AppSettings,
  type DictionaryEntry,
  type Diagnostics,
  type ModelPerformanceTier,
  type PermissionSnapshot,
} from "../../../shared/contracts";
import {
  shortcutDisplayLabel,
  type HoldShortcut,
  type ToggleShortcut,
} from "../../../shared/shortcuts";
import { ShortcutRecorder, type ShortcutKind, type ShortcutValidationOutcome } from "../components/ShortcutRecorder";
import {
  ModelPerformanceSettings,
  type ModelActionState,
} from "./ModelPerformanceSettings";
import "./style-settings.css";

type StyleTab = "personal" | "work" | "email" | "other" | "cleanup";
type SettingsTab = "general" | "system" | "model" | "writing" | "experimental" | "privacy";
type CleanupLevel = "none" | "light" | "medium";
export type CleanupSelection = CleanupLevel | "custom";
export const GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE = "Additional generative text model required — not installed";
export const UNAVAILABLE_IN_THIS_BUILD_NOTICE = "Unavailable in this build";

export function cleanupSelectionForSettings(
  settings: Pick<AppSettings, "removeFillers" | "spokenCommands" | "smartPunctuation">,
): CleanupSelection {
  if (!settings.removeFillers && !settings.spokenCommands && !settings.smartPunctuation) return "none";
  if (!settings.removeFillers && settings.spokenCommands && settings.smartPunctuation) return "light";
  if (settings.removeFillers && settings.spokenCommands && settings.smartPunctuation) return "medium";
  return "custom";
}

export function modelPerformanceSaveMessage(
  mode: AppSettings["modelPerformanceMode"],
  performance: Pick<Diagnostics["performance"], "fitsMemoryBudget" | "resolvedTier">,
): string {
  if (mode !== "auto") return `${tierLabel(mode)} performance mode saved.`;
  if (!performance.fitsMemoryBudget) {
    return "Auto saved, but no tier fits the current memory budget. Dictation stays blocked until enough memory is available.";
  }
  if (performance.resolvedTier) {
    return `Auto saved and resolved to ${tierLabel(performance.resolvedTier)} using the current platform memory.`;
  }
  return "Auto performance mode saved.";
}

const styleTabs: { id: StyleTab; label: string }[] = [
  { id: "personal", label: "Personal messages" },
  { id: "work", label: "Work messages" },
  { id: "email", label: "Email" },
  { id: "other", label: "Other" },
  { id: "cleanup", label: "Auto cleanup" },
];

export const SETTINGS_TABS: { id: SettingsTab; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: <SlidersIcon /> },
  { id: "system", label: "System", icon: <DesktopIcon /> },
  { id: "model", label: "Model & Performance", icon: <GaugeIcon /> },
  { id: "writing", label: "Writing", icon: <PenIcon /> },
  { id: "experimental", label: "Experimental", icon: <FlaskIcon /> },
  { id: "privacy", label: "Data & Privacy", icon: <LockIcon /> },
];

const toneOptions: Record<Exclude<StyleTab, "cleanup">, { title: string; description: string; preview: string }[]> = {
  personal: [
    {
      title: "Casual",
      description: "Relaxed language for everyday conversations.",
      preview: "Hey! I’m running a little late, but I should be there in about ten minutes.",
    },
    {
      title: "Very casual",
      description: "Short, easygoing messages for people you know well.",
      preview: "Running a bit late — be there in ten!",
    },
    {
      title: "Excited",
      description: "An energetic reference for celebrations and good news.",
      preview: "That’s amazing news! I can’t wait to celebrate with you.",
    },
  ],
  work: [
    {
      title: "Professional",
      description: "Clear, direct language for teammates and clients.",
      preview: "I reviewed the proposal and added comments to the final two sections.",
    },
    {
      title: "Concise",
      description: "A compact reference for quick status updates.",
      preview: "Proposal reviewed. Comments added to the final two sections.",
    },
    {
      title: "Approachable",
      description: "Professional without sounding overly formal.",
      preview: "I took a look at the proposal and left a few notes near the end.",
    },
  ],
  email: [
    {
      title: "Formal",
      description: "A measured reference for external correspondence.",
      preview: "Hello Morgan, thank you for sending the revised timeline. I will review it this afternoon.",
    },
    {
      title: "Friendly",
      description: "Warm language for familiar collaborators.",
      preview: "Hi Morgan, thanks for sending this over! I’ll review it this afternoon.",
    },
    {
      title: "Brief",
      description: "A practical reference for fast replies.",
      preview: "Thanks, Morgan. I’ll review the revised timeline this afternoon.",
    },
  ],
  other: [
    {
      title: "Neutral",
      description: "Straightforward language that works in most text fields.",
      preview: "The appointment has moved to Thursday at 2:30 PM.",
    },
    {
      title: "Detailed",
      description: "A reference for preserving context and specifics.",
      preview: "The appointment originally planned for Tuesday has moved to Thursday at 2:30 PM.",
    },
    {
      title: "Plain language",
      description: "Simple wording with a direct sentence structure.",
      preview: "Your appointment is now Thursday at 2:30 PM.",
    },
  ],
};

const cleanupOptions: { id: CleanupLevel; title: string; description: string; bullets: string[] }[] = [
  {
    id: "none",
    title: "None",
    description: "Keep the recognizer output close to what was spoken.",
    bullets: ["No filler removal", "No spoken editing commands", "No punctuation normalization"],
  },
  {
    id: "light",
    title: "Light",
    description: "Apply punctuation and spoken editing commands, while preserving fillers.",
    bullets: ["Spoken punctuation", "Paragraph and backtracking commands", "Preserves hesitation words"],
  },
  {
    id: "medium",
    title: "Medium",
    description: "Use every deterministic cleanup behavior available locally.",
    bullets: ["Filler removal", "Spoken punctuation and paragraphs", "Backtracking and spacing cleanup"],
  },
];

export function StyleScreen() {
  const [tab, setTab] = useState<StyleTab>("personal");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileMessageIsError, setProfileMessageIsError] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);

  const loadProfiles = useCallback(() => window.localScribe.profiles.list().then(setProfiles), []);

  useEffect(() => {
    void window.localScribe.settings.get().then(setSettings).catch((error: unknown) => {
      setMessageIsError(true);
      setMessage(`Could not load cleanup settings: ${errorDetail(error)}`);
    });
    void loadProfiles().catch((error: unknown) => {
      setProfileMessageIsError(true);
      setProfileMessage(`Could not load app profiles: ${errorDetail(error)}`);
    });
  }, [loadProfiles]);

  const cleanupLevel = useMemo<CleanupSelection>(() => cleanupSelectionForSettings(settings), [settings]);

  const chooseCleanup = (level: CleanupLevel) => {
    const next: AppSettings = {
      ...settings,
      removeFillers: level === "medium",
      spokenCommands: level !== "none",
      smartPunctuation: level !== "none",
    };
    setSettings(next);
    setMessage("");
    setMessageIsError(false);
  };

  const saveCleanup = async () => {
    try {
      const saved = await window.localScribe.settings.save(settings);
      setSettings(saved);
      setMessageIsError(false);
      setMessage("Cleanup saved");
    } catch (error) {
      setMessageIsError(true);
      setMessage(`Could not save cleanup: ${errorDetail(error)}`);
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setProfileBusy(true);
    try {
      await window.localScribe.profiles.save({
        label: String(data.get("label")),
        appId: String(data.get("appId")),
        removeFillers: data.get("removeFillers") === "on",
        spokenCommands: data.get("spokenCommands") === "on",
        smartPunctuation: data.get("smartPunctuation") === "on",
      });
      await loadProfiles();
      form.reset();
      setProfileOpen(false);
      setProfileMessageIsError(false);
      setProfileMessage("Profile saved");
    } catch (error) {
      setProfileMessageIsError(true);
      setProfileMessage(`Could not save profile: ${errorDetail(error)}`);
    } finally {
      setProfileBusy(false);
    }
  };

  const deleteProfile = async (id: string) => {
    setProfileBusy(true);
    try {
      await window.localScribe.profiles.delete(id);
      await loadProfiles();
      setProfileMessageIsError(false);
      setProfileMessage("Profile deleted");
    } catch (error) {
      setProfileMessageIsError(true);
      setProfileMessage(`Could not delete profile: ${errorDetail(error)}`);
    } finally {
      setProfileBusy(false);
    }
  };

  return (
    <div className="ls-page ls-style-screen">
      <ScreenHeader
        eyebrow="Writing preferences"
        title="Style"
        description="Deterministic cleanup works now. Tone rewrites require a separate generative text model."
      />

      <nav className="ls-tabbar" aria-label="Style categories">
        {styleTabs.map((item) => (
          <button
            type="button"
            key={item.id}
            className={tab === item.id ? "is-active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      {tab !== "cleanup" ? (
        <section className="ls-section" aria-labelledby="tone-heading">
          <div className="ls-section-heading">
            <div>
              <h2 id="tone-heading">How should it sound?</h2>
              <p>These are local preview references. The installed speech model transcribes speech but does not rewrite tone.</p>
            </div>
            <span className="ls-status-chip ls-status-chip--muted ls-status-chip--model-required">{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</span>
          </div>
          <div className="ls-tone-grid">
            {toneOptions[tab].map((option) => (
              <article
                className="ls-tone-card ls-tone-card--preview ls-tone-card--unavailable"
                key={option.title}
                aria-disabled="true"
              >
                <span className="ls-status-chip ls-status-chip--muted ls-status-chip--model-required">{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</span>
                <strong>{option.title}</strong>
                <small>{option.description}</small>
                <span className="ls-preview">“{option.preview}”</span>
              </article>
            ))}
          </div>
          <div className="ls-info-callout">
            <SparkIcon />
            <div>
              <strong>{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</strong>
              <p>LocalScribe currently has only the speech model. These examples are previews; selecting a tone does not rewrite text.</p>
            </div>
          </div>
        </section>
      ) : (
        <section className="ls-section" aria-labelledby="cleanup-heading">
          <div className="ls-section-heading">
            <div>
              <h2 id="cleanup-heading">Automatic cleanup</h2>
              <p>These levels map directly to the deterministic writing pipeline.</p>
            </div>
            {message ? (
              <span className={messageIsError ? "ls-status-chip ls-status-chip--error" : "ls-status-chip"} role="status" aria-live="polite">{message}</span>
            ) : cleanupLevel === "custom" ? (
              <span className="ls-status-chip ls-status-chip--muted">Custom mix</span>
            ) : null}
          </div>
          <div className="ls-cleanup-grid">
            {cleanupOptions.map((option) => (
              <button
                type="button"
                key={option.id}
                className={cleanupLevel === option.id ? "ls-cleanup-card is-selected" : "ls-cleanup-card"}
                onClick={() => chooseCleanup(option.id)}
                aria-pressed={cleanupLevel === option.id}
              >
                <span className="ls-radio-dot" />
                <strong>{option.title}</strong>
                <p>{option.description}</p>
                <ul>{option.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>
              </button>
            ))}
          </div>
          {cleanupLevel === "custom" && (
            <p className="ls-honesty-note"><InfoIcon /> Individual cleanup switches are using a custom combination. Choose a level to replace it.</p>
          )}
          <button type="button" className="ls-primary-button" onClick={() => void saveCleanup()}>Save cleanup</button>
        </section>
      )}

      <section className="ls-section ls-profiles-section" aria-labelledby="profiles-heading">
        <div className="ls-section-heading">
          <div>
            <h2 id="profiles-heading">App profiles</h2>
            <p>Override cleanup for a macOS bundle ID or Windows executable.</p>
          </div>
          <button type="button" className="ls-secondary-button" onClick={() => setProfileOpen((open) => !open)}>
            {profileOpen ? "Cancel" : "+ Add profile"}
          </button>
        </div>

        {profileOpen && <ProfileForm onSubmit={saveProfile} busy={profileBusy} />}
        {profileMessage && (
          <p className={profileMessageIsError ? "ls-action-feedback is-error" : "ls-action-feedback"} role={profileMessageIsError ? "alert" : "status"} aria-live="polite">
            {profileMessage}
          </p>
        )}

        <div className="ls-profile-list">
          {profiles.length === 0 ? (
            <div className="ls-empty-row"><strong>No app profiles</strong><span>Global cleanup applies everywhere.</span></div>
          ) : profiles.map((profile) => (
            <div className="ls-profile-row" key={profile.id}>
              <span className="ls-app-monogram">{profile.label.slice(0, 1).toUpperCase()}</span>
              <div>
                <strong>{profile.label}</strong>
                <small>{profile.appId}</small>
              </div>
              <div className="ls-profile-flags">
                {profile.removeFillers && <span>Fillers</span>}
                {profile.spokenCommands && <span>Commands</span>}
                {profile.smartPunctuation && <span>Punctuation</span>}
              </div>
              <button type="button" className="ls-icon-button" disabled={profileBusy} aria-label={`Delete ${profile.label}`} onClick={() => void deleteProfile(profile.id)}>
                <TrashIcon />
              </button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ProfileForm({ onSubmit, busy }: { onSubmit(event: FormEvent<HTMLFormElement>): void; busy: boolean }) {
  return (
    <form className="ls-profile-form" onSubmit={onSubmit}>
      <label>
        <span>Profile name</span>
        <input name="label" placeholder="Slack" required maxLength={120} />
      </label>
      <label>
        <span>App identifier</span>
        <input name="appId" placeholder="com.tinyspeck.slackmacgap" required maxLength={300} />
      </label>
      <div className="ls-form-checks">
        <label><input type="checkbox" name="removeFillers" defaultChecked /> Remove fillers</label>
        <label><input type="checkbox" name="spokenCommands" defaultChecked /> Spoken commands</label>
        <label><input type="checkbox" name="smartPunctuation" defaultChecked /> Smart punctuation</label>
      </div>
      <button className="ls-primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
    </form>
  );
}

export function TransformsScreen() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [rules, setRules] = useState<DictionaryEntry[]>([]);
  const [phrase, setPhrase] = useState("");
  const [replacement, setReplacement] = useState("");
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(() => window.localScribe.dictionary.list().then(setRules), []);

  useEffect(() => {
    void window.localScribe.settings.get().then(setSettings).catch((error: unknown) => {
      setMessageIsError(true);
      setMessage(`Could not load transform settings: ${errorDetail(error)}`);
    });
    void loadRules().catch((error: unknown) => {
      setMessageIsError(true);
      setMessage(`Could not load replacement rules: ${errorDetail(error)}`);
    });
  }, [loadRules]);

  const setTransform = async (key: "smartPunctuation" | "spokenCommands", enabled: boolean) => {
    setBusy(true);
    try {
      const saved = await window.localScribe.settings.save({ ...settings, [key]: enabled });
      setSettings(saved);
      setMessageIsError(false);
      setMessage(enabled ? "Transform enabled" : "Transform disabled");
    } catch (error) {
      setMessageIsError(true);
      setMessage(`Could not update transform: ${errorDetail(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const addRule = async () => {
    const nextPhrase = phrase.trim();
    const nextReplacement = replacement.trim();
    if (!nextPhrase || !nextReplacement) return;
    setBusy(true);
    try {
      await window.localScribe.dictionary.save({ phrase: nextPhrase, replacement: nextReplacement });
      await loadRules();
      setPhrase("");
      setReplacement("");
      setMessageIsError(false);
      setMessage("Replacement saved and active");
    } catch (error) {
      setMessageIsError(true);
      setMessage(`Could not save replacement: ${errorDetail(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (id: string) => {
    setBusy(true);
    try {
      await window.localScribe.dictionary.delete(id);
      await loadRules();
      setMessageIsError(false);
      setMessage("Replacement removed");
    } catch (error) {
      setMessageIsError(true);
      setMessage(`Could not delete replacement: ${errorDetail(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const transforms = [
    {
      id: "polish",
      icon: <SparkIcon />,
      title: "Polish",
      description: "Normalize spacing, capitalization, and terminal punctuation after every transcription.",
      availability: settings.smartPunctuation ? "Enabled" : "Off",
      enabled: settings.smartPunctuation,
      toggle: () => setTransform("smartPunctuation", !settings.smartPunctuation),
    },
    {
      id: "structured",
      icon: <ListIcon />,
      title: "Spoken structure",
      description: "Apply spoken punctuation, new-line, new-paragraph, and scratch-that commands.",
      availability: settings.spokenCommands ? "Enabled" : "Off",
      enabled: settings.spokenCommands,
      toggle: () => setTransform("spokenCommands", !settings.spokenCommands),
    },
    {
      id: "concise",
      icon: <CompressIcon />,
      title: "Concise rewrite",
      description: "Shorten prose while preserving meaning. This requires a local text-generation model.",
      availability: GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
      enabled: false,
      toggle: null,
    },
  ];

  return (
    <div className="ls-page ls-transforms-screen">
      <ScreenHeader
        eyebrow="Deterministic tools"
        title="Transforms"
        description="Exact local transforms work now. Semantic rewrites are disabled until a separate text model is added."
      />
      <div className="ls-local-banner">
        <LockIcon />
        <div><strong>Current transforms run locally</strong><span>The installed ASR model handles speech. Generative rewriting needs an additional text model, which is not installed.</span></div>
      </div>

      <section className="ls-section">
        <div className="ls-transform-grid">
          {transforms.map((transform) => (
            <button
              type="button"
              key={transform.id}
              className={transform.enabled ? "ls-transform-card is-selected" : transform.toggle ? "ls-transform-card" : "ls-transform-card is-unavailable"}
              onClick={() => void transform.toggle?.()}
              aria-pressed={transform.toggle ? transform.enabled : undefined}
              disabled={!transform.toggle || busy}
            >
              <span className="ls-transform-icon">{transform.icon}</span>
              <span className={transform.toggle ? "ls-status-chip ls-status-chip--muted" : "ls-status-chip ls-status-chip--muted ls-status-chip--model-required"}>{transform.availability}</span>
              <strong>{transform.title}</strong>
              <p>{transform.description}</p>
              <span className="ls-card-link">{transform.toggle ? transform.enabled ? "Click to turn off" : "Click to enable" : GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE} <ArrowIcon /></span>
            </button>
          ))}
        </div>
      </section>

      <section className="ls-section ls-rule-editor" aria-labelledby="rules-heading">
        <div className="ls-section-heading">
          <div>
            <h2 id="rules-heading">Custom rules</h2>
            <p>Exact replacements saved locally and applied after every transcription.</p>
          </div>
          <span className="ls-status-chip">Active now</span>
        </div>
        <div className="ls-rule-pair">
          <label><span>When LocalScribe hears</span><input value={phrase} onChange={(event) => setPhrase(event.target.value)} placeholder="road map" maxLength={200} /></label>
          <ArrowIcon />
          <label><span>Replace it with</span><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="roadmap" maxLength={200} /></label>
          <button type="button" className="ls-primary-button" disabled={busy || !phrase.trim() || !replacement.trim()} onClick={() => void addRule()}>{busy ? "Saving…" : "Save rule"}</button>
        </div>
        {rules.length > 0 && (
          <div className="ls-draft-rules">
            {rules.map((rule) => (
              <div key={rule.id}><span><strong>{rule.phrase}</strong> → {rule.replacement}</span><button type="button" disabled={busy} aria-label={`Remove ${rule.phrase}`} onClick={() => void removeRule(rule.id)}><CloseIcon /></button></div>
            ))}
          </div>
        )}
        <p className="ls-honesty-note"><InfoIcon /> These exact replacements are shared with Dictionary and never leave this computer.</p>
        {message && (
          <p className={messageIsError ? "ls-action-feedback is-error" : "ls-action-feedback"} role={messageIsError ? "alert" : "status"} aria-live="polite">{message}</p>
        )}
      </section>
    </div>
  );
}

export function SettingsModal({ onClose }: { onClose(): void }) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelAction, setModelAction] = useState<ModelActionState>(null);
  const [modelFeedback, setModelFeedback] = useState<{ message: string; isError: boolean } | null>(null);

  const refresh = useCallback(async () => {
    const [permissionResult, diagnosticsResult, profileResult] = await Promise.all([
      window.localScribe.system.getPermissions(),
      window.localScribe.system.diagnostics(),
      window.localScribe.profiles.list(),
    ]);
    setPermissions(permissionResult);
    setDiagnostics(diagnosticsResult);
    setProfiles(profileResult);
  }, []);

  useEffect(() => {
    void window.localScribe.settings.get().then(setSettings).catch((error: unknown) => {
      setStatus(`Could not load settings: ${errorDetail(error)}`);
    });
    void refresh().catch((error: unknown) => {
      setStatus(`Could not refresh system information: ${errorDetail(error)}`);
    });
    void navigator.mediaDevices?.enumerateDevices().then((devices) => {
      setMicrophones(devices.filter((device) => device.kind === "audioinput"));
    }).catch((error: unknown) => {
      setStatus(`Could not list microphones: ${errorDetail(error)}`);
    });
    return window.localScribe.settings.onChanged(setSettings);
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    const refreshPermissions = () => {
      void window.localScribe.system.getPermissions().then((next) => {
        if (!disposed) setPermissions(next);
      }).catch(() => undefined);
    };
    const interval = window.setInterval(refreshPermissions, 1_000);
    window.addEventListener("focus", refreshPermissions);
    document.addEventListener("visibilitychange", refreshPermissions);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshPermissions);
      document.removeEventListener("visibilitychange", refreshPermissions);
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setStatus("");
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const validateShortcut = async (
    kind: ShortcutKind,
    shortcut: string,
    otherShortcut: string,
  ): Promise<ShortcutValidationOutcome> => {
    try {
      const result = await window.localScribe.shortcuts.validate({ kind, shortcut, otherShortcut });
      if (!result.available) {
        return {
          accepted: false,
          error: result.error ?? "That shortcut is already used by macOS or another app. Choose another combination.",
        };
      }
      return {
        accepted: true,
        shortcut: result.shortcut,
        warning: result.warning,
      };
    } catch (error) {
      return {
        accepted: false,
        error: `Could not check that shortcut: ${errorDetail(error)}`,
      };
    }
  };

  const save = async () => {
    setBusy(true);
    try {
      const saved = await window.localScribe.settings.save(settings);
      setSettings(saved);
      setStatus("Settings saved");
      if (saved.modelPerformanceMode !== diagnostics?.performance.preference) {
        try {
          const nextDiagnostics = await window.localScribe.system.diagnostics();
          setDiagnostics(nextDiagnostics);
          setModelFeedback({
            message: modelPerformanceSaveMessage(
              saved.modelPerformanceMode,
              nextDiagnostics.performance,
            ),
            isError: false,
          });
        } catch {
          setModelFeedback({
            message: "The performance mode was saved, but LocalScribe could not refresh its model status. Recheck memory to try again.",
            isError: true,
          });
        }
      }
    } catch (error) {
      setStatus(`Could not save settings: ${errorDetail(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const exportHistory = async () => {
    try {
      const path = await window.localScribe.history.export();
      setStatus(path ? `Exported to ${path}` : "Export cancelled");
    } catch (error) {
      setStatus(`Could not export history: ${errorDetail(error)}`);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm("Permanently delete all encrypted transcript history?")) return;
    try {
      await window.localScribe.history.clear();
      setStatus("Transcript history deleted");
    } catch (error) {
      setStatus(`Could not clear history: ${errorDetail(error)}`);
    }
  };

  const installModel = async (tier: ModelPerformanceTier, replaceExisting: boolean) => {
    const option = diagnostics?.performance.options.find((candidate) => candidate.tier === tier);
    if (!option) {
      setModelFeedback({ message: "Model details are not available yet. Recheck memory and try again.", isError: true });
      return;
    }
    const expectedSize = formatBytes(option.expectedDownloadBytes);
    const action = replaceExisting ? "repair" : "install";
    if (!window.confirm(
      `${replaceExisting ? "Repair" : "Install"} ${tierLabel(tier)} (${option.displayName})? `
      + `LocalScribe will download and verify ${expectedSize}.`,
    )) return;
    setModelAction({ action: replaceExisting ? "repairing" : "installing", tier });
    setModelFeedback({
      message: `${replaceExisting ? "Repairing" : "Installing"} ${tierLabel(tier)} and verifying ${expectedSize}…`,
      isError: false,
    });
    try {
      const nextDiagnostics = await window.localScribe.system.installModel({
        confirmed: true,
        replaceExisting,
        tier,
      });
      setDiagnostics(nextDiagnostics);
      setModelFeedback({
        message: `${tierLabel(tier)} model ${action === "repair" ? "repaired" : "installed"} and verified.`,
        isError: false,
      });
    } catch {
      setModelFeedback({
        message: `Could not ${action} the ${tierLabel(tier)} model. Check your connection and available storage, then try again.`,
        isError: true,
      });
    } finally {
      setModelAction(null);
    }
  };

  const removeModel = async (tier: ModelPerformanceTier) => {
    if (!window.confirm(`Remove the ${tierLabel(tier)} local speech model from this computer?`)) return;
    setModelAction({ action: "removing", tier });
    setModelFeedback({ message: `Removing the ${tierLabel(tier)} model…`, isError: false });
    try {
      const nextDiagnostics = await window.localScribe.system.removeModel({ confirmed: true, tier });
      setDiagnostics(nextDiagnostics);
      setModelFeedback({ message: `${tierLabel(tier)} model removed.`, isError: false });
    } catch {
      setModelFeedback({
        message: `Could not remove the ${tierLabel(tier)} model. Close any active dictation and try again.`,
        isError: true,
      });
    } finally {
      setModelAction(null);
    }
  };

  const refreshModelStatus = async () => {
    setModelFeedback({ message: "Rechecking platform memory and local models…", isError: false });
    try {
      await refresh();
      setModelFeedback({ message: "Platform memory and model status refreshed.", isError: false });
    } catch {
      setModelFeedback({
        message: "Could not refresh model information. Close and reopen Settings, then try again.",
        isError: true,
      });
    }
  };

  const refreshWithStatus = async () => {
    try {
      await refresh();
      setStatus("System information refreshed");
    } catch (error) {
      setStatus(`Could not refresh system information: ${errorDetail(error)}`);
    }
  };

  return (
    <div
      className="ls-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className="ls-settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <aside className="ls-settings-sidebar">
          <div className="ls-settings-brand"><span>L</span><strong>Settings</strong></div>
          <nav aria-label="Settings categories">
            {SETTINGS_TABS.map((item) => (
              <button type="button" key={item.id} className={tab === item.id ? "is-active" : ""} onClick={() => { setTab(item.id); setStatus(""); }}>
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </nav>
          <div className="ls-settings-local"><span /> Local only<small>No audio uploads</small></div>
        </aside>

        <div className="ls-settings-main">
          <header className="ls-settings-header">
            <div><span>LocalScribe</span><h1 id="settings-title">{SETTINGS_TABS.find((item) => item.id === tab)?.label}</h1></div>
            <button type="button" className="ls-close-button" onClick={onClose} aria-label="Close settings"><CloseIcon /></button>
          </header>

          <div className="ls-settings-scroll">
            {tab === "general" && (
              <>
                <SettingsGroup title="Dictation">
                  <ShortcutRecorder
                    kind="hold"
                    label="Push-to-talk shortcut"
                    detail="Hold this key while speaking, then release it to transcribe."
                    value={settings.holdShortcut}
                    onValidate={(shortcut) => validateShortcut("hold", shortcut, settings.toggleShortcut)}
                    onChange={(shortcut) => update("holdShortcut", shortcut as HoldShortcut)}
                  />
                  <ShortcutRecorder
                    kind="toggle"
                    label="Toggle dictation shortcut"
                    detail="Press once to start listening and once again to stop."
                    value={settings.toggleShortcut}
                    onValidate={(shortcut) => validateShortcut("toggle", shortcut, settings.holdShortcut)}
                    onChange={(shortcut) => update("toggleShortcut", shortcut as ToggleShortcut)}
                  />
                  <SettingsSelect
                    label="Microphone"
                    detail="The input used by the floating bar."
                    value={settings.microphoneId ?? ""}
                    onChange={(value) => update("microphoneId", value || null)}
                  >
                    <option value="">System default</option>
                    {microphones.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
                  </SettingsSelect>
                  <SettingsSelect label="Dictation language" detail="Auto-detect or bias speech recognition." value={settings.language} onChange={(value) => update("language", value)}>
                    <option value="auto">Auto-detect</option>
                    <option value="English">English</option>
                    <option value="Spanish">Spanish</option>
                    <option value="French">French</option>
                    <option value="German">German</option>
                    <option value="Hindi">Hindi</option>
                  </SettingsSelect>
                  <SettingsReadOnly label="App language" detail="The LocalScribe interface is currently available in English." value="English" />
                </SettingsGroup>
                <div className="ls-settings-note">
                  <InfoIcon />
                  <span>{shortcutHelpText(permissions, settings.holdShortcut)}</span>
                </div>
                <SettingsGroup title="Permissions">
                  <PermissionRow
                    label="Microphone"
                    detail="Required only while recording dictation."
                    ready={permissions?.microphone === "granted"}
                    value={permissions?.microphone ?? "Checking"}
                    onOpen={permissions?.microphoneSettingsAvailable
                      ? () => void window.localScribe.system.openPermission("microphone")
                      : undefined}
                  />
                  {permissions?.accessibility.supported && (
                    <PermissionRow
                      label="Accessibility"
                      detail="Required for automatic paste and global push-to-talk. Without it, use the toggle shortcut; completed dictation is copied to the clipboard."
                      ready={permissions.accessibility.granted}
                      value={permissions.accessibility.granted ? "Granted" : "Needs access"}
                      onOpen={() => void window.localScribe.system.openPermission("accessibility")}
                    />
                  )}
                  {permissions && !permissions.accessibility.supported && (
                    <SettingsReadOnly
                      label="Input access"
                      detail={permissions.platform === "win32"
                        ? "Windows does not use a separate Accessibility privacy setting for LocalScribe."
                        : "Automatic paste and global push-to-talk are not supported on this platform yet."}
                      value={permissions.platform === "win32" ? "No extra permission" : "Unavailable"}
                    />
                  )}
                </SettingsGroup>
              </>
            )}

            {tab === "system" && (
              <>
                <SettingsGroup title="App behavior">
                  <SettingsToggle label="Launch at login" detail="Make LocalScribe ready after you sign in." value={settings.launchAtLogin} onChange={(value) => update("launchAtLogin", value)} />
                  <SettingsToggle label="Show floating bar" detail="Keep the small bottom-center control visible while idle." value={settings.showPillWhenIdle} onChange={(value) => update("showPillWhenIdle", value)} />
                  {permissions && !permissions.automaticPaste.supported
                    ? <SettingsReadOnly label="Paste automatically" detail="Automatic paste is not supported on this platform. Completed dictation is copied to the clipboard." value="Unavailable" />
                    : <SettingsToggle label="Paste automatically" detail="Paste only when the app active at start is still the target; otherwise copy." value={settings.autoPaste} onChange={(value) => update("autoPaste", value)} />}
                  <SettingsToggle label="Save transcript history" detail="Text is encrypted locally. Raw audio is not retained." value={settings.keepHistory} onChange={(value) => update("keepHistory", value)} />
                  <SettingsSelect label="History retention" detail="Expired encrypted transcripts are deleted locally." value={String(settings.historyRetentionDays)} onChange={(value) => update("historyRetentionDays", Number(value) as AppSettings["historyRetentionDays"])}>
                    {HISTORY_RETENTION_OPTIONS.map((days) => <option key={days} value={days}>{historyRetentionLabel(days)}</option>)}
                  </SettingsSelect>
                </SettingsGroup>
              </>
            )}

            {tab === "model" && (
              <ModelPerformanceSettings
                mode={settings.modelPerformanceMode}
                resolvedTier={diagnostics?.performance.preference === settings.modelPerformanceMode
                  ? diagnostics.performance.resolvedTier
                  : null}
                fitsMemoryBudget={diagnostics?.performance.preference === settings.modelPerformanceMode
                  ? diagnostics.performance.fitsMemoryBudget
                  : null}
                resolutionReason={diagnostics?.performance.preference === settings.modelPerformanceMode
                  ? diagnostics.performance.resolutionReason
                  : "Save changes before LocalScribe resolves this performance mode."}
                hardware={diagnostics ? {
                  platform: modelRuntimePlatform(permissions?.platform, diagnostics.platform),
                  displayName: diagnostics.accelerator.displayName,
                  totalMemoryBytes: diagnostics.accelerator.totalMemoryBytes,
                  availableMemoryBytes: diagnostics.accelerator.freeMemoryBytes,
                  memoryBasis: diagnostics.accelerator.memoryBasis,
                } : null}
                tiers={diagnostics?.performance.options.map((option) => ({
                  tier: option.tier,
                  displayName: option.displayName,
                  backend: option.engine,
                  precision: option.precision,
                  downloadBytes: option.expectedDownloadBytes,
                  acceleratorMemory: {
                    minimumBytes: option.expectedMemoryMinBytes,
                    maximumBytes: option.expectedMemoryMaxBytes,
                    basis: option.memoryBasis,
                  },
                  qualityNote: option.qualityNote,
                  verificationStatus: option.verificationStatus,
                })) ?? []}
                action={modelAction}
                feedback={modelFeedback}
                onModeChange={(mode) => {
                  update("modelPerformanceMode", mode);
                  setModelFeedback({
                    message: `${tierLabel(mode)} selected. Save changes to apply this performance mode.`,
                    isError: false,
                  });
                }}
                onInstall={(tier) => void installModel(tier, false)}
                onRepair={(tier) => void installModel(tier, true)}
                onRemove={(tier) => void removeModel(tier)}
                onRefresh={() => void refreshModelStatus()}
              />
            )}

            {tab === "writing" && (
              <>
                <SettingsGroup title="Automatic cleanup">
                  <SettingsToggle label="Remove filler words" detail="Remove isolated hesitation words such as um and uh." value={settings.removeFillers} onChange={(value) => update("removeFillers", value)} />
                  <SettingsToggle label="Spoken commands" detail="Understand new paragraph, scratch that, comma, and supported commands." value={settings.spokenCommands} onChange={(value) => update("spokenCommands", value)} />
                  <SettingsToggle label="Smart punctuation" detail="Normalize spacing, capitalization, and terminal punctuation." value={settings.smartPunctuation} onChange={(value) => update("smartPunctuation", value)} />
                </SettingsGroup>
                <SettingsGroup title="App profiles">
                  {profiles.length === 0 ? <SettingsReadOnly label="No app profiles" detail="Global cleanup applies to every application." value="None" /> : profiles.map((profile) => (
                    <SettingsReadOnly key={profile.id} label={profile.label} detail={profile.appId} value={[profile.removeFillers && "Fillers", profile.spokenCommands && "Commands", profile.smartPunctuation && "Punctuation"].filter(Boolean).join(" · ") || "No cleanup"} />
                  ))}
                </SettingsGroup>
                <div className="ls-settings-note"><InfoIcon /><span>Dictionary, snippets, style references, and profile editing live in their corresponding sidebar pages.</span></div>
              </>
            )}

            {tab === "experimental" && (
              <>
                <div className="ls-experimental-banner"><FlaskIcon /><div><strong>Nothing here changes dictation yet</strong><p>These concepts are visible for roadmap clarity. They remain disabled until the behavior is implemented and tested locally.</p></div></div>
                <SettingsGroup title="Future behaviors">
                  <ModelRequiredToggle label="Free-form command mode" detail="Interpret an entire recording as a semantic app command." />
                  <UnavailableToggle label="Press Enter after command" detail="Submit a command after target-guarded insertion." />
                  <UnavailableToggle label="Stacked messages" detail="Queue several dictations before inserting them." />
                  <UnavailableToggle label="Bulk vocabulary import" detail="Validate and import a local vocabulary file." />
                </SettingsGroup>
              </>
            )}

            {tab === "privacy" && (
              <>
                <div className="ls-privacy-hero"><LockIcon /><div><span>Private by design</span><h2>Your voice stays on this computer.</h2><p>Audio is processed by the installed local model and removed after transcription. Transcripts, snippet expansions, and scratchpad text are encrypted with the operating system key store.</p></div></div>
                <SettingsGroup title="Storage and diagnostics">
                  <SettingsReadOnly label="Processing" detail="No listening server or transcription API." value={resolvedModelEngine(diagnostics)} />
                  <SettingsReadOnly label="Database" detail="Encrypted transcript and scratchpad storage." value={diagnostics?.databaseIntegrity ?? "Checking"} />
                  <SettingsReadOnly label="Data path" detail="Local application data with OS-encrypted private text fields." value={diagnostics?.dataPath ?? "Checking"} monospace />
                  <SettingsReadOnly label="Model revision" detail="Resolved local speech model" value={diagnostics?.model.revision.slice(0, 10) ?? "Checking"} monospace />
                </SettingsGroup>
                <div className="ls-data-actions">
                  <button type="button" onClick={() => void exportHistory()}><DownloadIcon /><span><strong>Export history</strong><small>Save a local copy of your transcripts.</small></span></button>
                  <button type="button" onClick={() => void clearHistory()} className="is-danger"><TrashIcon /><span><strong>Clear history</strong><small>Permanently delete encrypted transcripts.</small></span></button>
                  <button type="button" onClick={() => void refreshWithStatus()}><RefreshIcon /><span><strong>Refresh diagnostics</strong><small>Recheck permissions, storage, and model.</small></span></button>
                </div>
                <div className="ls-settings-note"><InfoIcon /><span>Automatic paste reads the active app identity and hashes limited focused-window metadata to confirm the dictation target. LocalScribe does not read field or document contents from other applications.</span></div>
              </>
            )}
          </div>

          <footer className="ls-settings-footer">
            <span className={status.startsWith("Could not") || status.startsWith("Model removed, but") ? "is-error" : ""} role="status" aria-live="polite">{status}</span>
            <button type="button" className="ls-secondary-button" onClick={onClose}>Cancel</button>
            <button type="button" className="ls-primary-button" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
          </footer>
        </div>
      </section>
    </div>
  );
}

function ScreenHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="ls-screen-header"><span>{eyebrow}</span><h1>{title}</h1><p>{description}</p></header>;
}

function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return <section className="ls-settings-group"><h2>{title}</h2><div>{children}</div></section>;
}

function SettingsToggle({ label, detail, value, onChange }: { label: string; detail: string; value: boolean; onChange(value: boolean): void }) {
  return (
    <label className="ls-settings-row">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <input className="ls-switch" type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function UnavailableToggle({ label, detail }: { label: string; detail: string }) {
  return (
    <label className="ls-settings-row is-disabled">
      <span><strong>{label}<em>{UNAVAILABLE_IN_THIS_BUILD_NOTICE}</em></strong><small>{detail}</small></span>
      <input className="ls-switch" type="checkbox" disabled checked={false} readOnly />
    </label>
  );
}

function ModelRequiredToggle({ label, detail }: { label: string; detail: string }) {
  return (
    <label className="ls-settings-row is-disabled">
      <span><strong>{label}<em>{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</em></strong><small>{detail}</small></span>
      <input className="ls-switch" type="checkbox" disabled checked={false} readOnly />
    </label>
  );
}

function SettingsSelect({ label, detail, value, onChange, children }: { label: string; detail: string; value: string; onChange(value: string): void; children: ReactNode }) {
  return (
    <label className="ls-settings-row">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
    </label>
  );
}

function SettingsReadOnly({ label, detail, value, monospace = false }: { label: string; detail: string; value: string; monospace?: boolean }) {
  return (
    <div className="ls-settings-row">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <span className={monospace ? "ls-readonly-value is-monospace" : "ls-readonly-value"}>{value}</span>
    </div>
  );
}

function PermissionRow({ label, detail, ready, value, onOpen }: { label: string; detail: string; ready: boolean; value: string; onOpen?: () => void }) {
  return (
    <div className="ls-settings-row">
      <span><strong>{label}</strong><small>{detail}</small></span>
      <span className={ready ? "ls-permission-state is-ready" : "ls-permission-state"}><i />{value}</span>
      {onOpen && <button type="button" className="ls-small-button" onClick={onOpen}>Open settings</button>}
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes <= 0) return "0 GB";
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function tierLabel(mode: AppSettings["modelPerformanceMode"]): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function modelRuntimePlatform(
  permissionPlatform: PermissionSnapshot["platform"] | undefined,
  diagnosticsPlatform: string,
): PermissionSnapshot["platform"] {
  if (permissionPlatform) return permissionPlatform;
  if (diagnosticsPlatform === "darwin" || diagnosticsPlatform === "win32" || diagnosticsPlatform === "linux") {
    return diagnosticsPlatform;
  }
  return "unsupported";
}

function resolvedModelEngine(diagnostics: Diagnostics | null): string {
  if (!diagnostics) return "Checking";
  return diagnostics.performance.options.find(
    (option) => option.tier === diagnostics.performance.resolvedTier,
  )?.engine ?? "Local worker";
}

function shortcutHelpText(permissions: PermissionSnapshot | null, holdShortcut: string): string {
  const label = shortcutDisplayLabel(holdShortcut);
  if (!permissions) return `Shortcut changes apply after saving. The current push-to-talk key is ${label}.`;
  if (permissions.globalHold.ready) {
    return `Shortcut changes apply after saving. Hold ${label} to dictate from any app.`;
  }
  if (permissions.platform === "darwin") {
    return `The current push-to-talk key is ${label}. Grant Accessibility to use it globally; until then, use the toggle shortcut and LocalScribe will copy completed dictation.`;
  }
  return `The current push-to-talk key is ${label}. Global push-to-talk is unavailable on this platform; the toggle shortcut still works.`;
}

function errorDetail(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Unknown local error";
}

type IconProps = { className?: string };
function Icon({ children, className = "" }: { children: ReactNode; className?: string }) { return <svg className={className} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>; }
function SlidersIcon(props: IconProps) { return <Icon {...props}><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></Icon>; }
function DesktopIcon(props: IconProps) { return <Icon {...props}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></Icon>; }
function PenIcon(props: IconProps) { return <Icon {...props}><path d="m4 20 4.2-1 10.5-10.5a2.1 2.1 0 0 0-3-3L5.2 16Z"/><path d="m14.5 6.5 3 3"/></Icon>; }
function FlaskIcon(props: IconProps) { return <Icon {...props}><path d="M9 3h6M10 3v6l-5.5 9.2A1.8 1.8 0 0 0 6 21h12a1.8 1.8 0 0 0 1.5-2.8L14 9V3"/><path d="M7 15h10"/></Icon>; }
function LockIcon(props: IconProps) { return <Icon {...props}><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></Icon>; }
function SparkIcon(props: IconProps) { return <Icon {...props}><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z"/><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7Z"/></Icon>; }
function TrashIcon(props: IconProps) { return <Icon {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></Icon>; }
function CompressIcon(props: IconProps) { return <Icon {...props}><path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5"/></Icon>; }
function ListIcon(props: IconProps) { return <Icon {...props}><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none"/></Icon>; }
function ArrowIcon(props: IconProps) { return <Icon {...props}><path d="M5 12h14M14 7l5 5-5 5"/></Icon>; }
function CloseIcon(props: IconProps) { return <Icon {...props}><path d="m6 6 12 12M18 6 6 18"/></Icon>; }
function InfoIcon(props: IconProps) { return <Icon {...props}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></Icon>; }
function DownloadIcon(props: IconProps) { return <Icon {...props}><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></Icon>; }
function RefreshIcon(props: IconProps) { return <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 8a7 7 0 0 1 11.7-1L20 12M4 12l2.2 5a7 7 0 0 0 11.7-1"/></Icon>; }
function GaugeIcon(props: IconProps) { return <Icon {...props}><path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/><path d="M5 18h14"/></Icon>; }
