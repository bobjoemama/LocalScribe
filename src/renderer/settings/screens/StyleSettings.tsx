import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  DEFAULT_SETTINGS,
  HISTORY_RETENTION_OPTIONS,
  historyRetentionLabel,
  type AppInfo,
  type AppProfile,
  type AppSettings,
  type AppSettingsPatch,
  type DictionaryEntry,
  type Diagnostics,
  type LaunchAtLoginStatus,
  type ModelCatalog,
  type ModelFamilyId,
  type ModelPerformanceTier,
  type PermissionSnapshot,
} from "../../../shared/contracts";
import { selectableMicrophones } from "../../../shared/microphones";
import { rendererSafeErrorMessage } from "../../../shared/rendererErrors";
import { shortcutDisplayLabel } from "../../../shared/shortcuts";
import {
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
  UNAVAILABLE_IN_THIS_BUILD_NOTICE,
} from "../../generativeTextAvailability";
import { ShortcutRecorder, type ShortcutValidationOutcome } from "../components/ShortcutRecorder";
import { decideSettingsDismissal } from "../dismissal";
import {
  DICTATION_LANGUAGE_DETAIL,
  dictationLanguageOptionsFor,
} from "../dictationLanguages";
import {
  ModelPerformanceSettings,
  type ModelActionState,
  type ModelSelectionDraft,
  type ModelTierRuntimeStatus,
} from "./ModelPerformanceSettings";
import "./style-settings.css";

type StyleTab = "personal" | "work" | "email" | "other" | "cleanup";
type SettingsTab = "general" | "system" | "model" | "writing" | "experimental" | "privacy";
type CleanupLevel = "none" | "light" | "medium";
export type CleanupSelection = CleanupLevel | "custom";
export {
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
  UNAVAILABLE_IN_THIS_BUILD_NOTICE,
} from "../../generativeTextAvailability";

export function appProfilePresentation(
  platform: AppInfo["platform"] | null,
): {
  detail: string;
  labelPlaceholder: string;
  appIdPlaceholder: string;
} {
  if (platform === "darwin") {
    return {
      detail: "Override cleanup for a macOS app bundle identifier.",
      labelPlaceholder: "TextEdit",
      appIdPlaceholder: "com.apple.TextEdit",
    };
  }
  if (platform === "win32") {
    return {
      detail: "Override cleanup for a Windows executable name.",
      labelPlaceholder: "Notepad",
      appIdPlaceholder: "notepad.exe",
    };
  }
  return {
    detail: "Override cleanup for an application identifier reported by this platform.",
    labelPlaceholder: "App name",
    appIdPlaceholder: "Application identifier",
  };
}

export function profileCleanupDefaults(
  settings: AppSettings | null,
): Pick<AppSettings, "removeFillers" | "spokenCommands" | "smartPunctuation"> {
  const source = settings ?? DEFAULT_SETTINGS;
  return {
    removeFillers: source.removeFillers,
    spokenCommands: source.spokenCommands,
    smartPunctuation: source.smartPunctuation,
  };
}

export function settingsLoadPresentation(
  settings: AppSettings | null,
  error: unknown | null,
): { title: string; detail: string; isError: boolean } | null {
  if (settings) return null;
  if (error) {
    return {
      title: "Settings unavailable",
      detail: `Could not load saved settings: ${errorDetail(error)}`,
      isError: true,
    };
  }
  return {
    title: "Loading settings",
    detail: "Your saved settings are loading. Controls will be available when that finishes.",
    isError: false,
  };
}

export function settingsControlAvailability(
  settings: AppSettings | null,
  error: unknown | null,
): { enabled: boolean; presentation: ReturnType<typeof settingsLoadPresentation> } {
  return {
    enabled: settings !== null,
    presentation: settingsLoadPresentation(settings, error),
  };
}

export function settingsWithPendingDraft(
  persisted: AppSettings,
  pending: AppSettingsPatch,
): AppSettings {
  return { ...persisted, ...pending };
}

export function settingsPatchWithoutModelSelection(patch: AppSettingsPatch): AppSettingsPatch {
  const {
    modelPerformanceMode: _modelPerformanceMode,
    activeModelFamilyId: _activeModelFamilyId,
    modelLibraryFamilyIds: _modelLibraryFamilyIds,
    ...safePatch
  } = patch as AppSettingsPatch & Partial<Pick<
    AppSettings,
    "modelPerformanceMode" | "activeModelFamilyId" | "modelLibraryFamilyIds"
  >>;
  return safePatch;
}

/**
 * Keep edits made while an earlier save request was in flight. Only fields
 * that still equal the submitted snapshot have been acknowledged.
 */
export function pendingSettingsAfterSave(
  current: AppSettingsPatch,
  submitted: AppSettingsPatch,
): AppSettingsPatch {
  const pending = { ...current };
  for (const key of Object.keys(submitted) as Array<keyof AppSettingsPatch>) {
    const currentValue = current[key];
    const submittedValue = submitted[key];
    const unchanged = Array.isArray(currentValue) && Array.isArray(submittedValue)
      ? currentValue.length === submittedValue.length
        && currentValue.every((value, index) => value === submittedValue[index])
      : Object.is(currentValue, submittedValue);
    if (unchanged) delete pending[key];
  }
  return pending;
}

export function selectedMicrophoneIsUnavailable(
  selectedMicrophoneId: string | null,
  microphones: ReadonlyArray<Pick<MediaDeviceInfo, "deviceId">>,
): boolean {
  return Boolean(
    selectedMicrophoneId
    && !microphones.some((microphone) => microphone.deviceId === selectedMicrophoneId),
  );
}

export function automaticPasteSettingsPresentation(
  permissions: PermissionSnapshot | null,
): { editable: boolean; detail: string; value: string | null } {
  if (!permissions) {
    return {
      editable: false,
      detail: "Checking whether automatic paste is available. Completed dictation will still be copied.",
      value: "Checking",
    };
  }
  if (!permissions.automaticPaste.supported) {
    return {
      editable: false,
      detail: "Automatic paste is not supported on this platform. Completed dictation is copied to the clipboard.",
      value: "Unavailable",
    };
  }
  if (permissions.platform === "win32" && !permissions.automaticPaste.ready) {
    return {
      editable: false,
      detail: "The local Windows paste helper is unavailable. Completed dictation will be copied until the helper is available.",
      value: "Copy only",
    };
  }
  /*
   * macOS derives readiness from Accessibility, and this branch was gated on
   * win32, so a Mac without Accessibility fell through to a switch the user
   * could turn on above a sentence promising it would paste. Main has always
   * taken the copy path in that state and says so on the pill ("Copied — allow
   * Accessibility"); the setting was the one surface still claiming otherwise.
   *
   * The switch stays editable, unlike the Windows case: Accessibility is a
   * permission the user can grant from the Privacy tab, and the preference
   * takes effect the moment they do. Only the promise is corrected.
   */
  if (!permissions.automaticPaste.ready) {
    return {
      editable: true,
      detail: "Accessibility is not granted, so completed dictation is copied instead. Grant it under Privacy and this starts pasting.",
      value: null,
    };
  }
  return {
    editable: true,
    detail: "Paste only when the app active at start is still the target; otherwise copy.",
    value: null,
  };
}

