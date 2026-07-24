import { type CSSProperties, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  type AppSettings,
  type PillMode,
  type RuntimePlatform,
  type SessionSnapshot,
} from "../../shared/contracts";
import { ERROR_NOTICE_DURATION_MS, presentDictationError } from "../../shared/dictationErrors";
import {
  pillErrorCountdownCssProperties,
  PILL_LAYOUT_CSS_PROPERTIES,
  type PillLayoutCssVariable,
} from "../../shared/pillLayout";
import { shortcutCompactLabel } from "../../shared/shortcuts";
import { AudioRecorder, RecorderCancelledError } from "../audioRecorder";

const WAVE_SAMPLE_COUNT = 15;
const quietWave = () => Array.from({ length: WAVE_SAMPLE_COUNT }, () => 0);
type PillStyle = CSSProperties & Record<PillLayoutCssVariable, string>;
type ErrorNoticeStyle = CSSProperties & Record<"--pill-error-notice-duration", string>;
const pillStageStyle = PILL_LAYOUT_CSS_PROPERTIES as PillStyle;

type ShortcutSettingsStatus = "loading" | "unavailable" | "ready";

export function holdShortcutPresentation(
  holdShortcut: string | null,
  status: ShortcutSettingsStatus,
): { tooltip: string; dictateAriaLabel: string } {
  if (status === "ready" && holdShortcut) {
    const label = shortcutCompactLabel(holdShortcut);
    return {
      tooltip: `Dictate · hold ${label}`,
      dictateAriaLabel: `Start dictating; hold ${label}`,
    };
  }
  const detail = status === "loading"
    ? "shortcut settings are loading"
    : "shortcut settings are unavailable";
  return {
    tooltip: `Dictate · ${detail}`,
    dictateAriaLabel: `Start dictating; ${detail}`,
  };
}

export function isCurrentFinalization(
  snapshot: SessionSnapshot,
  sessionId: string | undefined,
): boolean {
  return snapshot.state === "finalizing" && snapshot.sessionId === sessionId;
}

export function Pill() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({ state: "idle" });
  const [microphoneId, setMicrophoneId] = useState<string | null>(null);
  const [holdShortcut, setHoldShortcut] = useState<string | null>(null);
  const [shortcutSettingsStatus, setShortcutSettingsStatus] = useState<ShortcutSettingsStatus>("loading");
  const [platform, setPlatform] = useState<RuntimePlatform | undefined>();
  const [waveform, setWaveform] = useState<number[]>(quietWave);
  const recorder = useRef(new AudioRecorder());
  const previousState = useRef<SessionSnapshot["state"]>("idle");
  const latestSnapshot = useRef<SessionSnapshot>({ state: "idle" });
  const microphoneIdRef = useRef<string | null>(null);

  useEffect(() => {
    recorder.current.setLevelListener((level) => {
      setWaveform((current) => [...current.slice(1), level]);
    });
    let sawLiveEvent = false;
    const handleFailure = async (error: unknown) => {
      if (error instanceof RecorderCancelledError) return;
      const message = error instanceof Error ? error.message : "Microphone recording failed";
      await window.localScribe.session.fail(message);
    };
    const applySnapshot = (next: SessionSnapshot) => {
      const previous = previousState.current;
      previousState.current = next.state;
      latestSnapshot.current = next;
      setSnapshot(next);
      if (next.state === "listening" && previous !== "listening") {
        setWaveform(quietWave());
        void recorder.current.start(microphoneIdRef.current).catch(handleFailure);
      } else if (next.state === "finalizing" && previous === "listening") {
        const sessionId = next.sessionId;
        void recorder.current
          .stop()
          .then(async (audio) => {
            if (!sessionId) throw new Error("Dictation session identity is missing");
            if (!isCurrentFinalization(latestSnapshot.current, sessionId)) return;
            try {
              await window.localScribe.session.transcribe({ ...audio, sessionId });
            } catch {
              // The main process owns transcription failures and has already surfaced the error.
            }
          })
          .catch((error: unknown) => {
            if (isCurrentFinalization(latestSnapshot.current, sessionId)) {
              void handleFailure(error);
            }
          });
      } else if (
        next.state === "idle" &&
        (previous === "listening" || previous === "finalizing")
      ) {
        void recorder.current.cancel();
      }
      if (next.state !== "listening") setWaveform(quietWave());
    };
    const unsubscribe = window.localScribe.session.onChanged((next) => {
      sawLiveEvent = true;
      applySnapshot(next);
    });
    let sawSettingsChange = false;
    const applySettings = (settings: Pick<AppSettings, "microphoneId" | "holdShortcut">) => {
      microphoneIdRef.current = settings.microphoneId;
      setMicrophoneId(settings.microphoneId);
      setHoldShortcut(settings.holdShortcut);
      setShortcutSettingsStatus("ready");
    };
    const unsubscribeSettings = window.localScribe.settings.onChanged((settings) => {
      sawSettingsChange = true;
      applySettings(settings);
    });
    void window.localScribe.settings.get().then((settings) => {
      if (!sawSettingsChange) applySettings(settings);
    }).catch(() => {
      if (!sawSettingsChange) setShortcutSettingsStatus("unavailable");
    });
    void window.localScribe.system.getPermissions().then((next) => {
      setPlatform(next.platform);
    }).catch(() => undefined);
    void window.localScribe.session.get().then((initial) => {
      if (!sawLiveEvent) applySnapshot(initial);
    });
    return () => {
      unsubscribe();
      unsubscribeSettings();
    };
  }, []);

  const selectMicrophone = async (nextMicrophoneId: string | null) => {
    const settings = await window.localScribe.settings.patch({ microphoneId: nextMicrophoneId });
    microphoneIdRef.current = settings.microphoneId;
    setMicrophoneId(settings.microphoneId);
  };

  return (
    <main className="pill-stage" style={pillStageStyle}>
      {snapshot.state === "idle"
        ? <IdlePill
            microphoneId={microphoneId}
            holdShortcut={holdShortcut}
            shortcutSettingsStatus={shortcutSettingsStatus}
            onSelectMicrophone={selectMicrophone}
          />
        : <ActivePill snapshot={snapshot} waveform={waveform} platform={platform} />}
    </main>
  );
}

