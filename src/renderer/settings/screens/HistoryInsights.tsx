import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MAX_HISTORY_ITEMS,
  type AppSettings,
  type Transcription,
} from "../../../shared/contracts";
import {
  shortcutCompactLabel,
} from "../../../shared/shortcuts";
import {
  activityForRange,
  appIdentityKey,
  calculateStreak,
  categoryBreakdown,
  countWords,
  filterByRange,
  friendlyAppName,
  rangeLabel,
  type AppCategoryKey,
  type InsightRange,
} from "../../../shared/insights";
import { rendererSafeErrorMessage } from "../../../shared/rendererErrors";
import { modelFamilyDisplayName } from "../../../shared/modelAvailability";
import "./history-insights.css";

type HistoryState = {
  items: Transcription[];
  skippedUnreadable: number;
  hasLoaded: boolean;
  loading: boolean;
  error: string | null;
};

export function startHistoryRefresh(current: HistoryState): HistoryState {
  // Returning to the window also refreshes history. Keep the last successful
  // result mounted so that a refresh does not discard selection or focus.
  return { ...current, loading: !current.hasLoaded, error: null };
}

type ShortcutRuntimeStatus = "loading" | "unavailable" | "ready";

export function historyShortcutPresentation(
  shortcuts: Pick<AppSettings, "holdShortcut" | "toggleShortcut"> | null,
  status: ShortcutRuntimeStatus,
): { ariaLabel: string; holdLabel: string; toggleLabel: string | null } {
  if (status === "ready" && shortcuts) {
    const holdLabel = shortcutCompactLabel(shortcuts.holdShortcut);
    const toggleLabel = shortcutCompactLabel(shortcuts.toggleShortcut);
    return {
      ariaLabel: `Hold ${holdLabel} to dictate; ${toggleLabel} toggles dictation`,
      holdLabel: `Hold ${holdLabel}`,
      toggleLabel,
    };
  }
  const label = status === "loading"
    ? "Shortcut settings are loading"
    : "Shortcut settings are unavailable";
  return { ariaLabel: label, holdLabel: label, toggleLabel: null };
}

export function historySampleLabel(itemCount: number): string {
  if (itemCount >= MAX_HISTORY_ITEMS) return `Latest ${MAX_HISTORY_ITEMS}`;
  return `${itemCount} saved`;
}

type HistorySavingState = boolean | "loading" | "unavailable";

export function historyStoragePresentation(enabled: HistorySavingState): {
  intro: string;
  status: string;
  emptyTitle: string;
  emptyBody: string;
  insightsEmptyBody: string;
} {
  if (enabled === false) {
    return {
      intro: "Transcript history saving is off. Existing encrypted transcripts remain searchable until removed or expired.",
      status: "History saving off",
      emptyTitle: "Transcript history saving is off",
      emptyBody: "Turn on Save transcript history in Settings to keep completed dictations here.",
      insightsEmptyBody: "Turn on Save transcript history in Settings to build local usage insights.",
    };
  }
  if (enabled === true) {
    return {
      intro: "Your recent words stay searchable and encrypted on this computer.",
      status: "Encrypted history",
      emptyTitle: "Your first dictation will appear here",
      emptyBody: "Use the floating bar or keyboard shortcut whenever you are ready.",
      insightsEmptyBody: "Once you dictate, your local usage patterns will appear here.",
    };
  }
  if (enabled === "loading") {
    return {
      intro: "Checking whether completed dictations are being saved locally.",
      status: "Checking history setting",
      emptyTitle: "Checking history settings",
      emptyBody: "Completed dictation will still be inserted or copied while LocalScribe checks.",
      insightsEmptyBody: "LocalScribe is checking whether future dictations will contribute to Insights.",
    };
  }
  return {
    intro: "Saved transcripts stay searchable and encrypted on this computer.",
    status: "Local encrypted storage",
    emptyTitle: "No saved dictations yet",
    emptyBody: "History settings are unavailable right now; completed dictation will still be inserted or copied.",
    insightsEmptyBody: "History settings are unavailable right now, so future insight collection cannot be confirmed.",
  };
}

export function createLatestRequestGate() {
  let latestRequest = 0;
  return {
    begin(): number {
      latestRequest += 1;
      return latestRequest;
    },
    invalidate(): void {
      latestRequest += 1;
    },
    isLatest(request: number): boolean {
      return request === latestRequest;
    },
  };
}

export function installHistoryFocusRefresh(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  refresh: () => void,
): () => void {
  target.addEventListener("focus", refresh);
  return () => target.removeEventListener("focus", refresh);
}