export function launchAtLoginSettingsPresentation(
  savedValue: boolean,
  status: LaunchAtLoginStatus | null,
  pendingRequest = false,
): { editable: boolean; value: boolean; detail: string } {
  if (pendingRequest) {
    return {
      editable: true,
      value: savedValue,
      detail: "Save changes to apply this login startup setting to the operating system.",
    };
  }
  if (!status) {
    return {
      editable: true,
      value: savedValue,
      detail: "Checking the operating system's login startup state.",
    };
  }
  if (!status.supported) {
    return {
      editable: false,
      value: false,
      detail: "Launch at login is not supported on this platform.",
    };
  }
  if (status.effective) {
    return {
      editable: true,
      value: true,
      detail: savedValue
        ? "Enabled and confirmed by the operating system."
        : "The operating system still reports a login item. Turn this off and save to remove it.",
    };
  }
  if (status.requiresApproval) {
    return {
      editable: true,
      value: false,
      detail: "Saved as on, but macOS requires approval in System Settings. Turn this on and save to request registration again.",
    };
  }
  if (savedValue && status.registered) {
    return {
      editable: true,
      value: false,
      detail: "Saved as on, but disabled in the operating system's startup settings. Turn this on and save to register it again.",
    };
  }
  if (savedValue) {
    return {
      editable: true,
      value: false,
      detail: "Saved as on, but no effective login item was found. Turn this on and save to register it again.",
    };
  }
  return {
    editable: true,
    value: false,
    detail: "Disabled and confirmed by the operating system.",
  };
}

