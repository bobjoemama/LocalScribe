import { useCallback, useEffect, useRef, useState } from "react";
import type { AppInfo, NavigationTarget } from "../../shared/contracts";
import { HistoryScreen, InsightsScreen } from "./screens/HistoryInsights";
import { DictionaryScreen, SnippetsScreen } from "./screens/LibraryNotes";
import { CleanupScreen, ModelsScreen, SettingsModal, type SettingsTab } from "./screens/StyleSettings";

type Section = "dictation" | "insights" | "dictionary" | "snippets" | "cleanup" | "models";
type NavigationSection = Section | "scratchpad";

const primaryNavigation: Array<{ id: NavigationSection; label: string }> = [
  { id: "dictation", label: "Dictation" },
  { id: "insights", label: "Insights" },
  { id: "scratchpad", label: "Notes" },
  { id: "dictionary", label: "Dictionary" },
  { id: "snippets", label: "Snippets" },
  { id: "cleanup", label: "Cleanup" },
  { id: "models", label: "Models" },
];

export function navigationSection(target: NavigationTarget): NavigationSection | null {
  if (target === "style" || target === "transforms") return "cleanup";
  if (target === "settings" || target === "data") return null;
  return target;
}

export function SettingsApp() {
  const [section, setSection] = useState<Section>("dictation");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [dataRevision, setDataRevision] = useState(0);

  // Model operations publish the same live guard whether shown as a page or dialog.
  const dismissalGate = useRef<(() => boolean) | null>(null);
  const modelPageGate = useRef<(() => boolean) | null>(null);
  const registerDismissalGate = useCallback((gate: (() => boolean) | null) => { dismissalGate.current = gate; }, []);
  const registerModelPageGate = useCallback((gate: (() => boolean) | null) => { modelPageGate.current = gate; }, []);

  const openSection = useCallback((target: NavigationSection) => {
    if (dismissalGate.current && !dismissalGate.current()) return;
    if (modelPageGate.current && !modelPageGate.current()) return;
    setSettingsOpen(false);
    if (target === "scratchpad") {
      void window.localScribe.windows.showSettings("scratchpad");
      return;
    }
    setSection(target);
  }, []);

  const openSettings = useCallback((tab: SettingsTab = "general") => {
    if (modelPageGate.current && !modelPageGate.current()) return;
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  useEffect(() => window.localScribe.windows.onNavigate((target) => {
    const destination = navigationSection(target);
    if (!destination) { openSettings(target === "data" ? "privacy" : "general"); return; }
    openSection(destination);
  }), [openSection, openSettings]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key === ",") { event.preventDefault(); openSettings(); return; }
      if (settingsOpen) return;
      const entry = primaryNavigation[Number(event.key) - 1];
      if (/^[1-7]$/.test(event.key) && entry) { event.preventDefault(); openSection(entry.id); return; }
      if (event.key.toLowerCase() === "f") {
        const content = document.querySelector<HTMLElement>(".hub-content");
        const search = content?.querySelector<HTMLInputElement>('input[type="search"], input[placeholder^="Search"]');
        if (search) { event.preventDefault(); search.focus(); }
        else content?.querySelector<HTMLButtonElement>('button[aria-label="Search transcripts"]')?.click();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [settingsOpen, openSection, openSettings]);

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
          <span className="local-brand__name">LocalScribe</span>
        </button>

        <nav className="hub-navigation" aria-label="Main navigation">
          {primaryNavigation.map((item) => (
            <div className="hub-nav-entry" key={item.id}>
              <button
                type="button"
                className={section === item.id ? "hub-nav-item hub-nav-item--active" : "hub-nav-item"}
                onClick={() => openSection(item.id)}
                aria-current={section === item.id ? "page" : undefined}
              >
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </nav>

        <div className="hub-sidebar__bottom">
          <button
            className="hub-nav-item"
            type="button"
            onClick={() => openSettings()}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
          >
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
      <section className="hub-content" inert={settingsOpen} key={dataRevision}>
        {section === "dictation" && <HistoryScreen
          onOpenSettings={() => openSettings()}
          onChooseModel={() => openSection("models")}
        />}
        {section === "insights" && <InsightsScreen />}
        {section === "dictionary" && <DictionaryScreen />}
        {section === "snippets" && <SnippetsScreen />}
        {section === "cleanup" && <CleanupScreen onOpenDictionary={() => openSection("dictionary")} />}
        {section === "models" && <ModelsScreen registerDismissalGate={registerModelPageGate} />}
      </section>

      {settingsOpen && (
        <SettingsModal
          initialTab={settingsInitialTab}
          onSavedDataReset={() => setDataRevision((value) => value + 1)}
          onClose={() => setSettingsOpen(false)}
          registerDismissalGate={registerDismissalGate}
        />
      )}
    </main>
  );
}
