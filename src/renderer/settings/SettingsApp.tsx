import { useEffect, useState } from "react";
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

  useEffect(() => window.localScribe.windows.onNavigate((target) => {
    if (target === "settings") {
      setSettingsOpen(true);
      return;
    }
    setSettingsOpen(false);
    openSection(target);
  }), []);

  useEffect(() => {
    void window.localScribe.system.appInfo().then(setAppInfo).catch(() => undefined);
  }, []);

  return (
    <main className="hub-shell">
      <aside className="hub-sidebar">
        <div className="window-drag-region" aria-hidden="true" />
        <button className="local-brand" onClick={() => openSection("dictation")} aria-label="Open LocalScribe dictation history">
          <span className="local-brand__mark">L</span>
          <span className="local-brand__name">LocalScribe</span>
          <span className="local-brand__local">Local</span>
        </button>

        <nav className="hub-navigation" aria-label="Main navigation">
          {primaryNavigation.map((item) => (
            <button
              key={item.id}
              className={section === item.id ? "hub-nav-item hub-nav-item--active" : "hub-nav-item"}
              onClick={() => openSection(item.id)}
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
          <button className="hub-nav-item" onClick={() => setSettingsOpen(true)}>
            <Icon name="settings" />
            <span>Settings</span>
          </button>
          <p className="hub-version">{appInfo ? `LocalScribe v${appInfo.version}` : "LocalScribe"}</p>
        </div>
      </aside>

      <section className="hub-content" aria-live="polite">
        {section === "dictation" && <HistoryScreen />}
        {section === "insights" && <InsightsScreen />}
        {section === "dictionary" && <DictionaryScreen />}
        {section === "snippets" && <SnippetsScreen />}
        {section === "style" && <StyleScreen />}
        {section === "transforms" && <TransformsScreen />}
      </section>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </main>
  );
}
