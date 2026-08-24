import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  type AppSettings,
  type AsrMode,
  type LivePartialTranscript,
  type PillMode,
  type SessionSnapshot,
} from "../../shared/contracts";
import { ERROR_NOTICE_DURATION_MS, presentDictationError } from "../../shared/dictationErrors";
import { selectableMicrophones } from "../../shared/microphones";
import {
  pillErrorCountdownCssProperties,
  pillWaveBarScale,
  PILL_LAYOUT_CSS_PROPERTIES,
  type PillLayoutCssVariable,
  rendererPillModeForMainMode,
} from "../../shared/pillLayout";
import {
  shortcutCompactLabel,
} from "../../shared/shortcuts";
import { AudioRecorder, RecorderCancelledError } from "../audioRecorder";
import { openLiveAudioIpcSink, type LiveAudioSink } from "../../shared/liveAudioTransport";

const WAVE_SAMPLE_COUNT = 15;
const MICROPHONE_PICKER_ID = "pill-microphone-picker";
const MICROPHONE_PICKER_TITLE_ID = "pill-microphone-picker-title";
const quietWave = () => Array.from({ length: WAVE_SAMPLE_COUNT }, () => 0);
type PillStyle = CSSProperties & Record<PillLayoutCssVariable, string>;
type ErrorNoticeStyle = CSSProperties & Record<"--pill-error-notice-duration", string>;
const pillStageStyle = PILL_LAYOUT_CSS_PROPERTIES as PillStyle;

type ShortcutSettingsStatus = "loading" | "unavailable" | "ready";
type MicrophoneListStatus = "idle" | "loading" | "ready" | "unavailable";

export function holdShortcutPresentation(
  holdShortcut: string | null,
  status: ShortcutSettingsStatus,
): { tooltip: string; dictateAriaLabel: string } {
  if (status !== "ready" || !holdShortcut) {
    const detail = status === "loading"
      ? "shortcut settings are loading"
      : "shortcut settings are unavailable";
    return {
      tooltip: `Dictate · ${detail}`,
      dictateAriaLabel: `Start dictating; ${detail}`,
    };
  }

  const label = shortcutCompactLabel(holdShortcut);
  return {
    tooltip: `Dictate · hold ${label}`,
    dictateAriaLabel: `Start dictating; hold ${label}`,
  };
}

export async function listSelectableMicrophones(
  mediaDevices: Pick<MediaDevices, "enumerateDevices"> | undefined,
): Promise<MediaDeviceInfo[]> {
  if (!mediaDevices) throw new Error("Media device discovery is unavailable");
  return selectableMicrophones(await mediaDevices.enumerateDevices());
}

export function selectedMicrophoneIsUnavailable(
  microphoneId: string | null,
  microphones: readonly Pick<MediaDeviceInfo, "deviceId">[],
): boolean {
  return microphoneId !== null
    && !microphones.some((device) => device.deviceId === microphoneId);
}

export async function trySelectMicrophone(
  onSelectMicrophone: (microphoneId: string | null) => Promise<void>,
  microphoneId: string | null,
): Promise<boolean> {
  try {
    await onSelectMicrophone(microphoneId);
    return true;
  } catch {
    return false;
  }
}

export function listeningRecorderStart(
  snapshot: SessionSnapshot,
  settingsStatus: ShortcutSettingsStatus,
  startedSessionId: string | null,
  microphoneId: string | null,
): { sessionId: string; microphoneId: string | null } | null {
  if (
    snapshot.state !== "listening"
    || !snapshot.sessionId
    || settingsStatus === "loading"
    || snapshot.sessionId === startedSessionId
  ) {
    return null;
  }
  return { sessionId: snapshot.sessionId, microphoneId };
}

export function isCurrentFinalization(
  snapshot: SessionSnapshot,
  sessionId: string | undefined,
): boolean {
  return snapshot.state === "finalizing" && snapshot.sessionId === sessionId;
}

export interface LiveRecorderStartup {
  readonly sessionId: string;
  readonly openSink: () => Promise<LiveAudioSink>;
  readonly currentSnapshot: () => SessionSnapshot;
  readonly currentRecorderSessionId: () => string | null;
  readonly startRecorder: (sink: LiveAudioSink) => Promise<void>;
}