export function shortcutCommitErrorMessage(): string {
  return "Could not apply that shortcut. Choose another key combination or try again.";
}

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
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState<unknown | null>(null);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [profileMessage, setProfileMessage] = useState("");
  const [profileMessageIsError, setProfileMessageIsError] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [appPlatform, setAppPlatform] = useState<AppInfo["platform"] | null>(null);
  const cleanupDraft = useRef<AppSettingsPatch>({});

  const loadProfiles = useCallback(() => window.localScribe.profiles.list().then(setProfiles), []);

  useEffect(() => {
    const applySettings = (next: AppSettings) => {
      setSettings(settingsWithPendingDraft(next, cleanupDraft.current));
      setSettingsLoadError(null);
    };
    void window.localScribe.settings.get().then(applySettings).catch((error: unknown) => {
      setSettingsLoadError(error);
    });
    void loadProfiles().catch((error: unknown) => {
      setProfileMessageIsError(true);
      setProfileMessage(`Could not load app profiles: ${errorDetail(error)}`);
    });
    void window.localScribe.system.appInfo()
      .then((info) => setAppPlatform(info.platform))
      .catch(() => setAppPlatform(null));
    return window.localScribe.settings.onChanged(applySettings);
  }, [loadProfiles]);

  const cleanupLevel = useMemo<CleanupSelection | null>(
    () => settings ? cleanupSelectionForSettings(settings) : null,
    [settings],
  );
  const cleanupControls = settingsControlAvailability(settings, settingsLoadError);
  const profilePresentation = appProfilePresentation(appPlatform);

  const chooseCleanup = (level: CleanupLevel) => {
    if (!settings) return;
    const next: AppSettings = {
      ...settings,
      removeFillers: level === "medium",
      spokenCommands: level !== "none",
      smartPunctuation: level !== "none",
    };
    cleanupDraft.current = {
      removeFillers: next.removeFillers,
      spokenCommands: next.spokenCommands,
      smartPunctuation: next.smartPunctuation,
    };
    setSettings(next);
    setMessage("");
    setMessageIsError(false);
  };

  const saveCleanup = async () => {
    if (!settings) return;
    const patch: AppSettingsPatch = {
      removeFillers: settings.removeFillers,
      spokenCommands: settings.spokenCommands,
      smartPunctuation: settings.smartPunctuation,
    };
    try {
      const saved = await window.localScribe.settings.patch(patch);
      const remaining = pendingSettingsAfterSave(cleanupDraft.current, patch);
      cleanupDraft.current = remaining;
      setSettings(settingsWithPendingDraft(saved, remaining));
      setMessageIsError(false);
      setMessage(Object.keys(remaining).length > 0
        ? "Saved the submitted cleanup. Newer changes still need to be saved."
        : "Cleanup saved");
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

      {cleanupControls.presentation && (
        <p className={cleanupControls.presentation.isError ? "ls-action-feedback is-error" : "ls-action-feedback"} role={cleanupControls.presentation.isError ? "alert" : "status"} aria-live="polite">
          <strong>{cleanupControls.presentation.title}</strong><br />{cleanupControls.presentation.detail}
        </p>
      )}

      {tab !== "cleanup" ? (
        <section className="ls-section" aria-labelledby="tone-heading">
          <div className="ls-section-heading">
            <div>
              <h2 id="tone-heading">How should it sound?</h2>
              <p>These are local preview references. Speech transcription and tone rewriting use different model capabilities.</p>
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
                aria-pressed={cleanupControls.enabled ? cleanupLevel === option.id : undefined}
                disabled={!cleanupControls.enabled}
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
          <button type="button" className="ls-primary-button" disabled={!cleanupControls.enabled} onClick={() => void saveCleanup()}>Save cleanup</button>
        </section>
      )}

      <section className="ls-section ls-profiles-section" aria-labelledby="profiles-heading">
        <div className="ls-section-heading">
          <div>
            <h2 id="profiles-heading">App profiles</h2>
            <p>{profilePresentation.detail}</p>
          </div>
          <button type="button" className="ls-secondary-button" onClick={() => setProfileOpen((open) => !open)}>
            {profileOpen ? "Cancel" : "+ Add profile"}
          </button>
        </div>

        {profileOpen && (
          <ProfileForm
            onSubmit={saveProfile}
            busy={profileBusy}
            labelPlaceholder={profilePresentation.labelPlaceholder}
            appIdPlaceholder={profilePresentation.appIdPlaceholder}
            cleanupDefaults={profileCleanupDefaults(settings)}
          />
        )}
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

function ProfileForm({
  onSubmit,
  busy,
  labelPlaceholder,
  appIdPlaceholder,
  cleanupDefaults,
}: {
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  busy: boolean;
  labelPlaceholder: string;
  appIdPlaceholder: string;
  cleanupDefaults: Pick<AppSettings, "removeFillers" | "spokenCommands" | "smartPunctuation">;
}) {
  return (
    <form className="ls-profile-form" onSubmit={onSubmit}>
      <label>
        <span>Profile name</span>
        <input name="label" placeholder={labelPlaceholder} required maxLength={120} />
      </label>
      <label>
        <span>App identifier</span>
        <input name="appId" placeholder={appIdPlaceholder} required maxLength={300} />
      </label>
      <div className="ls-form-checks">
        <label><input type="checkbox" name="removeFillers" defaultChecked={cleanupDefaults.removeFillers} /> Remove fillers</label>
        <label><input type="checkbox" name="spokenCommands" defaultChecked={cleanupDefaults.spokenCommands} /> Spoken commands</label>
        <label><input type="checkbox" name="smartPunctuation" defaultChecked={cleanupDefaults.smartPunctuation} /> Smart punctuation</label>
      </div>
      <button className="ls-primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
    </form>
  );
}

export function TransformsScreen() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState<unknown | null>(null);
  const [rules, setRules] = useState<DictionaryEntry[]>([]);
  const [phrase, setPhrase] = useState("");
  const [replacement, setReplacement] = useState("");
  const [message, setMessage] = useState("");
  const [messageIsError, setMessageIsError] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(() => window.localScribe.dictionary.list().then(setRules), []);

  useEffect(() => {
    const applySettings = (next: AppSettings) => {
      setSettings(next);
      setSettingsLoadError(null);
    };
    void window.localScribe.settings.get().then(applySettings).catch((error: unknown) => {
      setSettingsLoadError(error);
    });
    void loadRules().catch((error: unknown) => {
      setMessageIsError(true);
      setMessage(`Could not load replacement rules: ${errorDetail(error)}`);
    });
    return window.localScribe.settings.onChanged(applySettings);
  }, [loadRules]);

  const transformControls = settingsControlAvailability(settings, settingsLoadError);

  const setTransform = async (key: "smartPunctuation" | "spokenCommands", enabled: boolean) => {
    if (!settings) return;
    setBusy(true);
    try {
      const saved = await window.localScribe.settings.patch({ [key]: enabled });
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
      availability: settings ? settings.smartPunctuation ? "Enabled" : "Off" : transformControls.presentation?.title ?? "Loading settings",
      enabled: settings?.smartPunctuation ?? false,
      toggle: settings ? () => setTransform("smartPunctuation", !settings.smartPunctuation) : null,
      unavailable: !settings,
    },
    {
      id: "structured",
      icon: <ListIcon />,
      title: "Spoken structure",
      description: "Apply spoken punctuation, new-line, new-paragraph, and scratch-that commands.",
      availability: settings ? settings.spokenCommands ? "Enabled" : "Off" : transformControls.presentation?.title ?? "Loading settings",
      enabled: settings?.spokenCommands ?? false,
      toggle: settings ? () => setTransform("spokenCommands", !settings.spokenCommands) : null,
      unavailable: !settings,
    },
    {
      id: "concise",
      icon: <CompressIcon />,
      title: "Concise rewrite",
      description: "Shorten prose while preserving meaning. This requires a local text-generation model.",
      availability: GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
      enabled: false,
      toggle: null,
      unavailable: true,
    },
  ];

  return (
    <div className="ls-page ls-transforms-screen">
      <ScreenHeader
        eyebrow="Deterministic tools"
        title="Transforms"
        description="Exact local transforms work now. Semantic rewriting is unavailable in this build."
      />
      <div className="ls-local-banner">
        <LockIcon />
        <div><strong>Current transforms run locally</strong><span>Speech uses the selected local ASR profile when its model data is verified. Generative rewriting is unavailable in this build.</span></div>
      </div>

      {transformControls.presentation && (
        <p className={transformControls.presentation.isError ? "ls-action-feedback is-error" : "ls-action-feedback"} role={transformControls.presentation.isError ? "alert" : "status"} aria-live="polite">
          <strong>{transformControls.presentation.title}</strong><br />{transformControls.presentation.detail}
        </p>
      )}

      <section className="ls-section">
        <div className="ls-transform-grid">
          {transforms.map((transform) => (
            <button
              type="button"
              key={transform.id}
              className={transform.enabled ? "ls-transform-card is-selected" : transform.unavailable ? "ls-transform-card is-unavailable" : "ls-transform-card"}
              onClick={() => void transform.toggle?.()}
              aria-pressed={transform.toggle ? transform.enabled : undefined}
              disabled={!transform.toggle || busy}
            >
              <span className="ls-transform-icon">{transform.icon}</span>
              <span className={transform.id === "concise" ? "ls-status-chip ls-status-chip--muted ls-status-chip--model-required" : "ls-status-chip ls-status-chip--muted"}>{transform.availability}</span>
              <strong>{transform.title}</strong>
              <p>{transform.description}</p>
              <span className="ls-card-link">{transform.toggle ? transform.enabled ? "Click to turn off" : "Click to enable" : transform.id === "concise" ? GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE : "Available when saved settings load"} <ArrowIcon /></span>
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

export function SettingsModal({ onClose, registerDismissalGate }: {
  onClose(): void;
  /**
   * Publishes the dialog's own dismissal gate so the hub can consult it before
   * unmounting the dialog on a navigation request. Called with `null` on
   * unmount.
   */
  registerDismissalGate?(gate: (() => boolean) | null): void;
}) {
  const [tab, setTab] = useState<SettingsTab>("general");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsLoadError, setSettingsLoadError] = useState<unknown | null>(null);
  const [permissions, setPermissions] = useState<PermissionSnapshot | null>(null);
  const [launchAtLoginStatus, setLaunchAtLoginStatus] = useState<LaunchAtLoginStatus | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ModelCatalog | null>(null);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [profiles, setProfiles] = useState<AppProfile[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const dirtySettings = useRef<AppSettingsPatch>({});
  const [modelAction, setModelAction] = useState<ModelActionState>(null);
  const [pendingModelSelection, setPendingModelSelection] = useState<ModelSelectionDraft | null>(null);
  const [modelApplying, setModelApplying] = useState(false);
  const modelApplyInFlight = useRef(false);
  /*
   * `modelAction` disables the library buttons, but only after React commits
   * the render that carries it. Two dispatches in the same tick — a double
   * click, or a click plus a keyboard activation — both still see a null
   * action, so both run, and whichever finishes first clears `modelAction`
   * and re-enables every button while the other is still downloading. This
   * ref closes that window the way `applyModelSelection` already does.
   */
  const modelLibraryActionInFlight = useRef(false);
  const [modelFeedback, setModelFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const shortcutPlatform = permissions?.platform === "darwin"
    || permissions?.platform === "win32"
    || permissions?.platform === "linux"
    ? permissions.platform
    : null;
  const dialogRef = useRef<HTMLElement>(null);
  /*
   * The dialog declares aria-modal="true", which tells assistive technology the
   * hub behind it is inert — but nothing made that true for the keyboard.
   * Focus stayed wherever it was (the hub's Settings button, or `document.body`
   * on a menu-driven open), so a keyboard user opened a modal and remained
   * outside it. Move focus in on open and hand it back on close; SettingsApp
   * marks the hub itself `inert` for the duration.
   */
  useEffect(() => {
    const opener = document.activeElement;
    dialogRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  /*
   * Returns whether the dialog actually closed, so `SettingsApp` can leave the
   * hub where it is when a navigation request is refused. A refusal is
   * announced on two surfaces because the footer suppresses `status` on the
   * model tab and `modelFeedback` only renders on it — between them every tab
   * is covered.
   */
  const attemptDismissal = useCallback((): boolean => {
    const decision = decideSettingsDismissal({
      applyInFlight: modelApplyInFlight.current,
      libraryActionInFlight: modelLibraryActionInFlight.current,
    });
    if (!decision.dismiss) {
      setStatus(decision.message);
      setModelFeedback({ message: decision.message, isError: false });
      return false;
    }
    setPendingModelSelection(null);
    onClose();
    return true;
  }, [onClose]);

  const closeSettings = useCallback(() => {
    attemptDismissal();
  }, [attemptDismissal]);

  useEffect(() => {
    registerDismissalGate?.(attemptDismissal);
    return () => registerDismissalGate?.(null);
  }, [registerDismissalGate, attemptDismissal]);

  const refresh = useCallback(async () => {
    const [permissionResult, launchAtLoginResult, diagnosticsResult, profileResult] = await Promise.allSettled([
      window.localScribe.system.getPermissions(),
      window.localScribe.system.getLaunchAtLoginStatus(),
      window.localScribe.system.diagnostics(),
      window.localScribe.profiles.list(),
    ]);
    setPermissions(permissionResult.status === "fulfilled" ? permissionResult.value : null);
    setLaunchAtLoginStatus(
      launchAtLoginResult.status === "fulfilled" ? launchAtLoginResult.value : null,
    );
    setDiagnostics(diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null);
    setProfiles(profileResult.status === "fulfilled" ? profileResult.value : []);
    const failures = [permissionResult, launchAtLoginResult, diagnosticsResult, profileResult]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => errorDetail(result.reason));
    if (failures.length > 0) throw new Error(failures.join("; "));
  }, []);

  const refreshModelCatalog = useCallback(async () => {
    try {
      const next = await window.localScribe.system.modelCatalog();
      setModelCatalog(next);
      setModelCatalogError(null);
      return next;
    } catch (error) {
      const detail = errorDetail(error);
      setModelCatalog(null);
      setModelCatalogError(detail);
      throw error;
    }
  }, []);

  const applyPersistedSettings = useCallback((next: AppSettings) => {
    // Keep only local edits pending for a field-level patch. A shortcut that
    // just committed in another surface otherwise must replace this stale copy.
    dirtySettings.current = settingsPatchWithoutModelSelection(dirtySettings.current);
    setSettings(settingsWithPendingDraft(next, dirtySettings.current));
    setSettingsLoadError(null);
  }, []);

  const refreshMicrophones = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
      setMicrophones([]);
      return;
    }
    try {
      /*
       * Must be the same filter the pill applies. Listing raw audioinput
       * devices offered "Default", whose id the pill rejects, so selecting it
       * made the pill report the working microphone as unavailable.
       */
      setMicrophones(selectableMicrophones(await mediaDevices.enumerateDevices()));
    } catch (error) {
      setMicrophones([]);
      throw error;
    }
  }, []);

  useEffect(() => {
    void window.localScribe.settings.get().then(applyPersistedSettings).catch((error: unknown) => {
      setSettingsLoadError(error);
    });
    void refresh().catch((error: unknown) => {
      setStatus(`Could not refresh system information: ${errorDetail(error)}`);
    });
    void refreshModelCatalog().catch(() => undefined);
    void refreshMicrophones().catch((error: unknown) => {
      setStatus(`Could not list microphones: ${errorDetail(error)}`);
    });
    return window.localScribe.settings.onChanged(applyPersistedSettings);
  }, [applyPersistedSettings, refresh, refreshMicrophones, refreshModelCatalog]);

  useEffect(() => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const handleDeviceChange = () => {
      void refreshMicrophones().catch((error: unknown) => {
        setStatus(`Could not refresh microphones: ${errorDetail(error)}`);
      });
    };
    mediaDevices.addEventListener("devicechange", handleDeviceChange);
    window.addEventListener("focus", handleDeviceChange);
    return () => {
      mediaDevices.removeEventListener("devicechange", handleDeviceChange);
      window.removeEventListener("focus", handleDeviceChange);
    };
  }, [refreshMicrophones]);

  useEffect(() => {
    let disposed = false;
    const refreshPermissions = () => {
      void window.localScribe.system.getPermissions().then((next) => {
        if (!disposed) setPermissions(next);
      }).catch(() => {
        if (!disposed) setPermissions(null);
      });
    };
    const refreshLaunchAtLogin = () => {
      void window.localScribe.system.getLaunchAtLoginStatus().then((next) => {
        if (!disposed) setLaunchAtLoginStatus(next);
      }).catch(() => {
        if (!disposed) setLaunchAtLoginStatus(null);
      });
    };
    const refreshForegroundState = () => {
      refreshPermissions();
      refreshLaunchAtLogin();
    };
    const refreshVisibleState = () => {
      if (document.visibilityState === "visible") refreshForegroundState();
    };
    /*
     * The poll spawns a native helper process on every tick, so it must stop
     * when nobody can see the result. Closing the Settings window only hides
     * it — the renderer stays alive and this effect never unmounts — and
     * `backgroundThrottling: false` pins `document.visibilityState` to
     * "visible" and keeps intervals at full rate, so the Page Visibility API
     * cannot be used as the gate. Main pushes the real native visibility.
     */
    let interval: number | null = null;
    const stopPolling = () => {
      if (interval === null) return;
      window.clearInterval(interval);
      interval = null;
    };
    const startPolling = () => {
      if (interval === null) interval = window.setInterval(refreshPermissions, 1_000);
    };
    startPolling();
    const unsubscribeVisibility = window.localScribe.windows.onVisibilityChanged((visible) => {
      if (disposed) return;
      if (!visible) {
        stopPolling();
        return;
      }
      // Permissions can only have been changed in System Settings while the
      // window was away, so refresh immediately rather than waiting a tick.
      refreshForegroundState();
      startPolling();
    });
    window.addEventListener("focus", refreshForegroundState);
    document.addEventListener("visibilitychange", refreshVisibleState);
    return () => {
      disposed = true;
      stopPolling();
      unsubscribeVisibility();
      window.removeEventListener("focus", refreshForegroundState);
      document.removeEventListener("visibilitychange", refreshVisibleState);
    };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeSettings]);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    if (!settings) return;
    setStatus("");
    dirtySettings.current = { ...dirtySettings.current, [key]: value };
    setSettings((current) => current ? { ...current, [key]: value } as AppSettings : current);
  };

  const commitShortcut = async (
    kind: "hold" | "toggle",
    shortcut: string,
  ): Promise<ShortcutValidationOutcome> => {
    if (!settings) {
      return {
        accepted: false,
        error: settingsLoadError
          ? "Settings are unavailable. Reopen Settings and try again."
          : "Settings are still loading. Try again when they are ready.",
      };
    }
    try {
      const saved = await window.localScribe.shortcuts.update({ kind, shortcut });
      const field = kind === "hold" ? "holdShortcut" : "toggleShortcut";
      delete dirtySettings.current[field];
      setSettings(settingsWithPendingDraft(saved, dirtySettings.current));
      setStatus("Shortcut applied");
      return {
        accepted: true,
        shortcut: saved[field],
      };
    } catch {
      return {
        accepted: false,
        error: shortcutCommitErrorMessage(),
      };
    }
  };

  const save = async () => {
    if (!settings) return;
    const patch = settingsPatchWithoutModelSelection(dirtySettings.current);
    dirtySettings.current = patch;
    if (Object.keys(patch).length === 0) {
      setStatus("No settings changes to save");
      return;
    }
    setBusy(true);
    try {
      const saved = await window.localScribe.settings.patch(patch);
      const remaining = pendingSettingsAfterSave(dirtySettings.current, patch);
      dirtySettings.current = remaining;
      setSettings(settingsWithPendingDraft(saved, remaining));
      setStatus(Object.keys(remaining).length > 0
        ? "Saved the submitted settings. Newer changes still need to be saved."
        : "Settings saved");
      if (patch.launchAtLogin !== undefined) {
        try {
          setLaunchAtLoginStatus(await window.localScribe.system.getLaunchAtLoginStatus());
        } catch {
          setLaunchAtLoginStatus(null);
          setStatus("Settings saved, but LocalScribe could not confirm the operating system's login startup state.");
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

  /*
   * The packaged app writes stdout and stderr to /dev/null, so when a dictation
   * fails there is nothing in the app, in Console.app, or in `log show` for a
   * user to send. This is the only way that trail leaves the machine.
   *
   * Nothing is redacted here on purpose: `diagnosticsLog()` returns content the
   * recorder has already re-checked against the redaction rules on the way out,
   * and withholds the file entirely if it fails. Filtering again in the
   * renderer would create a second, weaker rule that could silently disagree
   * with the real one.
   */
  const copyDiagnostics = async () => {
    let trail: string;
    try {
      trail = await window.localScribe.system.diagnosticsLog();
    } catch (error) {
      setStatus(`Could not read the diagnostics log: ${errorDetail(error)}`);
      return;
    }
    if (trail.trim().length === 0) {
      // Distinct from a failure: nothing has gone wrong yet, so there is
      // nothing to send, and saying "copied" would produce an empty paste.
      setStatus("No diagnostics have been recorded yet");
      return;
    }
    try {
      await navigator.clipboard.writeText(trail);
      setStatus(DIAGNOSTICS_COPIED_STATUS);
    } catch (error) {
      setStatus(`Could not copy the diagnostics log: ${errorDetail(error)}`);
    }
  };

  const installModel = async (
    familyId: ModelFamilyId,
    tier: ModelPerformanceTier,
    replaceExisting: boolean,
  ) => {
    if (modelLibraryActionInFlight.current) return;
    const model = catalogModelProfile(modelCatalog, familyId, tier);
    if (!model) {
      setModelFeedback({ message: "Curated model details are not available yet. Refresh model status and try again.", isError: true });
      return;
    }
    const expectedSize = formatBytes(model.artifact.expectedDownloadBytes);
    const action = replaceExisting ? "repair" : "install";
    const scope = modelArtifactScopePresentation(modelCatalog, familyId, tier);
    if (!window.confirm(
      `${replaceExisting ? "Repair" : "Download"} ${scope.confirmationTarget}? `
      + `LocalScribe will use its fixed local runtime to download and verify ${expectedSize} of curated model data.`,
    )) return;
    modelLibraryActionInFlight.current = true;
    setModelAction({ action: replaceExisting ? "repairing" : "installing", familyId, tier });
    setModelFeedback({
      message: `${replaceExisting ? "Repairing" : "Downloading"} ${scope.progressTarget} and verifying ${expectedSize}…`,
      isError: false,
    });
    try {
      const nextDiagnostics = await window.localScribe.system.installModel({
        ...modelInstallRequest(familyId, tier, replaceExisting),
      });
      setDiagnostics(nextDiagnostics);
      try {
        await refreshModelCatalog();
        setModelFeedback({
          message: `${scope.successTarget} ${action === "repair" ? "repaired" : "downloaded"} and verified.`,
          isError: false,
        });
      } catch (error) {
        setModelFeedback({
          message: `${scope.successTarget} was ${action === "repair" ? "repaired" : "downloaded"}, but LocalScribe could not refresh its displayed verification status: ${errorDetail(error)}`,
          isError: true,
        });
      }
    } catch (error) {
      setModelFeedback({
        message: modelActionFailureMessage(action, error, diagnostics),
        isError: true,
      });
    } finally {
      modelLibraryActionInFlight.current = false;
      setModelAction(null);
    }
  };

  const removeModel = async (familyId: ModelFamilyId, tier: ModelPerformanceTier) => {
    if (modelLibraryActionInFlight.current) return;
    const model = catalogModelProfile(modelCatalog, familyId, tier);
    if (!model) {
      setModelFeedback({ message: "Curated model details are not available yet. Refresh model status and try again.", isError: true });
      return;
    }
    const scope = modelArtifactScopePresentation(modelCatalog, familyId, tier);
    if (!window.confirm(`Remove ${scope.removalTarget} from this computer?`)) return;
    modelLibraryActionInFlight.current = true;
    setModelAction({ action: "removing", familyId, tier });
    setModelFeedback({ message: `Removing ${scope.progressTarget}…`, isError: false });
    try {
      const nextDiagnostics = await window.localScribe.system.removeModel(modelRemoveRequest(familyId, tier));
      setDiagnostics(nextDiagnostics);
      try {
        await refreshModelCatalog();
        setModelFeedback({ message: `${scope.successTarget} removed.`, isError: false });
      } catch (error) {
        setModelFeedback({
          message: `${scope.successTarget} was removed, but LocalScribe could not refresh its displayed verification status: ${errorDetail(error)}`,
          isError: true,
        });
      }
    } catch (error) {
      setModelFeedback({
        message: `Could not remove ${scope.removalTarget}: ${errorDetail(error)}`,
        isError: true,
      });
    } finally {
      modelLibraryActionInFlight.current = false;
      setModelAction(null);
    }
  };

  const refreshModelStatus = async () => {
    setModelFeedback({ message: "Rechecking platform memory and local models…", isError: false });
    const [systemResult, catalogResult] = await Promise.allSettled([refresh(), refreshModelCatalog()]);
    if (systemResult.status === "fulfilled" && catalogResult.status === "fulfilled") {
      setModelFeedback({ message: "Platform memory and curated model status refreshed.", isError: false });
    } else {
      setModelFeedback({
        message: "Some model information could not be refreshed. The catalog and memory status are reported independently; try again after resolving the listed issue.",
        isError: true,
      });
    }
  };

  const addModelFamily = async (familyId: ModelFamilyId) => {
    if (modelLibraryActionInFlight.current) return;
    const family = modelCatalog?.families.find((candidate) => candidate.familyId === familyId);
    if (!family) {
      setModelFeedback({ message: "The curated model catalog is unavailable. Refresh model status and try again.", isError: true });
      return;
    }
    modelLibraryActionInFlight.current = true;
    setModelAction({ action: "adding", familyId });
    setModelFeedback({ message: `Adding ${family.displayName} to your local model library…`, isError: false });
    try {
      const nextCatalog = await window.localScribe.system.addModelFamily({ familyId });
      setModelCatalog(nextCatalog);
      setModelCatalogError(null);
      setModelFeedback({ message: `${family.displayName} was added to your local library. Select it, download a profile, then apply it when you are ready.`, isError: false });
    } catch (error) {
      setModelFeedback({ message: `Could not add ${family.displayName}: ${errorDetail(error)}`, isError: true });
    } finally {
      modelLibraryActionInFlight.current = false;
      setModelAction(null);
    }
  };

  const applyModelSelection = async () => {
    if (!settings || modelApplyInFlight.current) return;
    const selection = pendingModelSelection ?? {
      familyId: settings.activeModelFamilyId,
      performanceMode: settings.modelPerformanceMode,
    };
    modelApplyInFlight.current = true;
    setModelApplying(true);
    setModelFeedback({ message: "Unloading the current model and loading your selected model…", isError: false });
    try {
      const result = await window.localScribe.system.applyModelSelection(selection);
      dirtySettings.current = settingsPatchWithoutModelSelection(dirtySettings.current);
      setSettings(settingsWithPendingDraft(result.settings, dirtySettings.current));
      setModelCatalog(result.catalog);
      setModelCatalogError(null);
      setDiagnostics(result.diagnostics);
      setPendingModelSelection(null);
      const family = result.catalog.families.find((candidate) => (
        candidate.familyId === result.settings.activeModelFamilyId
      ));
      setModelFeedback({
        message: result.diagnostics.model.loaded
          ? `${family?.displayName ?? result.settings.activeModelFamilyId} · ${tierLabel(result.settings.modelPerformanceMode)} is loaded and ready.`
          : `${family?.displayName ?? result.settings.activeModelFamilyId} was selected, but its runtime is not loaded. Refresh status and try again.`,
        isError: !result.diagnostics.model.loaded,
      });
    } catch (error) {
      setModelFeedback({
        message: `Could not apply the selected model: ${errorDetail(error)} Your prior model selection remains active.`,
        isError: true,
      });
    } finally {
      modelApplyInFlight.current = false;
      setModelApplying(false);
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

  const loadPresentation = settingsLoadPresentation(settings, settingsLoadError);
  const loadingPresentation = settingsLoadPresentation(null, settingsLoadError)!;
  const footerStatus = settingsLoadError
    ? "Saved settings could not be loaded."
    : tab === "model"
      ? "Model choices apply only with the Apply model button above."
      : status;
  const automaticPastePresentation = automaticPasteSettingsPresentation(permissions);
  const launchAtLoginPresentation = settings
    ? launchAtLoginSettingsPresentation(
        settings.launchAtLogin,
        launchAtLoginStatus,
        Object.prototype.hasOwnProperty.call(dirtySettings.current, "launchAtLogin"),
      )
    : null;
  const currentModelSelection: ModelSelectionDraft | null = settings ? {
    familyId: settings.activeModelFamilyId,
    performanceMode: settings.modelPerformanceMode,
  } : null;
  const displayedModelSelection = pendingModelSelection ?? currentModelSelection;

  return (
    <div
      className="ls-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeSettings(); }}
    >
      <section
        ref={dialogRef}
        className="ls-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
      >
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
            <button type="button" className="ls-close-button" disabled={modelApplying} onClick={closeSettings} aria-label="Close settings"><CloseIcon /></button>
          </header>

          <div
            key={tab}
            className="ls-settings-scroll"
            role="region"
            aria-labelledby="settings-title"
            aria-busy={loadPresentation && !loadPresentation.isError ? true : undefined}
            tabIndex={0}
          >
            {!settings ? (
              <div className={loadingPresentation.isError ? "ls-action-feedback is-error" : "ls-action-feedback"} role={loadingPresentation.isError ? "alert" : "status"} aria-live="polite">
                <strong>{loadingPresentation.title}</strong><br />{loadingPresentation.detail}
              </div>
            ) : (
              <>
            {tab === "general" && (
              <>
                <SettingsGroup title="Dictation">
                  <ShortcutRecorder
                    kind="hold"
                    label="Push-to-talk shortcut"
                    detail="Hold this key while speaking, then release it to transcribe."
                    value={settings.holdShortcut}
                    platform={shortcutPlatform}
                    onAccept={(shortcut) => commitShortcut("hold", shortcut)}
                  />
                  <ShortcutRecorder
                    kind="toggle"
                    label="Toggle dictation shortcut"
                    detail="Press once to start listening and once again to stop."
                    value={settings.toggleShortcut}
                    platform={shortcutPlatform}
                    onAccept={(shortcut) => commitShortcut("toggle", shortcut)}
                  />
                  <SettingsSelect
                    label="Microphone"
                    detail="The input used by the floating bar."
                    value={settings.microphoneId ?? ""}
                    onChange={(value) => update("microphoneId", value || null)}
                  >
                    <option value="">System default</option>
                    {selectedMicrophoneIsUnavailable(settings.microphoneId, microphones) && (
                      <option value={settings.microphoneId!}>Previously selected microphone (unavailable)</option>
                    )}
                    {microphones.map((device, index) => <option value={device.deviceId} key={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
                  </SettingsSelect>
                  <SettingsSelect label="Dictation language" detail={DICTATION_LANGUAGE_DETAIL} value={settings.language} onChange={(value) => update("language", value)}>
                    {dictationLanguageOptionsFor(settings.language).map((language) => <option value={language.value} key={language.value}>{language.label}</option>)}
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
                        ? permissions.automaticPaste.ready
                          ? "Windows does not use a separate Accessibility privacy setting for LocalScribe."
                          : "Windows does not use a separate Accessibility privacy setting, but the local paste helper is unavailable. Completed dictation will be copied."
                        : "Automatic paste and global push-to-talk are not supported on this platform yet."}
                      value={permissions.platform === "win32"
                        ? permissions.automaticPaste.ready ? "No extra permission" : "Copy only"
                        : "Unavailable"}
                    />
                  )}
                </SettingsGroup>
              </>
            )}

            {tab === "system" && (
              <>
                <SettingsGroup title="App behavior">
                  {launchAtLoginPresentation?.editable
                    ? <SettingsToggle label="Launch at login" detail={launchAtLoginPresentation.detail} value={launchAtLoginPresentation.value} onChange={(value) => update("launchAtLogin", value)} />
                    : <SettingsReadOnly label="Launch at login" detail={launchAtLoginPresentation?.detail ?? "Checking login startup."} value="Unavailable" />}
                  <SettingsToggle label="Show floating bar" detail="Keep the small bottom-center control visible while idle." value={settings.showPillWhenIdle} onChange={(value) => update("showPillWhenIdle", value)} />
                  {automaticPastePresentation.editable
                    ? <SettingsToggle label="Paste automatically" detail={automaticPastePresentation.detail} value={settings.autoPaste} onChange={(value) => update("autoPaste", value)} />
                    : <SettingsReadOnly label="Paste automatically" detail={automaticPastePresentation.detail} value={automaticPastePresentation.value ?? "Unavailable"} />}
                  <SettingsToggle label="Save transcript history" detail="Text is encrypted locally. Raw audio is not retained." value={settings.keepHistory} onChange={(value) => update("keepHistory", value)} />
                  <SettingsSelect label="History retention" detail="Expired encrypted transcripts are deleted locally." value={String(settings.historyRetentionDays)} onChange={(value) => update("historyRetentionDays", Number(value) as AppSettings["historyRetentionDays"])}>
                    {HISTORY_RETENTION_OPTIONS.map((days) => <option key={days} value={days}>{historyRetentionLabel(days)}</option>)}
                  </SettingsSelect>
                </SettingsGroup>
              </>
            )}

            {tab === "model" && (
              <ModelPerformanceSettings
                currentSelection={currentModelSelection!}
                currentModelLoaded={diagnostics?.model.loaded ?? false}
                pendingSelection={displayedModelSelection!}
                mode={displayedModelSelection!.performanceMode}
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
                memoryRequirement={diagnostics ? {
                  reservedHeadroomBytes: diagnostics.performance.reservedHeadroomBytes,
                  requiredFreeMemoryBytes: diagnostics.performance.requiredFreeMemoryBytes,
                } : null}
                catalog={modelCatalog}
                catalogError={modelCatalogError}
                runtimeTierStatuses={modelRuntimeTierStatuses(diagnostics, modelCatalog)}
                action={modelAction}
                feedback={modelFeedback}
                applying={modelApplying}
                onModeChange={(mode) => {
                  setPendingModelSelection({
                    ...displayedModelSelection!,
                    performanceMode: mode,
                  });
                  setModelFeedback({
                    message: `${tierLabel(mode)} selected. Review the combined model choice, then press Apply model.`,
                    isError: false,
                  });
                }}
                onFamilyChange={(familyId) => {
                  const family = modelCatalog?.families.find((candidate) => candidate.familyId === familyId);
                  setPendingModelSelection({
                    ...displayedModelSelection!,
                    familyId,
                  });
                  setModelFeedback({
                    message: `${family?.displayName ?? familyId} selected. Nothing changes until you press Apply model.`,
                    isError: false,
                  });
                }}
                onApply={() => void applyModelSelection()}
                onInstall={(familyId, tier) => void installModel(familyId, tier, false)}
                onRepair={(familyId, tier) => void installModel(familyId, tier, true)}
                onRemove={(familyId, tier) => void removeModel(familyId, tier)}
                onAddFamily={(familyId) => void addModelFamily(familyId)}
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
                <div className="ls-privacy-hero"><LockIcon /><div><span>Private by design</span><h2>Your voice stays on this computer.</h2><p>Audio is sent only to the selected local speech runtime and removed after transcription. Transcripts, snippet expansions, and scratchpad text are encrypted with the operating system key store.</p></div></div>
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
                  <button type="button" onClick={() => void copyDiagnostics()}><CopyIcon /><span><strong>Copy diagnostics</strong><small>Redacted failure log — no transcripts or paths.</small></span></button>
                </div>
                <div className="ls-settings-note"><InfoIcon /><span>Automatic paste reads the active app identity and hashes limited focused-window metadata to confirm the dictation target. LocalScribe does not read field or document contents from other applications.</span></div>
              </>
            )}
              </>
            )}
          </div>

          <footer className="ls-settings-footer">
            {/*
              The status ellipsizes rather than widening the footer, so a long
              message (a save failure, or an export path) would otherwise lose
              its tail. `title` keeps the whole string recoverable on hover.
            */}
            <span
              className={settingsLoadError || status.startsWith("Could not") || status.startsWith("Model removed, but") ? "is-error" : ""}
              role="status"
              aria-live="polite"
              title={footerStatus}
            >
              {footerStatus}
            </span>
            {/*
              Disabled for library work too, not just Apply. A model install is
              the longest operation in the app, and Cancel sat fully enabled
              throughout it — the button offered an exit it would not honour.
            */}
            <button type="button" className="ls-secondary-button" disabled={modelApplying || modelAction !== null} onClick={closeSettings}>Cancel</button>
            {tab !== "model" && (
              <button type="button" className="ls-primary-button" disabled={busy || !settings} onClick={() => void save()}>{busy ? "Saving…" : "Save changes"}</button>
            )}
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

export function modelRuntimeTierStatuses(
  diagnostics: Diagnostics | null,
  catalog: ModelCatalog | null = null,
): ModelTierRuntimeStatus[] {
  const activeStatuses = diagnostics?.performance.options.map((option) => ({
    familyId: diagnostics.model.familyId,
    tier: option.tier,
    artifactId: option.artifactId,
    qualityNote: option.qualityNote,
    verificationStatus: option.verificationStatus,
  })) ?? [];
  if (!catalog) return activeStatuses;

  return catalog.families.flatMap((family) => family.profiles.map((profile) => {
    const verification = catalog.verifications.find((candidate) => (
      candidate.familyId === family.familyId
      && candidate.artifactId === profile.artifactId
    ));
    const activeStatus = activeStatuses.find((candidate) => (
      candidate.familyId === family.familyId
      && candidate.tier === profile.tier
      && candidate.artifactId === profile.artifactId
    ));
    return {
      familyId: family.familyId,
      tier: profile.tier,
      artifactId: profile.artifactId,
      qualityNote: activeStatus?.qualityNote,
      verificationStatus: verification?.verificationStatus
        ?? activeStatus?.verificationStatus
        ?? "unknown",
    };
  }));
}

function catalogModelProfile(
  catalog: ModelCatalog | null,
  familyId: ModelFamilyId,
  tier: ModelPerformanceTier,
) {
  const family = catalog?.families.find((candidate) => candidate.familyId === familyId);
  const profile = family?.profiles.find((candidate) => candidate.tier === tier);
  const artifact = profile && family?.artifacts.find((candidate) => candidate.artifactId === profile.artifactId);
  return family && profile && artifact ? { family, profile, artifact } : null;
}

export function modelArtifactScopePresentation(
  catalog: ModelCatalog | null,
  familyId: ModelFamilyId,
  tier: ModelPerformanceTier,
): {
  confirmationTarget: string;
  progressTarget: string;
  removalTarget: string;
  successTarget: string;
  sharedAcrossTiers: boolean;
} {
  const model = catalogModelProfile(catalog, familyId, tier);
  const familyName = model?.family.displayName ?? familyId;
  const sharedAcrossTiers = Boolean(model && model.family.profiles
    .filter((profile) => profile.artifactId === model.profile.artifactId).length > 1);
  if (sharedAcrossTiers) {
    return {
      confirmationTarget: `${familyName} shared model data for all performance profiles`,
      progressTarget: `${familyName} shared model data`,
      removalTarget: `the ${familyName} shared local model data used by all performance profiles`,
      successTarget: `${familyName} shared model data for all performance profiles`,
      sharedAcrossTiers,
    };
  }
  const profile = `${familyName} ${tierLabel(tier)} profile`;
  return {
    confirmationTarget: profile,
    progressTarget: profile,
    removalTarget: `the ${profile}`,
    successTarget: profile,
    sharedAcrossTiers,
  };
}

export function modelActionFailureMessage(
  action: "install" | "repair",
  error: unknown,
  diagnostics: Diagnostics | null,
): string {
  const detail = errorDetail(error);
  const verb = action === "install" ? "download" : "repair";
  const requirement = diagnostics?.performance.requiredFreeMemoryBytes;
  const headroom = diagnostics?.performance.reservedHeadroomBytes;
  const available = diagnostics?.accelerator.freeMemoryBytes;
  if (/free accelerator memory|reserved headroom|accelerator memory could not be measured/i.test(detail)) {
    if (requirement !== null && requirement !== undefined && available !== null && available !== undefined) {
      return `Could not ${verb} this profile. It requires ${formatAcceleratorBytesForMessage(requirement)} free accelerator memory${headroom === null || headroom === undefined ? "" : `, including ${formatAcceleratorBytesForMessage(headroom)} reserved headroom`}; LocalScribe currently reports ${formatAcceleratorBytesForMessage(available)} available. ${detail}`;
    }
    if (requirement !== null && requirement !== undefined) {
      return `Could not ${verb} this profile because run eligibility cannot be measured. It requires ${formatAcceleratorBytesForMessage(requirement)} free accelerator memory${headroom === null || headroom === undefined ? "" : `, including ${formatAcceleratorBytesForMessage(headroom)} reserved headroom`}. ${detail}`;
    }
  }
  return `Could not ${verb} this curated model profile: ${detail}`;
}

export function modelInstallRequest(
  familyId: ModelFamilyId,
  tier: ModelPerformanceTier,
  replaceExisting: boolean,
) {
  return { confirmed: true as const, familyId, tier, replaceExisting };
}

export function modelRemoveRequest(familyId: ModelFamilyId, tier: ModelPerformanceTier) {
  return { confirmed: true as const, familyId, tier };
}

function formatAcceleratorBytesForMessage(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(bytes >= 10 * 1_073_741_824 ? 1 : 2)} GiB`;
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

export function resolvedModelEngine(diagnostics: Diagnostics | null): string {
  return diagnostics?.backend ?? "Checking";
}

/*
 * Says what was copied, so a user knows what they are about to paste into a
 * public issue tracker. The trail is redacted by construction, and telling them
 * that is what makes it reasonable to ask them to share it.
 */
export const DIAGNOSTICS_COPIED_STATUS =
  "Diagnostics copied. It records what failed and when — never transcripts, audio, or file paths.";

export const TOGGLE_UNREGISTERED_ADVICE =
  "The toggle shortcut is not registered — another app is already using it. Choose a different toggle shortcut below, or start dictation from the menu bar icon.";

export function shortcutHelpText(
  permissions: PermissionSnapshot | null,
  holdShortcut: string,
): string {
  const platform = permissions?.platform === "darwin"
    || permissions?.platform === "win32"
    || permissions?.platform === "linux"
    ? permissions.platform
    : undefined;
  const label = shortcutDisplayLabel(holdShortcut, platform);
  if (!permissions) return `Shortcut changes apply immediately. The current push-to-talk key is ${label}.`;

  /*
   * Every branch below used to fall back to "use the toggle shortcut" — advice
   * that is actively wrong when the toggle accelerator was never registered.
   * Startup does not fail in that case, so a user could be told to press a key
   * that does nothing while the only record of the failure was a console
   * warning going to /dev/null. Say it plainly instead.
   */
  const toggleDead = !permissions.globalToggle.ready;
  const withToggle = (whenLive: string, whenDead: string): string =>
    toggleDead ? `${whenDead} ${TOGGLE_UNREGISTERED_ADVICE}` : whenLive;

  if (permissions.globalHold.ready) {
    const hold = `Shortcut changes apply immediately. Hold ${label} to dictate from any app.`;
    // Hold works, so this is not urgent — but the toggle is still advertised in
    // both menus and the recorder below, and pressing it does nothing.
    return withToggle(hold, hold);
  }
  if (permissions.platform === "darwin") {
    if (permissions.accessibility.granted) {
      return withToggle(
        `The current push-to-talk key is ${label}. Accessibility is granted, but the global keyboard hook is not running. Restart LocalScribe or use the toggle shortcut.`,
        `The current push-to-talk key is ${label}. Accessibility is granted, but the global keyboard hook is not running.`,
      );
    }
    return withToggle(
      `The current push-to-talk key is ${label}. Grant Accessibility to use it globally; until then, use the toggle shortcut and LocalScribe will copy completed dictation.`,
      `The current push-to-talk key is ${label}. Grant Accessibility to use it globally.`,
    );
  }
  if (permissions.platform === "win32") {
    return withToggle(
      `The current push-to-talk key is ${label}. The Windows global keyboard hook is not running; restart LocalScribe or use the toggle shortcut.`,
      `The current push-to-talk key is ${label}. The Windows global keyboard hook is not running.`,
    );
  }
  return withToggle(
    `The current push-to-talk key is ${label}. Global push-to-talk is unavailable on this platform; the toggle shortcut still works.`,
    `The current push-to-talk key is ${label}. Global push-to-talk is unavailable on this platform.`,
  );
}

function errorDetail(error: unknown): string {
  return rendererSafeErrorMessage(error);
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
function CopyIcon(props: IconProps) { return <Icon {...props}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></Icon>; }
function GaugeIcon(props: IconProps) { return <Icon {...props}><path d="M4 14a8 8 0 1 1 16 0"/><path d="m12 14 4-4"/><path d="M5 18h14"/></Icon>; }