export function HistoryTranscriptText({
  label,
  text,
}: {
  label: string;
  text: string;
}) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const field = textRef.current;
    if (!field) return;
    const resize = () => {
      field.style.height = "auto";
      field.style.height = `${Math.min(Math.max(field.scrollHeight, 22), 176)}px`;
    };
    resize();
    let lastWidth = field.getBoundingClientRect().width;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - lastWidth) < 0.5) return;
      lastWidth = entry.contentRect.width;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [text]);
  return (
    <textarea
      ref={textRef}
      aria-label={label}
      className="hi-transcript-text"
      readOnly
      spellCheck={false}
      value={text}
    />
  );
}

const SENTENCE_PATTERN = /[^.!?]+[.!?]+|[^.!?]+$/g;
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

const STOP_WORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "but", "by", "can", "do", "for", "from", "had", "has", "have", "he",
  "her", "here", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me",
  "more", "my", "no", "not", "of", "on", "or", "our", "out", "she", "so", "some", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "up", "us", "was", "we", "were",
  "what", "when", "where", "which", "who", "will", "with", "would", "you", "your",
]);

function useLocalHistory(fallbackError: string): readonly [HistoryState, () => Promise<void>] {
  const [{ items, skippedUnreadable, hasLoaded, loading, error }, setHistory] = useState<HistoryState>({
    items: [],
    skippedUnreadable: 0,
    hasLoaded: false,
    loading: true,
    error: null,
  });
  const requestGate = useRef(createLatestRequestGate());

  const load = useCallback(async () => {
    const request = requestGate.current.begin();
    setHistory(startHistoryRefresh);
    try {
      const result = await window.localScribe.history.list(MAX_HISTORY_ITEMS);
      if (!requestGate.current.isLatest(request)) return;
      setHistory({
        items: result.items,
        skippedUnreadable: result.skippedUnreadable,
        hasLoaded: true,
        loading: false,
        error: null,
      });
    } catch (loadError) {
      if (!requestGate.current.isLatest(request)) return;
      setHistory((current) => ({
        ...current,
        loading: false,
        error: historyErrorMessage(loadError, fallbackError),
      }));
    }
  }, [fallbackError]);

  useEffect(() => {
    const gate = requestGate.current;
    void load();
    const unsubscribe = window.localScribe.history.onChanged(() => void load());
    // The durable database is authoritative. If the history window was being
    // created, reloaded, or torn down during the one-shot main-process event,
    // refresh when the user returns instead of leaving Recent dictations stale.
    const removeFocusRefresh = installHistoryFocusRefresh(window, () => void load());
    return () => {
      gate.invalidate();
      unsubscribe();
      removeFocusRefresh();
    };
  }, [load]);

  return [{ items, skippedUnreadable, hasLoaded, loading, error }, load] as const;
}

export function historyIntegrityWarningMessage(skippedUnreadable: number): string | null {
  if (skippedUnreadable === 0) return null;
  return `${skippedUnreadable.toLocaleString()} saved ${skippedUnreadable === 1 ? "record" : "records"} could not be opened. LocalScribe will not overwrite the unreadable records.`;
}

function HistoryIntegrityWarning({ skippedUnreadable }: { skippedUnreadable: number }) {
  const message = historyIntegrityWarningMessage(skippedUnreadable);
  if (!message) return null;
  return (
    <div className="hi-integrity-warning" role="alert">
      <span className="hi-state-icon" aria-hidden="true">!</span>
      <div>
        <strong>Some saved history could not be opened</strong>
        <p>{message}</p>
        <button type="button" className="hi-secondary-button" onClick={() => void window.localScribe.windows.showSettings("data")}>Manage saved data…</button>
      </div>
    </div>
  );
}