/**
 * Opening the main-process Live sink can take long enough for cancellation or
 * a later dictation to win. Recheck both authorities after that await and
 * close the stale sink before any microphone API can be reached.
 */
export async function startLiveRecorderForCurrentSession(
  startup: LiveRecorderStartup,
): Promise<boolean> {
  const sink = await startup.openSink();
  const current = startup.currentSnapshot();
  if (
    current.state !== "listening"
    || current.sessionId !== startup.sessionId
    || startup.currentRecorderSessionId() !== startup.sessionId
  ) {
    try {
      await sink.abort?.(new RecorderCancelledError());
    } catch {
      // Main may already have cancelled the same sink. It is still stale and
      // must never be allowed to proceed to microphone capture.
    }
    return false;
  }
  await startup.startRecorder(sink);
  return true;
}

/**
 * Live decoder updates are replacement snapshots, not append-only tokens.
 * Reject stale, cancelled, and wrong-session updates before they reach the
 * pill so an old recognition can never be shown during a later recording.
 */
export function acceptsLivePartial(
  snapshot: SessionSnapshot,
  current: LivePartialTranscript | null,
  incoming: LivePartialTranscript,
): boolean {
  if (snapshot.state !== "listening" || snapshot.sessionId !== incoming.sessionId) return false;
  return current?.sessionId !== incoming.sessionId || incoming.sequence > current.sequence;
}

/** The transcript is visible only for the exact currently-listening session. */
export function livePartialText(
  snapshot: SessionSnapshot,
  partial: LivePartialTranscript | null,
): string | null {
  if (snapshot.state !== "listening" || !partial || partial.sessionId !== snapshot.sessionId) return null;
  return partial.text.trim() || null;
}

/** Keep the newest words visible as a replacement-style Live snapshot grows. */
export function scrollLiveTranscriptToEnd(
  viewport: { scrollHeight: number; scrollTop: number } | null,
): void {
  if (viewport) viewport.scrollTop = viewport.scrollHeight;
}

