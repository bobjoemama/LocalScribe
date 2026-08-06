import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo } from "../../shared/contracts";
import { HistoryScreen, InsightsScreen } from "./screens/HistoryInsights";
import { DictionaryScreen, SnippetsScreen } from "./screens/LibraryNotes";
import { SettingsModal, StyleScreen, TransformsScreen } from "./screens/StyleSettings";
import { Icon, type IconName } from "./icons";

type Section =
  | "dictation"
  | "insights"
  | "dictionary"
  | "snippets"
  | "style"
  | "transforms"
  | "scratchpad";

const primaryNavigation: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: "dictation", label: "Dictation", icon: "mic" },
  { id: "insights", label: "Insights", icon: "chart" },
  { id: "dictionary", label: "Dictionary", icon: "book" },
  { id: "snippets", label: "Snippets", icon: "scissors" },
  { id: "style", label: "Style", icon: "type" },
  { id: "transforms", label: "Transforms", icon: "wand" },
  { id: "scratchpad", label: "Scratchpad", icon: "note" },
];

export function SettingsApp() {
  const [section, setSection] = useState<Section>("dictation");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  const openSection = (target: Section) => {
    if (target === "scratchpad") {
      void window.localScribe.windows.showSettings("scratchpad");
      return;
    }
    setSection(target);
  };

  /*
   * The dialog publishes its own dismissal gate here. Navigation used to close
   * the dialog unconditionally, which meant every tray entry could unmount it
   * in the middle of a model apply or install — the one path that bypassed the
   * guard `closeSettings` already had. A refused dismissal leaves the hub on
   * its current section too, because navigating behind a dialog that stayed
   * open only makes the refusal harder to understand.
   */
  const dismissalGate = useRef<(() => boolean) | null>(null);
  const registerDismissalGate = useCallback((gate: (() => boolean) | null) => {
    dismissalGate.current = gate;
  }, []);

  useEffect(() => window.localScribe.windows.onNavigate((target) => {
    if (target === "settings") {
      setSettingsOpen(true);
      return;
    }
    // The gate is null whenever the dialog is closed, so this is a no-op then.
    if (dismissalGate.current && !dismissalGate.current()) return;
    setSettingsOpen(false);
    openSection(target);
  }), []);

  useEffect(() => {
    void window.localScribe.system.appInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  return (
    <main className="hub-shell">
      {/*
        * The settings dialog says aria-modal="true". `inert` is what makes that
        * claim true for the keyboard as well as for assistive technology:
        * without it the hub's navigation stayed in the tab order behind the
        * backdrop, so Tab walked out of the modal and into content the dialog
        * had just declared unavailable.
        */}
      <aside className="hub-sidebar" inert={settingsOpen}>
        <div className="window-drag-region" aria-hidden="true" />
        <button type="button" className="local-brand" onClick={() => openSection("dictation")} aria-label="Open LocalScribe dictation history">
          <span className="local-brand__mark">L</span>
          <span className="local-brand__name">LocalScribe</span>
          <span className="local-brand__local">Local</span>
        </button>

        <nav className="hub-navigation" aria-label="Main navigation">
          {primaryNavigation.map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "hub-nav-item hub-nav-item--active" : "hub-nav-item"}
              onClick={() => openSection(item.id)}
              aria-current={section === item.id ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="hub-sidebar__bottom">
          <div className="local-status" aria-label="Local-only processing enabled">
            <span className="local-status__dot" />
            <span><strong>Local only</strong><small>No audio uploads</small></span>
          </div>
          <button
            className="hub-nav-item"
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
            <Icon name="settings" />
            <span>Settings</span>
          </button>
          <p className="hub-version">{appInfo ? `LocalScribe v${appInfo.version}` : "LocalScribe"}</p>
        </div>
      </aside>

      {/*
        * Deliberately not a live region. `aria-live="polite"` here wrapped all
        * six screens, so VoiceOver re-read the entire filtered history on every
        * search keystroke and spoke a whole screen on every sidebar
        * navigation — and double-announced the role="alert" card in
        * HistoryInsights, which blanks its own polite paragraph specifically to
        * avoid that. Each screen already announces its own changes through
        * targeted role="status" / role="alert" / aria-live elements; that is
        * where an announcement can say what actually changed.
        */}
      <section className="hub-content" inert={settingsOpen}>
        {section === "dictation" && <HistoryScreen />}
        {section === "insights" && <InsightsScreen />}
        {section === "dictionary" && <DictionaryScreen />}
        {section === "snippets" && <SnippetsScreen />}
        {section === "style" && <StyleScreen />}
        {section === "transforms" && <TransformsScreen />}
      </section>

      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          registerDismissalGate={registerDismissalGate}
        />
      )}
    </main>
  );
}