function IdlePill({
  microphoneId,
  holdShortcut,
  shortcutSettingsStatus,
  onSelectMicrophone,
}: {
  microphoneId: string | null;
  holdShortcut: string | null;
  shortcutSettingsStatus: ShortcutSettingsStatus;
  onSelectMicrophone: (microphoneId: string | null) => Promise<void>;
}) {
  const [visualMode, setVisualMode] = useState<PillMode>("collapsed");
  const [hoveredAction, setHoveredAction] = useState<"dictate" | "scratchpad" | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [loadingMicrophones, setLoadingMicrophones] = useState(false);
  const [microphoneError, setMicrophoneError] = useState("");
  const pillModeRequest = useRef(0);
  const pointerInside = useRef(false);
  const pickerOpen = visualMode === "picker";

  const toggle = () => {
    // The listening window is smaller than the expanded idle control, so clear it first.
    flushSync(() => setVisualMode("collapsed"));
    void window.localScribe.session.toggle();
  };

  const requestPillMode = async (mode: PillMode, onApplied?: () => void) => {
    const request = ++pillModeRequest.current;
    try {
      await window.localScribe.windows.setPillMode(mode);
      if (pillModeRequest.current === request) onApplied?.();
    } catch {
      if (pillModeRequest.current === request && mode !== "collapsed") setVisualMode("collapsed");
    }
  };

  const loadMicrophones = async () => {
    setMicrophoneError("");
    setLoadingMicrophones(true);
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices();
      setMicrophones((devices ?? []).filter((device) => device.kind === "audioinput"));
    } catch {
      setMicrophones([]);
      setMicrophoneError("Microphones could not be listed");
    } finally {
      setLoadingMicrophones(false);
    }
  };

  const showHover = () => {
    pointerInside.current = true;
    if (pickerOpen) return;
    void requestPillMode("hover", () => {
      if (pointerInside.current) setVisualMode("hover");
    });
  };

  const hideControls = () => {
    pointerInside.current = false;
    // Hide the larger renderer first; the native window can then safely contract.
    flushSync(() => {
      setHoveredAction(null);
      setVisualMode("collapsed");
    });
    void requestPillMode("collapsed");
  };

  const togglePicker = () => {
    if (pickerOpen) {
      // The picker is already inside a larger native window, so hiding it can happen first.
      flushSync(() => setVisualMode("hover"));
      void requestPillMode("hover");
      return;
    }
    void requestPillMode("picker", () => {
      if (!pointerInside.current) return;
      setVisualMode("picker");
      void loadMicrophones();
    });
  };

  const chooseMicrophone = async (nextMicrophoneId: string | null) => {
    await onSelectMicrophone(nextMicrophoneId);
    const nextMode: PillMode = pointerInside.current ? "hover" : "collapsed";
    // This transition only reduces the renderer while its native window is still picker-sized.
    flushSync(() => setVisualMode(nextMode));
    void requestPillMode(nextMode);
  };

  const shortcutPresentation = holdShortcutPresentation(holdShortcut, shortcutSettingsStatus);
  const tooltip = hoveredAction === "scratchpad" ? "Scratchpad" : shortcutPresentation.tooltip;
  const tooltipAction = hoveredAction ?? "dictate";

  return (
    <section
      className={`pill pill--idle${visualMode === "hover" ? " pill--hover" : ""}${pickerOpen ? " pill--picker-open" : ""}`}
      aria-label="LocalScribe dictation controls"
      onPointerEnter={showHover}
      onPointerLeave={hideControls}
    >
      <span className="pill__idle-rail" aria-hidden="true" />
      <div className="pill__idle-menu">
        {pickerOpen && (
          <div className="pill__microphone-menu" role="menu" aria-label="Choose microphone">
            <span className="pill__microphone-title">Microphone</span>
            <button
              type="button"
              role="menuitemradio"
              aria-checked={microphoneId === null}
              onClick={() => void chooseMicrophone(null)}
            >
              <span className="pill__device-check">{microphoneId === null ? <CheckIcon /> : null}</span>
              <span>System default</span>
            </button>
            {loadingMicrophones && <span className="pill__device-empty">Looking for microphones…</span>}
            {!loadingMicrophones && microphoneError && <span className="pill__device-empty">{microphoneError}</span>}
            {!loadingMicrophones && microphones.map((device, index) => (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={microphoneId === device.deviceId}
                key={device.deviceId}
                onClick={() => void chooseMicrophone(device.deviceId)}
              >
                <span className="pill__device-check">{microphoneId === device.deviceId ? <CheckIcon /> : null}</span>
                <span title={device.label}>{device.label || `Microphone ${index + 1}`}</span>
              </button>
            ))}
            {!loadingMicrophones && !microphoneError && microphones.length === 0 && <span className="pill__device-empty">No additional microphones found</span>}
          </div>
        )}
        <span className="pill__idle-tooltip" data-action={tooltipAction} role="status">{tooltip}</span>
        <div className="pill__idle-actions">
          <button
            className="pill__round pill__round--dictate"
            type="button"
            aria-label={shortcutPresentation.dictateAriaLabel}
            onClick={toggle}
            onContextMenu={(event) => {
              event.preventDefault();
              togglePicker();
            }}
            onPointerEnter={() => setHoveredAction("dictate")}
            onPointerLeave={() => setHoveredAction(null)}
          >
            <MicrophoneIcon />
          </button>
          <button
            className="pill__round pill__round--scratchpad"
            type="button"
            onClick={() => void window.localScribe.windows.showSettings("scratchpad")}
            aria-label="Open scratchpad"
            onPointerEnter={() => setHoveredAction("scratchpad")}
            onPointerLeave={() => setHoveredAction(null)}
          >
            <MessageIcon />
          </button>
        </div>
      </div>
    </section>
  );
}