export function Pill() {
  const [snapshot, setSnapshot] = useState<SessionSnapshot>({ state: "idle" });
  const [microphoneId, setMicrophoneId] = useState<string | null>(null);
  const [holdShortcut, setHoldShortcut] = useState<string | null>(null);
  const [shortcutSettingsStatus, setShortcutSettingsStatus] = useState<ShortcutSettingsStatus>("loading");
  const [waveform, setWaveform] = useState<number[]>(quietWave);
  const [livePartial, setLivePartial] = useState<LivePartialTranscript | null>(null);
  const [asrMode, setAsrMode] = useState<AsrMode>("after-stop");
  const recorder = useRef(new AudioRecorder());
  const previousState = useRef<SessionSnapshot["state"]>("idle");
  const latestSnapshot = useRef<SessionSnapshot>({ state: "idle" });
  const microphoneIdRef = useRef<string | null>(null);
  const asrModeRef = useRef<AsrMode>("after-stop");
  const settingsStatusRef = useRef<ShortcutSettingsStatus>("loading");
  const recorderSessionId = useRef<string | null>(null);
  const livePartialRef = useRef<LivePartialTranscript | null>(null);

  useEffect(() => {
    recorder.current.setLevelListener((level) => {
      setWaveform((current) => [...current.slice(1), level]);
    });
    let sawLiveEvent = false;
    const handleFailure = async (sessionId: string, error: unknown) => {
      if (error instanceof RecorderCancelledError) return;
      const message = error instanceof Error ? error.message : "Microphone recording failed";
      await window.localScribe.session.fail({ sessionId, message });
    };
    const startListeningRecorder = async () => {
      const start = listeningRecorderStart(
        latestSnapshot.current,
        settingsStatusRef.current,
        recorderSessionId.current,
        microphoneIdRef.current,
      );
      if (!start) return;
      recorderSessionId.current = start.sessionId;
      setWaveform(quietWave());
      try {
        if (asrModeRef.current === "live") {
          await startLiveRecorderForCurrentSession({
            sessionId: start.sessionId,
            openSink: () => openLiveAudioIpcSink({
              beginLiveAudio: (session) => window.localScribe.session.beginLive(session),
              pushLiveAudio: (frame) => window.localScribe.session.pushLive(frame),
              finishLiveAudio: (request) => window.localScribe.session.finishLive(request).then(() => undefined),
              cancelLiveAudio: (request) => window.localScribe.session.cancelLive(request),
            }, {
              sessionId: start.sessionId,
              protocolVersion: 1,
              sampleRateHz: 16_000,
              channels: 1,
            }),
            currentSnapshot: () => latestSnapshot.current,
            currentRecorderSessionId: () => recorderSessionId.current,
            startRecorder: (sink) => recorder.current.start(
              start.microphoneId,
              { transport: "live", liveSink: sink },
            ),
          });
        } else {
          await recorder.current.start(start.microphoneId);
        }
      } catch (error) {
        await handleFailure(start.sessionId, error);
      }
    };
    const applySnapshot = (next: SessionSnapshot) => {
      const previous = previousState.current;
      previousState.current = next.state;
      latestSnapshot.current = next;
      // Clear synchronously as the authoritative session changes. A late IPC
      // message from the previous decoder must not survive cancellation,
      // finalization, or the start of another recording.
      if (next.state !== "listening" || livePartialRef.current?.sessionId !== next.sessionId) {
        livePartialRef.current = null;
        setLivePartial(null);
      }
      setSnapshot(next);
      if (next.state === "listening" && previous !== "listening") {
        void startListeningRecorder();
      } else if (next.state === "finalizing" && previous === "listening") {
        const sessionId = next.sessionId;
        recorderSessionId.current = null;
        void recorder.current
          .stop()
          .then(async (audio) => {
            if (!sessionId) throw new Error("Dictation session identity is missing");
            if (!isCurrentFinalization(latestSnapshot.current, sessionId)) return;
            try {
              if (audio.transport === "finalized") {
                await window.localScribe.session.transcribe({
                  wav: audio.wav,
                  durationMs: audio.durationMs,
                  sessionId,
                });
              }
            } catch {
              // The main process owns transcription failures and has already surfaced the error.
            }
          })
          .catch((error: unknown) => {
            if (isCurrentFinalization(latestSnapshot.current, sessionId)) {
              if (sessionId) void handleFailure(sessionId, error);
            }
          });
      } else if (
        next.state === "idle" &&
        (previous === "listening" || previous === "finalizing")
      ) {
        recorderSessionId.current = null;
        void recorder.current.cancel();
      }
      if (next.state !== "listening") setWaveform(quietWave());
    };
    const unsubscribe = window.localScribe.session.onChanged((next) => {
      sawLiveEvent = true;
      applySnapshot(next);
    });
    const unsubscribeLivePartial = window.localScribe.session.onLivePartial((partial) => {
      if (!acceptsLivePartial(latestSnapshot.current, livePartialRef.current, partial)) return;
      livePartialRef.current = partial;
      setLivePartial(partial);
    });
    let sawSettingsChange = false;
    const applySettings = (settings: Pick<AppSettings, "microphoneId" | "holdShortcut" | "asrMode">) => {
      settingsStatusRef.current = "ready";
      microphoneIdRef.current = settings.microphoneId;
      asrModeRef.current = settings.asrMode;
      setAsrMode(settings.asrMode);
      setMicrophoneId(settings.microphoneId);
      setHoldShortcut(settings.holdShortcut);
      setShortcutSettingsStatus("ready");
      void startListeningRecorder();
    };
    const unsubscribeSettings = window.localScribe.settings.onChanged((settings) => {
      sawSettingsChange = true;
      applySettings(settings);
    });
    void window.localScribe.settings.get().then((settings) => {
      if (!sawSettingsChange) applySettings(settings);
    }).catch(() => {
      if (!sawSettingsChange) {
        settingsStatusRef.current = "unavailable";
        setShortcutSettingsStatus("unavailable");
        void startListeningRecorder();
      }
    });
    void window.localScribe.session.get().then((initial) => {
      if (!sawLiveEvent) applySnapshot(initial);
    });
    return () => {
      unsubscribe();
      unsubscribeLivePartial();
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
        : <ActivePill
            snapshot={snapshot}
            waveform={waveform}
            livePartial={livePartial}
            asrMode={asrMode}
          />}
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
  const [hoveredAction, setHoveredAction] = useState<"dictate" | "microphone" | "scratchpad" | null>(null);
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneListStatus, setMicrophoneListStatus] = useState<MicrophoneListStatus>("idle");
  const [savingMicrophone, setSavingMicrophone] = useState(false);
  const [microphoneError, setMicrophoneError] = useState("");
  const pillModeRequest = useRef(0);
  const microphoneListRequest = useRef(0);
  const microphoneSelectionPending = useRef(false);
  const pointerInside = useRef(false);
  const pickerOpen = visualMode === "picker";
  const visualModeRef = useRef(visualMode);
  visualModeRef.current = visualMode;
  const loadingMicrophones = microphoneListStatus === "idle"
    || microphoneListStatus === "loading";
  const selectedMicrophoneUnavailable = microphoneListStatus === "ready"
    && selectedMicrophoneIsUnavailable(microphoneId, microphones);

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
    const request = ++microphoneListRequest.current;
    setMicrophoneError("");
    setMicrophoneListStatus("loading");
    try {
      const devices = await listSelectableMicrophones(navigator.mediaDevices);
      if (microphoneListRequest.current !== request) return;
      setMicrophones(devices);
      setMicrophoneListStatus("ready");
    } catch {
      if (microphoneListRequest.current !== request) return;
      setMicrophones([]);
      setMicrophoneError("Microphones could not be listed");
      setMicrophoneListStatus("unavailable");
    }
  };

  const showHover = () => {
    pointerInside.current = true;
    if (pickerOpen) return;
    void requestPillMode("hover", () => {
      if (pointerInside.current) setVisualMode("hover");
    });
  };

  /*
   * Main owns the transparent window and resizes it from the real cursor
   * position. Follow whatever it committed: a window that changes size under a
   * stationary pointer does not produce pointerenter/pointerleave, so after
   * main contracts on its own the expanded controls would otherwise stay
   * mounted, clipped inside the 40x8 rail, with `pointerInside` still true.
   *
   * This never calls back into setPillMode — main is already there.
   */
  useEffect(() => window.localScribe.windows.onPillModeChanged((mode) => {
    const next = rendererPillModeForMainMode(visualModeRef.current, mode);
    if (next === visualModeRef.current) return;
    pointerInside.current = next !== "collapsed";
    if (next === "collapsed") setHoveredAction(null);
    setVisualMode(next);
  }), []);

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
    if (microphoneSelectionPending.current) return;
    microphoneSelectionPending.current = true;
    setSavingMicrophone(true);
    setMicrophoneError("");
    try {
      const selected = await trySelectMicrophone(onSelectMicrophone, nextMicrophoneId);
      if (!selected) {
        setMicrophoneError("Microphone selection could not be saved");
        return;
      }
      const nextMode: PillMode = pointerInside.current ? "hover" : "collapsed";
      // This transition only reduces the renderer while its native window is still picker-sized.
      flushSync(() => setVisualMode(nextMode));
      void requestPillMode(nextMode);
    } finally {
      microphoneSelectionPending.current = false;
      setSavingMicrophone(false);
    }
  };

  const shortcutPresentation = holdShortcutPresentation(
    holdShortcut,
    shortcutSettingsStatus,
  );
  const tooltip = hoveredAction === "scratchpad"
    ? "Scratchpad"
    : hoveredAction === "microphone"
      ? (pickerOpen ? "Close microphone menu" : "Choose microphone")
      : shortcutPresentation.tooltip;
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
          <div
            className="pill__microphone-menu"
            id={MICROPHONE_PICKER_ID}
            role="group"
            aria-labelledby={MICROPHONE_PICKER_TITLE_ID}
            aria-busy={loadingMicrophones || savingMicrophone}
          >
            <span className="pill__microphone-title" id={MICROPHONE_PICKER_TITLE_ID}>Microphone</span>
            <button
              type="button"
              aria-pressed={microphoneId === null}
              disabled={savingMicrophone}
              onClick={() => void chooseMicrophone(null)}
            >
              <span className="pill__device-check">{microphoneId === null ? <CheckIcon /> : null}</span>
              <span>System default</span>
            </button>
            {loadingMicrophones && <span className="pill__device-empty" role="status">Looking for microphones…</span>}
            {savingMicrophone && <span className="pill__device-empty" role="status">Saving microphone…</span>}
            {!loadingMicrophones && microphoneError && <span className="pill__device-empty" role="alert">{microphoneError}</span>}
            {!loadingMicrophones && microphones.map((device, index) => (
              <button
                type="button"
                aria-pressed={microphoneId === device.deviceId}
                disabled={savingMicrophone}
                key={device.deviceId}
                onClick={() => void chooseMicrophone(device.deviceId)}
              >
                <span className="pill__device-check">{microphoneId === device.deviceId ? <CheckIcon /> : null}</span>
                <span title={device.label}>{device.label || `Microphone ${index + 1}`}</span>
              </button>
            ))}
            {selectedMicrophoneUnavailable && (
              <span className="pill__device-empty" role="status">
                Selected microphone is unavailable. Choose another input.
              </span>
            )}
            {microphoneListStatus === "ready"
              && !selectedMicrophoneUnavailable
              && microphones.length === 0
              && <span className="pill__device-empty">No additional microphones found</span>}
          </div>
        )}
        <span className="pill__idle-tooltip" data-action={tooltipAction} role="status" title={tooltip}>{tooltip}</span>
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
            className="pill__round pill__round--microphone"
            type="button"
            onClick={togglePicker}
            aria-label={pickerOpen ? "Close microphone menu" : "Choose microphone"}
            aria-controls={MICROPHONE_PICKER_ID}
            aria-expanded={pickerOpen}
            onPointerEnter={() => setHoveredAction("microphone")}
            onPointerLeave={() => setHoveredAction(null)}
          >
            <MixerIcon />
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
  livePartial,
  asrMode,
}: {
  snapshot: SessionSnapshot;
  waveform: number[];
  livePartial: LivePartialTranscript | null;
  asrMode: AsrMode;
}) {
  if (snapshot.state === "listening") {
    const transcript = livePartialText(snapshot, livePartial);
    const ariaLabel = transcript
      ? `LocalScribe is listening. Current live transcript: ${transcript}`
      : "LocalScribe is listening";
    if (asrMode === "live") {
      return (
        <LiveListeningPill
          activation={snapshot.activation}
          ariaLabel={ariaLabel}
          transcript={transcript}
          waveform={waveform}
        />
      );
    }
    if (snapshot.activation === "hold") {
      return (
        <section className="pill pill--listening pill--hold-listening" aria-label={ariaLabel}>
          <Wave samples={waveform} />
        </section>
      );
    }
    return (
      <section className="pill pill--listening" aria-label={ariaLabel}>
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
    return <ErrorNotice message={snapshot.message} />;
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
      {/* The box is sized for the longest message the product composes, but a
          future or localized string could still ellipsize; keep it readable. */}
      <span className="pill__status-copy" title={status}>{status}</span>
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

function LiveListeningPill({
  activation,
  ariaLabel,
  transcript,
  waveform,
}: {
  activation: "hold" | "toggle" | undefined;
  ariaLabel: string;
  transcript: string | null;
  waveform: number[];
}) {
  const transcriptViewport = useRef<HTMLDivElement>(null);
  const isHold = activation === "hold";

  useLayoutEffect(() => {
    scrollLiveTranscriptToEnd(transcriptViewport.current);
  }, [transcript]);

  return (
    <section className={`pill pill-live-stack${isHold ? " pill-live-stack--hold" : ""}`} aria-label={ariaLabel}>
      <div
        className="pill__live-transcript"
        ref={transcriptViewport}
        title={transcript ?? undefined}
      >
        <span>{transcript ?? "Listening…"}</span>
      </div>
      <div className={`pill pill--listening pill__live-controls${isHold ? " pill--hold-listening" : ""}`}>
        {!isHold && (
          <button className="pill__end pill__end--cancel" type="button" onClick={() => void window.localScribe.session.cancel()} aria-label="Cancel dictation">
            <CloseIcon />
          </button>
        )}
        <Wave samples={waveform} />
        {!isHold && (
          <button className="pill__end pill__end--finish" type="button" onClick={() => void window.localScribe.session.toggle()} aria-label="Finish dictation">
            <CheckIcon />
          </button>
        )}
      </div>
    </section>
  );
}

function ErrorNotice({ message }: { message?: string }) {
  const error = presentDictationError(message, "darwin");
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
            transform: `scaleY(${pillWaveBarScale(sample)})`,
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

function MixerIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h8M17 7h2M11 12h8M5 12h2M5 17h5M14 17h5" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="12" cy="17" r="2" /></svg>;
}