export function HistoryScreen({ onOpenSettings, onChooseModel }: { onOpenSettings?: () => void; onChooseModel?: () => void } = {}) {
  const [{ items, skippedUnreadable, loading, error }, load] = useLocalHistory("History could not be loaded.");
  const screenRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState<HistoryNotice | null>(null);
  const [shortcuts, setShortcuts] = useState<Pick<AppSettings, "holdShortcut" | "toggleShortcut"> | null>(null);
  const [shortcutSettingsStatus, setShortcutSettingsStatus] = useState<ShortcutRuntimeStatus>("loading");
  const [historySavingEnabled, setHistorySavingEnabled] = useState<HistorySavingState>("loading");
  const [modelChoice, setModelChoice] = useState<Pick<AppSettings, "activeModelFamilyId" | "asrMode"> | null>(null);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const openMenus = () => [...screen.querySelectorAll<HTMLDetailsElement>(".hi-overflow[open]")];
    const onPointerDown = (event: PointerEvent) => {
      for (const menu of openMenus()) {
        if (event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      for (const menu of openMenus()) {
        if (event.relatedTarget instanceof Node && !menu.contains(event.relatedTarget)) menu.open = false;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSearchOpen(true);
        window.requestAnimationFrame(() => screen.querySelector<HTMLInputElement>(".hi-search input")?.focus());
        return;
      }
      if (event.key === "Escape") {
        if (openMenus().length === 0) {
          setQuery("");
          setSearchOpen(false);
        }
        for (const menu of openMenus()) {
          event.preventDefault();
          menu.open = false;
          menu.querySelector<HTMLElement>("summary")?.focus();
        }
        return;
      }
      if (!(event.target instanceof HTMLElement)) return;
      const menu = event.target.closest<HTMLDetailsElement>(".hi-overflow");
      if (!menu || !screen.contains(menu)) return;
      const controls = [...menu.querySelectorAll<HTMLButtonElement>(".hi-overflow-menu button:not(:disabled)")];
      if (controls.length === 0) return;
      const index = controls.indexOf(event.target as HTMLButtonElement);
      if (event.target.tagName === "SUMMARY" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault();
        menu.open = true;
        controls[event.key === "ArrowDown" ? 0 : controls.length - 1]?.focus();
      } else if (index >= 0 && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) % controls.length;
        controls[next]?.focus();
      }
    };
    const onAction = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const action = event.target.closest(".hi-overflow-menu button");
      if (action) {
        const menu = action.closest<HTMLDetailsElement>("details")!;
        menu.open = false;
        menu.querySelector<HTMLElement>("summary")?.focus();
      }
    };
    const onToggle = (event: Event) => {
      if (!(event.target instanceof HTMLDetailsElement) || !event.target.open || !event.target.classList.contains("hi-overflow")) return;
      const menu = event.target;
      const popup = menu.querySelector<HTMLElement>(".hi-overflow-menu");
      if (!popup) return;
      menu.classList.remove("hi-overflow--below", "hi-overflow--above");
      const viewport = screen.closest(".hub-content")?.getBoundingClientRect();
      const top = Math.max(0, viewport?.top ?? 0) + 8;
      const bottom = Math.min(window.innerHeight, viewport?.bottom ?? window.innerHeight) - 8;
      if (popup.getBoundingClientRect().top < top) menu.classList.add("hi-overflow--below");
      if (popup.getBoundingClientRect().bottom > bottom) {
        menu.classList.remove("hi-overflow--below");
        menu.classList.add("hi-overflow--above");
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    screen.addEventListener("focusout", onFocusOut);
    screen.addEventListener("keydown", onKeyDown);
    screen.addEventListener("click", onAction);
    screen.addEventListener("toggle", onToggle, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      screen.removeEventListener("focusout", onFocusOut);
      screen.removeEventListener("keydown", onKeyDown);
      screen.removeEventListener("click", onAction);
      screen.removeEventListener("toggle", onToggle, true);
    };
  }, []);

  useEffect(() => {
    if (notice?.tone !== "success") return;
    const timeout = window.setTimeout(() => {
      setNotice(current => current === notice ? null : current);
    }, 4000);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const setShortcutSettings = (
      settings: Pick<AppSettings, "holdShortcut" | "toggleShortcut" | "keepHistory" | "activeModelFamilyId" | "asrMode">,
    ) => {
      setShortcuts({
        holdShortcut: settings.holdShortcut,
        toggleShortcut: settings.toggleShortcut,
      });
      setHistorySavingEnabled(settings.keepHistory);
      setModelChoice({ activeModelFamilyId: settings.activeModelFamilyId, asrMode: settings.asrMode });
      setShortcutSettingsStatus("ready");
    };
    let active = true;
    let sawSettingsChange = false;
    const unsubscribe = window.localScribe.settings.onChanged((settings) => {
      if (!active) return;
      sawSettingsChange = true;
      setShortcutSettings(settings);
    });
    void window.localScribe.settings.get().then((settings) => {
      if (active && !sawSettingsChange) setShortcutSettings(settings);
    }).catch(() => {
      if (active && !sawSettingsChange) {
        setShortcutSettingsStatus("unavailable");
        setHistorySavingEnabled("unavailable");
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const shortcutPresentation = historyShortcutPresentation(
    shortcuts,
    shortcutSettingsStatus,
  );
  const storagePresentation = historyStoragePresentation(historySavingEnabled);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) => item.text.toLocaleLowerCase().includes(normalizedQuery));
  }, [items, query]);

  const groups = useMemo(() => groupTranscriptions(filtered), [filtered]);
  const copyText = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(historySuccessNotice(successMessage));
    } catch (copyError) {
      setNotice(historyFailureNotice(copyError, "Could not copy to the clipboard."));
    }
  }, []);

  const remove = useCallback(async (item: Transcription) => {
    if (!window.confirm("Delete this encrypted transcript from this computer?")) return;
    try {
      await window.localScribe.history.delete(item.id);
      setNotice(historySuccessNotice("Transcript deleted."));
    } catch (deleteError) {
      setNotice(historyFailureNotice(deleteError, "The transcript could not be deleted."));
    }
  }, []);

  const clear = useCallback(async () => {
    if (!window.confirm("Delete all encrypted transcript history from this computer? This cannot be undone.")) return;
    try {
      await window.localScribe.history.clear();
      setNotice(historySuccessNotice("Transcript history cleared."));
    } catch (clearError) {
      setNotice(historyFailureNotice(clearError, "History could not be cleared."));
    }
  }, []);

  const exportHistory = useCallback(async () => {
    try {
      const path = await window.localScribe.history.export();
      // A cancelled save panel returns no path; that is not an outcome to
      // report, and it must also not leave a stale failure on screen.
      setNotice(path ? historySuccessNotice("History exported locally.") : null);
    } catch (exportError) {
      setNotice(historyFailureNotice(exportError, "History could not be exported."));
    }
  }, []);

  return (
    <div className="hi-screen hi-history-screen" ref={screenRef}>
      <header className="hi-welcome">
        <div>
          <h1>Dictation</h1>
          {historySavingEnabled !== true && <p>{storagePresentation.intro}</p>}
        </div>
        <div className="hi-header-actions">
          <button
            className="hi-icon-button"
            type="button"
            aria-label={searchOpen ? "Close transcript search" : "Search transcripts"}
            aria-expanded={searchOpen}
            onClick={() => {
              setSearchOpen((open) => !open);
              if (searchOpen) setQuery("");
            }}
          >
            <SearchIcon />
          </button>
          {items.length > 0 && (
            <>
              <button className="hi-secondary-button" type="button" onClick={() => void exportHistory()}>
                <ExportIcon /> Export
              </button>
              <details className="hi-overflow hi-overflow--header" name="history-actions">
                <summary aria-label="More history actions"><MoreIcon /></summary>
                <div className="hi-overflow-menu">
                  <button
                    type="button"
                    disabled={filtered.length === 0}
                    onClick={() => void copyText(filtered.map((item) => item.text).join("\n\n"), "Visible transcripts copied.")}
                  >
                    Copy visible
                  </button>
                  <button className="hi-destructive-action" type="button" onClick={() => void clear()}>
                    Clear history
                  </button>
                </div>
              </details>
            </>
          )}
        </div>
      </header>

      {/*
        * Directly under the header, because that is where Export, Copy visible,
        * and Clear history live, and a failure has to appear where the click
        * happened rather than at the bottom of a scrolled page.
        */}
      <HistoryNoticeSurface notice={notice} onDismiss={() => setNotice(null)} />
      <HistoryIntegrityWarning skippedUnreadable={skippedUnreadable} />

      {searchOpen && (
        <label className="hi-search">
          <SearchIcon />
          <span className="hi-visually-hidden">Search transcript text</span>
          <input
            autoFocus
            aria-label="Search history"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your local transcripts"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>}
        </label>
      )}

      <div className="hi-dictation-status" aria-label="Dictation settings">
        <span aria-label={shortcutPresentation.ariaLabel}>
          {shortcutPresentation.toggleLabel
            ? <>{shortcutPresentation.holdLabel} to talk · {shortcutPresentation.toggleLabel} to toggle</>
            : <span className="hi-shortcut-status" role="status">{shortcutPresentation.holdLabel}</span>}
        </span>
        <span aria-hidden="true">·</span>
        {modelChoice
          ? <button type="button" onClick={onChooseModel} disabled={!onChooseModel}>{modelFamilyDisplayName(modelChoice.activeModelFamilyId)}</button>
          : <span>{shortcutSettingsStatus === "unavailable" ? "Model unavailable" : "Loading model…"}</span>}
        {modelChoice && <span>· {modelChoice.asrMode === "live" ? "Live" : "After I stop"}</span>}
        {onOpenSettings && <button type="button" className="hi-shortcut-edit" onClick={onOpenSettings}>Edit…</button>}
      </div>

      <div className="hi-history-layout">
        <section className="hi-history-feed" aria-label="Dictation history">
          <div className="hi-section-title">
            <div>
              {query && <>
                <h2>Search results</h2>
                <p>{filtered.length} {filtered.length === 1 ? "match" : "matches"}</p>
              </>}
            </div>
            {!loading && items.length > 0 && (
              <span>
                {items.length >= MAX_HISTORY_ITEMS ? `Latest ${MAX_HISTORY_ITEMS}` : `${items.length} total`}
              </span>
            )}
          </div>

          {loading && <HistoryLoading />}
          {!loading && error && (
            <div className="hi-state-card" role="alert">
              <span className="hi-state-icon">!</span>
              <div><strong>{items.length > 0 ? "History could not refresh" : "History is unavailable"}</strong><p>{error}</p></div>
              <button className="hi-secondary-button" type="button" onClick={() => void load()}>Try again</button>
            </div>
          )}
          {!loading && !error && groups.length === 0 && (
            <div className="hi-empty-state">
              <h3>{query ? "No dictations match" : storagePresentation.emptyTitle}</h3>
              <p>{query ? "Try a different word or clear the search." : storagePresentation.emptyBody}</p>
              {query && <button className="hi-secondary-button" type="button" onClick={() => setQuery("")}>Clear search</button>}
            </div>
          )}
          {!loading && groups.map((group) => (
            <section className="hi-day-group" key={group.key} aria-labelledby={`history-${group.key}`}>
              <div className="hi-day-heading">
                <h3 id={`history-${group.key}`}>{group.label}</h3>
                <span>{group.items.length}</span>
              </div>
              <div className="hi-transcript-list">
                {group.items.map((item) => (
                  <article className="hi-transcript-row" key={item.id} tabIndex={0} aria-label={`Dictation from ${formatTime(item.createdAt)}`} onKeyDown={(event) => {
                    if (event.target !== event.currentTarget || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
                    const rows = [...(screenRef.current?.querySelectorAll<HTMLElement>(".hi-transcript-row") ?? [])];
                    const index = rows.indexOf(event.currentTarget);
                    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
                    if (next) { event.preventDefault(); next.focus(); }
                  }}>
                    <div className="hi-transcript-time">
                      <time dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
                      <span>{formatDuration(item.durationMs)}</span>
                    </div>
                    <div className="hi-transcript-body">
                      <HistoryTranscriptText
                        label={`Transcript from ${formatTime(item.createdAt)}`}
                        text={item.text}
                      />
                      <div className="hi-transcript-meta">
                        <span>{countWords(item.text)} words</span>
                        <span aria-hidden="true">·</span>
                        <span>{friendlyAppName(item.sourceAppId)}</span>
                      </div>
                    </div>
                    <button
                      className="hi-row-action"
                      type="button"
                      aria-label="Copy transcript"
                      onClick={() => void copyText(item.text, "Transcript copied.")}
                    >
                      <CopyIcon />
                    </button>
                    <details className="hi-overflow hi-overflow--row" name="history-actions">
                      <summary aria-label="More transcript actions"><MoreIcon /></summary>
                      <div className="hi-overflow-menu">
                        <button type="button" onClick={() => void copyText(item.text, "Transcript copied.")}>Copy text</button>
                        <button className="hi-destructive-action" type="button" onClick={() => void remove(item)}>Delete</button>
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </section>
      </div>
    </div>
  );
}

export function InsightsScreen() {
  const [{ items, skippedUnreadable, loading, error }, load] = useLocalHistory("Insights could not be calculated.");
  const [range, setRange] = useState<InsightRange>("30d");
  const [historySavingEnabled, setHistorySavingEnabled] = useState<HistorySavingState>("loading");

  useEffect(() => {
    let active = true;
    let sawSettingsChange = false;
    const apply = (settings: AppSettings) => {
      if (active) setHistorySavingEnabled(settings.keepHistory);
    };
    const unsubscribe = window.localScribe.settings.onChanged((settings) => {
      sawSettingsChange = true;
      apply(settings);
    });
    void window.localScribe.settings.get().then((settings) => {
      if (!sawSettingsChange) apply(settings);
    }).catch(() => {
      if (active && !sawSettingsChange) setHistorySavingEnabled("unavailable");
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const rangedItems = useMemo(() => filterByRange(items, range), [items, range]);
  const stats = useMemo(() => summarizeTranscriptions(rangedItems), [rangedItems]);
  const categories = useMemo(() => categoryBreakdown(rangedItems), [rangedItems]);
  const activity = useMemo(() => activityForRange(rangedItems, range), [rangedItems, range]);
  const voice = useMemo(() => summarizeWriting(rangedItems), [rangedItems]);
  const storagePresentation = historyStoragePresentation(historySavingEnabled);
  return (
    <div className="hi-screen hi-insights-screen">
      <header className="hi-insights-header">
        <div>
          <h1>Insights</h1>
        </div>
      </header>

      <HistoryIntegrityWarning skippedUnreadable={skippedUnreadable} />

      {!loading && !error && (
        <div className="hi-period-row">
          <span>Insight period</span>
          <RangeControl range={range} onChange={setRange} />
        </div>
      )}

      {loading && <InsightsLoading />}
      {!loading && error && (
        <div className="hi-state-card hi-state-card--wide" role="alert">
          <span className="hi-state-icon">!</span>
          <div><strong>Insights are unavailable</strong><p>{error}</p></div>
          <button className="hi-secondary-button" type="button" onClick={() => void load()}>Try again</button>
        </div>
      )}

      <section
        aria-label="Usage and writing measurements"
        aria-busy={loading}
        className="hi-insight-panel"
      >
        {!loading && (!error || items.length > 0) && (
          rangedItems.length === 0 ? (
            <div className="hi-empty-state hi-empty-state--insights">
              <h2>No activity in this period</h2>
              <p>{storagePresentation.insightsEmptyBody}</p>
            </div>
          ) : (
            <>
              <div className="hi-usage-summary">
                <MetricCard
                  value={formatNumber(stats.words)}
                  label="Words dictated"
                  detail={`${rangedItems.length} ${rangedItems.length === 1 ? "session" : "sessions"}`}
                />
                <MetricCard value={String(stats.wpm || "—")} label="Average WPM" detail="Based on audio duration" />
                <MetricCard value={formatDuration(stats.durationMs)} label="Time dictated" detail={`${formatNumber(stats.characters)} characters`} />
                <MetricCard value={String(stats.appCount)} label="Apps used" detail={`${calculateStreak(rangedItems)} day streak`} />
              </div>

              <div className="hi-insights-grid">
                <section className="hi-insight-card hi-activity-card">
                  <div className="hi-card-heading">
                    <div><h2>Words over time</h2></div>
                    <span>{formatNumber(stats.words)} total</span>
                  </div>
                  <ActivityChart points={activity} />
                </section>
                <section className="hi-insight-card hi-category-card">
                  <div className="hi-card-heading">
                    <div><h2>App categories</h2></div>
                  </div>
                  <CategoryList categories={categories} />
                </section>
              </div>
              <section className="hi-writing-section" aria-labelledby="writing-heading">
                <h2 id="writing-heading">Writing</h2>
                <dl className="hi-writing-measures">
                  <div><dt>Speaking pace</dt><dd>{stats.wpm ? `${stats.wpm} wpm` : "Not measured"}</dd></div>
                  <div><dt>Sentence length</dt><dd>{voice.averageSentenceWords} words</dd></div>
                  <div><dt>Word variety</dt><dd>{voice.uniquePercent}% unique</dd></div>
                </dl>
                <p className="hi-profile-disclosure">Calculated from word counts, sentence lengths and audio duration in your saved dictations.</p>
                <h3>Frequent words</h3>
                <div className="hi-word-cloud">
                  {voice.frequentWords.length > 0
                    ? voice.frequentWords.map((entry) => <span key={entry.word}>{entry.word}<small>{entry.count}</small></span>)
                    : <p>More words are needed for this summary.</p>}
                </div>
              </section>

            </>
          )
        )}
      </section>
    </div>
  );
}

function HistoryLoading() {
  return <div className="hi-loading" aria-label="Loading transcript history" aria-busy="true">{[0, 1, 2].map((item) => <span key={item} />)}</div>;
}

function InsightsLoading() {
  return <div className="hi-loading hi-loading--insights" aria-label="Calculating local insights" aria-busy="true">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function MetricCard({ value, label, detail }: { value: string; label: string; detail: string }) {
  return (
    <article className="hi-metric-card">
      <strong>{value}</strong>
      <h2>{label}</h2>
      <p>{detail}</p>
    </article>
  );
}

function RangeControl({ range, onChange }: { range: InsightRange; onChange(range: InsightRange): void }) {
  return (
    <div className="hi-range-control" role="group" aria-label="Insight period">
      {(["7d", "30d", "recent"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={range === option}
          className={range === option ? "hi-range-button hi-range-button--active" : "hi-range-button"}
          onClick={() => onChange(option)}
        >{rangeLabel(option)}</button>
      ))}
    </div>
  );
}

export function CategoryList({ categories }: { categories: ReturnType<typeof categoryBreakdown> }) {
  if (categories.length === 0) return <p className="hi-card-empty">App information will appear after your first dictation.</p>;
  return (
    <div className="hi-category-list" role="list" aria-label="App categories by share of dictated words">
      {categories.map((category) => (
        <div className="hi-category-row" role="listitem" key={category.key}>
          <span className={`hi-category-icon hi-category-icon--${category.key}`} aria-hidden="true"><CategoryIcon category={category.key} /></span>
          <div>
            <span>{category.label}</span>
            <small>{category.count} {category.count === 1 ? "session" : "sessions"} · {formatNumber(category.words)} words</small>
            <div aria-hidden="true"><i style={{ width: `${Math.max(category.percent, category.words > 0 ? 1 : 0)}%` }} /></div>
          </div>
          <strong>
            <span className="hi-visually-hidden">Share of dictated words: </span>
            {category.percent === 0 && category.words > 0 ? "<1%" : `${category.percent}%`}
          </strong>
        </div>
      ))}
    </div>
  );
}

export function activityBarHeightPercent(wordCount: number, maximum: number): number {
  if (wordCount <= 0 || maximum <= 0) return 0;
  return Math.max((wordCount / maximum) * 100, 5);
}

export function ActivityChart({ points }: { points: ReturnType<typeof activityForRange> }) {
  const maximum = Math.max(...points.map((point) => point.words), 1);
  const edgePointCount = points.length >= 20 ? 5 : 1;
  return (
    <div className="hi-chart" role="group" aria-label="Dictated words over time">
      <div className="hi-chart-grid" aria-hidden="true"><span /><span /><span /></div>
      <div className="hi-chart-bars">
        {points.map((point, index) => {
          const tooltipId = `hi-chart-tooltip-${point.key.replace(/[^a-z0-9_-]/giu, "-")}`;
          const edge = index < edgePointCount
            ? "start"
            : index >= points.length - edgePointCount
              ? "end"
              : undefined;
          return (
            <div
              className="hi-chart-column"
              data-edge={edge}
              key={point.key}
              role="img"
              tabIndex={0}
              aria-label={point.fullLabel}
              aria-describedby={tooltipId}
            >
              <span className="hi-chart-tooltip" id={tooltipId} role="tooltip">
                <strong>{formatNumber(point.words)} {point.words === 1 ? "word" : "words"}</strong>
                <small>{point.fullLabel}</small>
              </span>
              <i aria-hidden="true" style={{ height: `${activityBarHeightPercent(point.words, maximum)}%` }} />
              <span className="hi-chart-label" aria-hidden="true">{point.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(WORD_PATTERN) ?? []).map((word) => word.replace("’", "'"));
}

export function summarizeTranscriptions(items: Transcription[]) {
  const wordCount = items.reduce((total, item) => total + countWords(item.text), 0);
  const durationMs = items.reduce((total, item) => total + item.durationMs, 0);
  const minutes = durationMs / 60_000;
  const appIds = new Set(items.flatMap((item) => {
    const identity = appIdentityKey(item.sourceAppId);
    return identity ? [identity] : [];
  }));
  return {
    words: wordCount,
    durationMs,
    characters: items.reduce((total, item) => total + item.text.length, 0),
    appCount: appIds.size,
    wpm: minutes > 0 ? Math.round(wordCount / minutes) : 0,
  };
}

function groupTranscriptions(items: Transcription[]) {
  const groups = new Map<string, { key: string; label: string; items: Transcription[] }>();
  [...items].sort((a, b) => b.createdAt - a.createdAt).forEach((item) => {
    const key = dateKey(item.createdAt);
    const current = groups.get(key) ?? { key, label: friendlyDate(item.createdAt), items: [] };
    current.items.push(item);
    groups.set(key, current);
  });
  return [...groups.values()];
}

function dateKey(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/*
 * Every history row formats a timestamp, and the list re-renders on each
 * keystroke in the search field. Constructing an Intl formatter costs ~22.6us
 * against ~0.45us to reuse one (measured on this machine's ICU), so a 1,000-row
 * history spent ~23ms per render building formatters it immediately discarded.
 * The locale is read once: the renderer would have to reload to see a different
 * one anyway.
 */
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const standardNumberFormat = new Intl.NumberFormat(undefined, { notation: "standard", maximumFractionDigits: 1 });
const compactNumberFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

function friendlyDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(timestamp) === dateKey(today.getTime())) return "Today";
  if (dateKey(timestamp) === dateKey(yesterday.getTime())) return "Yesterday";
  return dayFormat.format(date);
}

function formatTime(timestamp: number): string {
  return timeFormat.format(new Date(timestamp));
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function formatNumber(value: number): string {
  return (value >= 10_000 ? compactNumberFormat : standardNumberFormat).format(value);
}

export function historyErrorMessage(error: unknown, fallback: string): string {
  return rendererSafeErrorMessage(error, fallback);
}

/*
 * Copy, delete, clear, and export all reported their outcome by writing a
 * string into a `.hi-live-region` paragraph, and that class is
 * `position: fixed; left: -9999px`. A sighted user who clicked Delete and hit a
 * locked database saw the row stay exactly where it was and got no explanation
 * anywhere in the window — the message existed, it was just parked off-screen.
 * Failures remain in the layout; successes appear in a transient polite toast.
 */
export type HistoryNotice = { message: string; tone: "success" | "error" };

export function historySuccessNotice(message: string): HistoryNotice {
  return { message, tone: "success" };
}

export function historyFailureNotice(error: unknown, fallback: string): HistoryNotice {
  return { message: historyErrorMessage(error, fallback), tone: "error" };
}

export function HistoryNoticeSurface({
  notice,
  onDismiss,
}: {
  notice: HistoryNotice | null;
  onDismiss(): void;
}) {
  return (
    <>
      {notice?.tone === "error" && (
        <div className="hi-state-card hi-action-notice" role="alert">
          <span className="hi-state-icon">!</span>
          <div><strong>That did not go through</strong><p>{notice.message}</p></div>
          <button className="hi-secondary-button" type="button" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
      {/*
        * Errors are announced by the role="alert" above; repeating them here
        * would make a screen reader say them twice.
        */}
      <p className={notice?.tone === "success" ? "hi-success-toast" : "hi-live-region"} role="status" aria-live="polite">
        {notice?.tone === "success" ? notice.message : ""}
      </p>
    </>
  );
}

export function summarizeWriting(items: Transcription[]) {
  const allWords = items.flatMap((item) => words(item.text));
  const uniqueWords = new Set(allWords);
  const uniquePercent = allWords.length > 0 ? Math.round((uniqueWords.size / allWords.length) * 100) : 0;
  const sentenceCount = items.reduce((total, item) => total + (item.text.match(SENTENCE_PATTERN)?.filter((sentence) => sentence.trim()).length ?? 0), 0);
  const averageSentenceWords = sentenceCount > 0 ? Math.max(1, Math.round(allWords.length / sentenceCount)) : allWords.length;

  const counts = new Map<string, number>();
  allWords.filter((word) => word.length > 2 && !STOP_WORDS.has(word)).forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1));
  const frequentWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));

  return { averageSentenceWords, uniquePercent, frequentWords };
}

function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>; }
function ExportIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m0-10L6.5 5.5M10 2l3.5 3.5M4 10v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" /></svg>; }
function MoreIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="16" cy="10" r="1" /></svg>; }
function CopyIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="10" height="10" rx="2" /><path d="M14 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1" /></svg>; }
function CategoryIcon({ category }: { category: AppCategoryKey }) {
  if (category === "personal" || category === "work") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v9H9l-4 3v-3H4V4Z" /></svg>;
  if (category === "ai") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3h6M10 3v14m-3 0h6M3 7h3m-3 3h3m-3 3h3" /></svg>;
  if (category === "email") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.5" /><path d="m4 6 6 5 6-5" /></svg>;
  if (category === "development") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5-4 5 4 5m6-10 4 5-4 5m-2-12L9 17" /></svg>;
  if (category === "browser") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z" /></svg>;
  if (category === "documents") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3V17.5H5Z" /><path d="M12 2.5v3h3M8 9h4m-4 3h4" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2" /><path d="M10 3v2m0 10v2M3 10h2m10 0h2M5 5l1.5 1.5m7 7L15 15M15 5l-1.5 1.5m-7 7L5 15" /></svg>;
}