function ActivePill({
  snapshot,
  waveform,
  platform,
}: {
  snapshot: SessionSnapshot;
  waveform: number[];
  platform: RuntimePlatform | undefined;
}) {
  if (snapshot.state === "listening") {
    if (snapshot.activation === "hold") {
      return (
        <section className="pill pill--listening pill--hold-listening" aria-label="LocalScribe push-to-talk is listening">
          <Wave samples={waveform} />
        </section>
      );
    }
    return (
      <section className="pill pill--listening" aria-label="LocalScribe is listening">
        <button className="pill__end pill__end--cancel" type="button" onClick={() => void window.localScribe.session.cancel()} aria-label="Cancel dictation">
          <CloseIcon />
        </button>
        <Wave samples={waveform} />
        <button className="pill__end pill__end--finish" type="button" onClick={() => void window.localScribe.session.toggle()} aria-label="Finish dictation">
          <CheckIcon />
        </button>
      </section>
    );
  }

  if (snapshot.state === "error") {
    return <ErrorNotice message={snapshot.message} platform={platform} />;
  }

  const canAct = snapshot.state === "success";
  const canCancel = snapshot.state === "finalizing"
    || snapshot.state === "transcribing"
    || snapshot.state === "inserting";
  const status = snapshot.message || label(snapshot);
  return (
    <section className={`pill pill--status pill--${snapshot.state}`} aria-label={`LocalScribe: ${status}`}>
      <span className="pill__status-mark" aria-hidden="true">
        <CompactWave />
      </span>
      <span className="pill__status-copy">{status}</span>
      {(canAct || canCancel) && (
        <button
          className="pill__status-close"
          type="button"
          onClick={() => void window.localScribe.session.cancel()}
          aria-label={canCancel ? "Cancel dictation" : "Dismiss"}
        >
          <CloseIcon />
        </button>
      )}
    </section>
  );
}

