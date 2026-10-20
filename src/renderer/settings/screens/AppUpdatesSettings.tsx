import { useEffect, useRef, useState } from "react";
import type { AppUpdateState } from "../../../shared/appUpdates";
import { subscribeToSettingsWithInitialLoad } from "./StyleSettings";

const phaseLabels: Record<AppUpdateState["phase"], string> = {
  idle: "Updates have not been checked.",
  checking: "Checking for updates…",
  current: "LocalScribe is up to date.",
  available: "An update is available.",
  downloading: "Downloading the approved update…",
  ready: "Update downloaded. It will install when LocalScribe next quits normally, or restart now to update.",
  installing: "Restarting to install the update…",
  error: "Could not update LocalScribe. Check for updates to retry. If a native update attempt failed, relaunch LocalScribe before trying again.",
  unsupported: "Updates are unavailable for this installation.",
};

export function AppUpdatesSettings({ checkAutomatically, onCheckAutomaticallyChange }: {
  checkAutomatically: boolean;
  onCheckAutomaticallyChange(value: boolean): void;
}) {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(false);
  const actionInFlight = useRef(false);
  const revision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const dispose = subscribeToSettingsWithInitialLoad({
      get: () => window.localScribe.updates.getState(),
      onChanged: (listener) => window.localScribe.updates.onChanged(listener),
    }, (next) => {
      revision.current += 1;
      setState(next);
    }, () => setState({ phase: "error", currentVersion: "", message: "Could not load update status. Check for updates to retry." }));
    return () => { mounted.current = false; dispose(); };
  }, []);

  const runAction = async (install: boolean) => {
    if (actionInFlight.current) return;
    if (install && !window.confirm(
      "Download and restart LocalScribe to install this update? An approved downloaded update also installs on the next normal quit. Finish dictation first; LocalScribe will not restart while dictation is active.",
    )) return;
    actionInFlight.current = true;
    setPending(true);
    const initialRevision = revision.current;
    try {
      const next = await (install
        ? window.localScribe.updates.downloadAndRestart()
        : window.localScribe.updates.check());
      if (mounted.current && revision.current === initialRevision) setState(next);
    } catch {
      if (mounted.current && revision.current === initialRevision) setState((previous) => ({
        phase: "error",
        currentVersion: previous?.currentVersion ?? "",
        message: install
          ? "The native update attempt failed. Relaunch LocalScribe before trying again."
          : "Could not check for updates. Try Check for updates again.",
      }));
    } finally {
      actionInFlight.current = false;
      if (mounted.current) setPending(false);
    }
  };

  const busy = pending || !state || ["checking", "downloading", "installing"].includes(state.phase);
  const canInstall = state?.phase === "available" || state?.phase === "ready";
  return (
    <section className="ls-settings-group">
      <h2>Updates</h2>
      <div>
        <label className="ls-settings-row">
          <span><strong>Check automatically</strong><small>Check update metadata on launch. Downloads require approval. Audio always stays local. Save changes to apply.</small></span>
          <input className="ls-switch" type="checkbox" checked={checkAutomatically} onChange={(event) => onCheckAutomaticallyChange(event.target.checked)} />
        </label>
        <div className="ls-settings-row">
          <span><strong>Current version</strong><small>The installed LocalScribe app.</small></span>
          <span className="ls-readonly-value">{state?.currentVersion || "Checking…"}</span>
        </div>
        <div className="ls-settings-row">
          <span><strong>Update status{state?.availableVersion ? ` · ${state.availableVersion}` : ""}</strong><small role="status" aria-live="polite">{state ? state.message ?? phaseLabels[state.phase] : "Loading update status…"}</small></span>
          <button type="button" className="ls-small-button" disabled={busy || state?.phase === "unsupported" || state?.phase === "ready"} onClick={() => void runAction(false)}>Check for updates</button>
        </div>
        {canInstall && <div className="ls-settings-row">
          <span><strong>Install update</strong><small>Finish dictation first. An approved download also installs on the next normal quit.</small></span>
          <button type="button" className="ls-small-button" disabled={busy} onClick={() => void runAction(true)}>{state.phase === "ready" ? "Restart to update" : "Download and restart"}</button>
        </div>}
      </div>
    </section>
  );
}