function ErrorNotice({ message, platform }: { message?: string; platform: RuntimePlatform | undefined }) {
  const error = presentDictationError(message, platform);
  const countdownStyle = pillErrorCountdownCssProperties() as ErrorNoticeStyle;
  return (
    <section className="pill-error-stack" role="alert" aria-label={`${error.title}. ${error.detail}`}>
      <article className="pill-error-notice" style={countdownStyle}>
        <span className="pill-error-notice__mark" aria-hidden="true">!</span>
        <span className="pill-error-notice__copy">
          <strong>{error.title}</strong>
          <span>{error.detail}</span>
        </span>
        <span className="pill-error-notice__actions">
          <svg
            className="pill-error-notice__countdown"
            viewBox="0 0 18 18"
            aria-label={`Closing automatically in ${ERROR_NOTICE_DURATION_MS / 1_000} seconds`}
          >
            <circle className="pill-error-notice__countdown-track" cx="9" cy="9" r="6.5" />
            <circle className="pill-error-notice__countdown-progress" cx="9" cy="9" r="6.5" />
          </svg>
          <button
            className="pill-error-notice__close"
            type="button"
            onClick={() => void window.localScribe.session.cancel()}
            aria-label="Dismiss error"
          >
            <CloseIcon />
          </button>
        </span>
      </article>
      <span className="pill-error-stack__rail" aria-hidden="true" />
    </section>
  );
}

function label(snapshot: SessionSnapshot): string {
  switch (snapshot.state) {
    case "idle": return "Ready";
    case "listening": return "Listening";
    case "finalizing": return "Finishing";
    case "transcribing": return "Transcribing";
    case "inserting": return "Inserting";
    case "success": return "Done";
    case "error": return "Try again";
  }
}

function Wave({ samples }: { samples: number[] }) {
  const active = samples.some((sample) => sample > 0.04);
  return (
    <span className="pill-wave" aria-hidden="true" data-active={active}>
      {samples.map((sample, index) => (
        <i
          key={index}
          style={{
            height: Math.round(2 + Math.pow(sample, 0.72) * 17),
            opacity: 0.48 + sample * 0.52,
          }}
        />
      ))}
    </span>
  );
}

function CompactWave() {
  return <span className="pill-compact-wave" aria-hidden="true">{[4, 9, 6].map((height, index) => <i key={index} style={{ height }} />)}</span>;
}

function MessageIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5h11v8.2h-5.8L8.4 18v-3.3H6.5z" /><path d="M9 9.4h6M9 12h4" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M14 6l-8 8" /></svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.2 10.2 3.1 3.1 6.5-6.6" /></svg>;
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5a3 3 0 0 0-3 3v4.7a3 3 0 0 0 6 0V7.5a3 3 0 0 0-3-3Z" /><path d="M6.7 11.8a5.3 5.3 0 0 0 10.6 0M12 17.1v2.4M8.8 19.5h6.4" /></svg>;
}
