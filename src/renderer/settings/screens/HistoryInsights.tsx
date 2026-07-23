import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_SETTINGS,
  MAX_HISTORY_ITEMS,
  type AppSettings,
  type Transcription,
} from "../../../shared/contracts";
import { shortcutCompactLabel } from "../../../shared/shortcuts";
import {
  activityForRange,
  calculateStreak,
  categoryBreakdown,
  countWords,
  filterByRange,
  friendlyAppName,
  rangeLabel,
  type AppCategoryKey,
  type InsightRange,
} from "../../../shared/insights";
import "./history-insights.css";

type HistoryState = {
  items: Transcription[];
  loading: boolean;
  error: string | null;
};

type InsightTab = "usage" | "voice";

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

export function HistoryScreen() {
  const [{ items, loading, error }, setHistory] = useState<HistoryState>({
    items: [],
    loading: true,
    error: null,
  });
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [shortcuts, setShortcuts] = useState<Pick<AppSettings, "holdShortcut" | "toggleShortcut">>({
    holdShortcut: DEFAULT_SETTINGS.holdShortcut,
    toggleShortcut: DEFAULT_SETTINGS.toggleShortcut,
  });

  const load = useCallback(async () => {
    setHistory((current) => ({ ...current, loading: true, error: null }));
    try {
      const nextItems = await window.localScribe.history.list(MAX_HISTORY_ITEMS);
      setHistory({ items: nextItems, loading: false, error: null });
    } catch (loadError) {
      setHistory((current) => ({
        ...current,
        loading: false,
        error: readableError(loadError, "History could not be loaded."),
      }));
    }
  }, []);

  useEffect(() => {
    void load();
    return window.localScribe.history.onChanged(() => void load());
  }, [load]);

  useEffect(() => {
    const setShortcutSettings = (settings: Pick<AppSettings, "holdShortcut" | "toggleShortcut">) => {
      setShortcuts({
        holdShortcut: settings.holdShortcut,
        toggleShortcut: settings.toggleShortcut,
      });
    };
    void window.localScribe.settings.get().then(setShortcutSettings).catch(() => undefined);
    return window.localScribe.settings.onChanged(setShortcutSettings);
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return items;
    return items.filter((item) => item.text.toLocaleLowerCase().includes(normalizedQuery));
  }, [items, query]);

  const groups = useMemo(() => groupTranscriptions(filtered), [filtered]);
  const allStats = useMemo(() => summarize(items), [items]);
  const todayItems = useMemo(() => items.filter((item) => isToday(item.createdAt)), [items]);
  const todayStats = useMemo(() => summarize(todayItems), [todayItems]);
  const primaryCategory = useMemo(() => categoryBreakdown(items)[0]?.label ?? "No apps yet", [items]);

  const copyText = useCallback(async (text: string, successMessage: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(successMessage);
    } catch (copyError) {
      setNotice(readableError(copyError, "Could not copy to the clipboard."));
    }
  }, []);

  const remove = useCallback(async (item: Transcription) => {
    if (!window.confirm("Delete this encrypted transcript from this computer?")) return;
    try {
      await window.localScribe.history.delete(item.id);
      setNotice("Transcript deleted.");
    } catch (deleteError) {
      setNotice(readableError(deleteError, "The transcript could not be deleted."));
    }
  }, []);

  const clear = useCallback(async () => {
    if (!window.confirm("Delete all encrypted transcript history from this computer? This cannot be undone.")) return;
    try {
      await window.localScribe.history.clear();
      setNotice("Transcript history cleared.");
    } catch (clearError) {
      setNotice(readableError(clearError, "History could not be cleared."));
    }
  }, []);

  const exportHistory = useCallback(async () => {
    try {
      const path = await window.localScribe.history.export();
      if (path) setNotice("History exported locally.");
    } catch (exportError) {
      setNotice(readableError(exportError, "History could not be exported."));
    }
  }, []);

  return (
    <div className="hi-screen hi-history-screen">
      <header className="hi-welcome">
        <div>
          <p className="hi-eyebrow">Dictation</p>
          <h1>Welcome back</h1>
          <p>Your recent words stay searchable and encrypted on this computer.</p>
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
          <button className="hi-secondary-button" type="button" onClick={() => void exportHistory()}>
            <ExportIcon /> Export
          </button>
          <details className="hi-overflow hi-overflow--header">
            <summary aria-label="More history actions"><MoreIcon /></summary>
            <div className="hi-overflow-menu">
              <button
                type="button"
                disabled={filtered.length === 0}
                onClick={() => void copyText(filtered.map((item) => item.text).join("\n\n"), "Visible transcripts copied.")}
              >
                Copy visible
              </button>
              <button className="hi-destructive-action" type="button" disabled={items.length === 0} onClick={() => void clear()}>
                Clear history
              </button>
            </div>
          </details>
        </div>
      </header>

      {searchOpen && (
        <label className="hi-search">
          <SearchIcon />
          <span className="hi-visually-hidden">Search transcript text</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search your local transcripts"
          />
          {query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search">×</button>}
        </label>
      )}

      <section className="hi-local-hero" aria-labelledby="hi-local-hero-title">
        <div className="hi-local-hero__glow" aria-hidden="true"><span>L</span></div>
        <div className="hi-local-hero__copy">
          <span className="hi-local-chip"><span /> Private by design</span>
          <h2 id="hi-local-hero-title">Your voice stays close to home.</h2>
          <p>LocalScribe turns speech into text on this computer. Raw recordings are discarded after each transcription.</p>
          <div className="hi-hero-meta">
            <span><ShieldIcon /> Local model</span>
            <span><LockIcon /> Encrypted history</span>
          </div>
        </div>
        <div
          className="hi-shortcut-card"
          aria-label={`Hold ${shortcutCompactLabel(shortcuts.holdShortcut)} to dictate; ${shortcutCompactLabel(shortcuts.toggleShortcut)} toggles dictation`}
        >
          <span>Start dictating anywhere</span>
          <div>
            <kbd>Hold {shortcutCompactLabel(shortcuts.holdShortcut)}</kbd>
            <span>or</span>
            <kbd>{shortcutCompactLabel(shortcuts.toggleShortcut)}</kbd>
          </div>
        </div>
      </section>

      <div className="hi-history-layout">
        <main className="hi-history-feed">
          <div className="hi-section-title">
            <div>
              <h2>{query ? "Search results" : "Recent dictations"}</h2>
              <p>{query ? `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}` : "Saved locally"}</p>
            </div>
            {!loading && items.length > 0 && <span>{items.length} total</span>}
          </div>

          {loading && <HistoryLoading />}
          {!loading && error && (
            <div className="hi-state-card" role="alert">
              <span className="hi-state-icon">!</span>
              <div><strong>We hit a local snag</strong><p>{error}</p></div>
              <button className="hi-secondary-button" type="button" onClick={() => void load()}>Try again</button>
            </div>
          )}
          {!loading && !error && groups.length === 0 && (
            <div className="hi-empty-state">
              <div className="hi-empty-mark">L</div>
              <h3>{query ? "No dictations match" : "Your first dictation will appear here"}</h3>
              <p>{query ? "Try a different word or clear the search." : "Use the floating bar or keyboard shortcut whenever you are ready."}</p>
              {query && <button className="hi-secondary-button" type="button" onClick={() => setQuery("")}>Clear search</button>}
            </div>
          )}
          {!loading && !error && groups.map((group) => (
            <section className="hi-day-group" key={group.key} aria-labelledby={`history-${group.key}`}>
              <div className="hi-day-heading">
                <h3 id={`history-${group.key}`}>{group.label}</h3>
                <span>{group.items.length}</span>
              </div>
              <div className="hi-transcript-list">
                {group.items.map((item) => (
                  <article className="hi-transcript-row" key={item.id}>
                    <div className="hi-transcript-time">
                      <time dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
                      <span>{formatDuration(item.durationMs)}</span>
                    </div>
                    <div className="hi-transcript-body">
                      <p>{item.text}</p>
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
                    <details className="hi-overflow hi-overflow--row">
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
        </main>

        <aside className="hi-history-aside" aria-label="Dictation statistics">
          <section className="hi-aside-card">
            <div className="hi-aside-card__title"><h2>Today</h2><span className="hi-dot-status"><span /> Local</span></div>
            <div className="hi-stat-pair">
              <Stat value={formatNumber(todayStats.words)} label="words" />
              <Stat value={formatDuration(todayStats.durationMs)} label="dictated" />
            </div>
            <div className="hi-progress-row">
              <span>Sessions</span><strong>{todayItems.length}</strong>
            </div>
          </section>
          <section className="hi-aside-card">
            <div className="hi-aside-card__title"><h2>Your rhythm</h2><span>Recent {MAX_HISTORY_ITEMS}</span></div>
            <div className="hi-large-stat"><strong>{allStats.wpm || "—"}</strong><span>average words per minute</span></div>
            <div className="hi-mini-rows">
              <div><span>Active streak</span><strong>{calculateStreak(items)} {calculateStreak(items) === 1 ? "day" : "days"}</strong></div>
              <div><span>Most-used category</span><strong>{primaryCategory}</strong></div>
              <div><span>Time dictated</span><strong>{formatDuration(allStats.durationMs)}</strong></div>
            </div>
          </section>
          <section className="hi-privacy-note">
            <LockIcon />
            <div><strong>Only you can see this</strong><p>These statistics are calculated from encrypted history on your device.</p></div>
          </section>
        </aside>
      </div>
      <p className="hi-live-region" aria-live="polite">{notice}</p>
    </div>
  );
}

export function InsightsScreen() {
  const [{ items, loading, error }, setHistory] = useState<HistoryState>({
    items: [],
    loading: true,
    error: null,
  });
  const [tab, setTab] = useState<InsightTab>("usage");
  const [range, setRange] = useState<InsightRange>("30d");

  const load = useCallback(async () => {
    setHistory((current) => ({ ...current, loading: true, error: null }));
    try {
      const nextItems = await window.localScribe.history.list(MAX_HISTORY_ITEMS);
      setHistory({ items: nextItems, loading: false, error: null });
    } catch (loadError) {
      setHistory((current) => ({
        ...current,
        loading: false,
        error: readableError(loadError, "Insights could not be calculated."),
      }));
    }
  }, []);

  useEffect(() => {
    void load();
    return window.localScribe.history.onChanged(() => void load());
  }, [load]);

  const rangedItems = useMemo(() => filterByRange(items, range), [items, range]);
  const stats = useMemo(() => summarize(rangedItems), [rangedItems]);
  const categories = useMemo(() => categoryBreakdown(rangedItems), [rangedItems]);
  const activity = useMemo(() => activityForRange(rangedItems, range), [rangedItems, range]);
  const voice = useMemo(() => createVoiceProfile(rangedItems), [rangedItems]);

  return (
    <div className="hi-screen hi-insights-screen">
      <header className="hi-insights-header">
        <div>
          <p className="hi-eyebrow">Insights</p>
          <h1>Your speaking patterns</h1>
          <p>A private, local view of how you use dictation.</p>
        </div>
        <span className="hi-local-chip"><span /> Calculated locally</span>
      </header>

      <div className="hi-tabs" role="tablist" aria-label="Insight views">
        <button
          id="usage-tab"
          type="button"
          role="tab"
          aria-selected={tab === "usage"}
          aria-controls="usage-panel"
          className={tab === "usage" ? "hi-tab hi-tab--active" : "hi-tab"}
          onClick={() => setTab("usage")}
        >Usage</button>
        <button
          id="voice-tab"
          type="button"
          role="tab"
          aria-selected={tab === "voice"}
          aria-controls="voice-panel"
          className={tab === "voice" ? "hi-tab hi-tab--active" : "hi-tab"}
          onClick={() => setTab("voice")}
        >Voice profile</button>
      </div>

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

      {!loading && !error && tab === "usage" && (
        <section id="usage-panel" role="tabpanel" aria-labelledby="usage-tab" className="hi-insight-panel">
          {rangedItems.length === 0 ? (
            <div className="hi-empty-state hi-empty-state--insights">
              <div className="hi-empty-mark">L</div>
              <h3>No activity in this period</h3>
              <p>Once you dictate, your local usage patterns will appear here.</p>
            </div>
          ) : (
            <>
              <div className="hi-usage-summary">
                <MetricCard icon={<WordIcon />} value={formatNumber(stats.words)} label="Words dictated" detail={`${rangedItems.length} sessions`} />
                <MetricCard icon={<TimerIcon />} value={String(stats.wpm || "—")} label="Average WPM" detail="Based on audio duration" />
                <MetricCard icon={<ClockIcon />} value={formatDuration(stats.durationMs)} label="Time dictated" detail={`${formatNumber(stats.characters)} characters`} />
                <MetricCard icon={<AppIcon />} value={String(stats.appCount)} label="Apps used" detail={`${calculateStreak(rangedItems)} day streak`} />
              </div>

              <div className="hi-insights-grid">
                <section className="hi-insight-card hi-activity-card">
                  <div className="hi-card-heading">
                    <div><p className="hi-eyebrow">Activity</p><h2>Words over time</h2></div>
                    <span>{formatNumber(stats.words)} total</span>
                  </div>
                  <ActivityChart points={activity} />
                </section>
                <section className="hi-insight-card hi-category-card">
                  <div className="hi-card-heading">
                    <div><p className="hi-eyebrow">Where you dictate</p><h2>App categories</h2></div>
                  </div>
                  <CategoryList categories={categories} />
                </section>
              </div>

              <section className="hi-insight-card hi-momentum-card">
                <div>
                  <p className="hi-eyebrow">Your momentum</p>
                  <h2>{momentumHeadline(stats.words, calculateStreak(rangedItems))}</h2>
                  <p>Each number here comes from transcript metadata stored on this computer.</p>
                </div>
                <div className="hi-momentum-orb" aria-hidden="true"><strong>{calculateStreak(rangedItems)}</strong><span>day streak</span></div>
              </section>
            </>
          )}
        </section>
      )}

      {!loading && !error && tab === "voice" && (
        <section id="voice-panel" role="tabpanel" aria-labelledby="voice-tab" className="hi-insight-panel hi-voice-panel">
          <div className="hi-profile-disclosure">
            <InfoIcon />
            <p><strong>A deterministic local summary.</strong> This profile uses counts and simple thresholds—not a generative model or personality inference.</p>
          </div>

          {rangedItems.length === 0 ? (
            <div className="hi-empty-state hi-empty-state--insights">
              <div className="hi-empty-mark">L</div>
              <h3>Your voice profile is waiting</h3>
              <p>Dictate a few passages to build a private, factual summary.</p>
            </div>
          ) : (
            <>
              <section className="hi-voice-hero">
                <div className="hi-voice-hero__copy">
                  <p className="hi-eyebrow">Your measured style</p>
                  <h2>{voice.headline}</h2>
                  <p>{voice.summary}</p>
                  <span>{rangeLabel(range)} · {formatNumber(stats.words)} locally stored words</span>
                </div>
                <div className="hi-voice-shape" aria-hidden="true">
                  <span style={{ "--voice-level": `${voice.pacePercent}%` } as React.CSSProperties} />
                  <span style={{ "--voice-level": `${voice.sentencePercent}%` } as React.CSSProperties} />
                  <span style={{ "--voice-level": `${voice.varietyPercent}%` } as React.CSSProperties} />
                </div>
              </section>

              <div className="hi-voice-grid">
                <VoiceTrait title="Speaking pace" value={voice.paceLabel} detail={`${stats.wpm || "—"} measured WPM`} percent={voice.pacePercent} />
                <VoiceTrait title="Sentence shape" value={voice.sentenceLabel} detail={`${voice.averageSentenceWords} words per sentence`} percent={voice.sentencePercent} />
                <VoiceTrait title="Word variety" value={voice.varietyLabel} detail={`${voice.uniquePercent}% unique words`} percent={voice.varietyPercent} />
              </div>

              <div className="hi-insights-grid hi-voice-detail-grid">
                <section className="hi-insight-card">
                  <div className="hi-card-heading"><div><p className="hi-eyebrow">Vocabulary</p><h2>Frequent words</h2></div></div>
                  <div className="hi-word-cloud">
                    {voice.frequentWords.length > 0
                      ? voice.frequentWords.map((entry, index) => <span key={entry.word} data-rank={Math.min(index + 1, 4)}>{entry.word}<small>{entry.count}</small></span>)
                      : <p>More words are needed for this summary.</p>}
                  </div>
                </section>
                <section className="hi-insight-card">
                  <div className="hi-card-heading"><div><p className="hi-eyebrow">Context</p><h2>Where your voice goes</h2></div></div>
                  <CategoryList categories={categories} />
                </section>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}

function HistoryLoading() {
  return <div className="hi-loading" aria-label="Loading transcript history" aria-busy="true">{[0, 1, 2].map((item) => <span key={item} />)}</div>;
}

function InsightsLoading() {
  return <div className="hi-loading hi-loading--insights" aria-label="Calculating local insights" aria-busy="true">{[0, 1, 2, 3].map((item) => <span key={item} />)}</div>;
}

function Stat({ value, label }: { value: string; label: string }) {
  return <div><strong>{value}</strong><span>{label}</span></div>;
}

function MetricCard({ icon, value, label, detail }: { icon: React.ReactNode; value: string; label: string; detail: string }) {
  return (
    <article className="hi-metric-card">
      <span className="hi-metric-icon">{icon}</span>
      <strong>{value}</strong>
      <h2>{label}</h2>
      <p>{detail}</p>
    </article>
  );
}

function RangeControl({ range, onChange }: { range: InsightRange; onChange(range: InsightRange): void }) {
  return (
    <div className="hi-range-control" aria-label="Insight period">
      {(["7d", "30d", "all"] as const).map((option) => (
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

function CategoryList({ categories }: { categories: ReturnType<typeof categoryBreakdown> }) {
  if (categories.length === 0) return <p className="hi-card-empty">App information will appear after your first dictation.</p>;
  return (
    <div className="hi-category-list">
      {categories.map((category) => (
        <div className="hi-category-row" key={category.key}>
          <span className={`hi-category-icon hi-category-icon--${category.key}`}><CategoryIcon category={category.key} /></span>
          <div>
            <span>{category.label}</span>
            <small>{category.count} {category.count === 1 ? "session" : "sessions"} · {formatNumber(category.words)} words</small>
            <div><i style={{ width: `${Math.max(category.percent, category.words > 0 ? 1 : 0)}%` }} /></div>
          </div>
          <strong>{category.percent === 0 && category.words > 0 ? "<1%" : `${category.percent}%`}</strong>
        </div>
      ))}
    </div>
  );
}

function ActivityChart({ points }: { points: ReturnType<typeof activityForRange> }) {
  const maximum = Math.max(...points.map((point) => point.words), 1);
  return (
    <div className="hi-chart" role="group" aria-label={`Words by day. ${points.map((point) => `${point.fullLabel}: ${point.words}`).join(", ")}`}>
      <div className="hi-chart-grid" aria-hidden="true"><span /><span /><span /></div>
      <div className="hi-chart-bars">
        {points.map((point, index) => (
          <div
            className="hi-chart-column"
            data-edge={index === 0 ? "start" : index === points.length - 1 ? "end" : undefined}
            key={point.key}
            tabIndex={0}
            aria-label={`${point.fullLabel}: ${point.words} ${point.words === 1 ? "word" : "words"}`}
          >
            <span className="hi-chart-tooltip" role="tooltip">
              <strong>{formatNumber(point.words)} {point.words === 1 ? "word" : "words"}</strong>
              <small>{point.fullLabel}</small>
            </span>
            <i style={{ height: `${Math.max((point.words / maximum) * 100, point.words > 0 ? 5 : 1)}%` }} />
            <span className="hi-chart-label">{point.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VoiceTrait({ title, value, detail, percent }: { title: string; value: string; detail: string; percent: number }) {
  return (
    <article className="hi-voice-trait">
      <span>{title}</span>
      <strong>{value}</strong>
      <p>{detail}</p>
      <div aria-hidden="true"><i style={{ width: `${percent}%` }} /></div>
    </article>
  );
}

function words(text: string): string[] {
  return (text.toLocaleLowerCase().match(WORD_PATTERN) ?? []).map((word) => word.replace("’", "'"));
}

function summarize(items: Transcription[]) {
  const wordCount = items.reduce((total, item) => total + countWords(item.text), 0);
  const durationMs = items.reduce((total, item) => total + item.durationMs, 0);
  const minutes = durationMs / 60_000;
  const appIds = new Set(items.flatMap((item) => item.sourceAppId ? [item.sourceAppId] : []));
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

function friendlyDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(timestamp) === dateKey(today.getTime())) return "Today";
  if (dateKey(timestamp) === dateKey(yesterday.getTime())) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(date);
}

function isToday(timestamp: number): boolean {
  return dateKey(timestamp) === dateKey(Date.now());
}

function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
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
  return new Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function createVoiceProfile(items: Transcription[]) {
  const stats = summarize(items);
  const allWords = items.flatMap((item) => words(item.text));
  const uniqueWords = new Set(allWords);
  const uniquePercent = allWords.length > 0 ? Math.round((uniqueWords.size / allWords.length) * 100) : 0;
  const sentenceCount = items.reduce((total, item) => total + (item.text.match(SENTENCE_PATTERN)?.filter((sentence) => sentence.trim()).length ?? 0), 0);
  const averageSentenceWords = sentenceCount > 0 ? Math.max(1, Math.round(allWords.length / sentenceCount)) : allWords.length;

  const paceLabel = stats.wpm === 0 ? "Not measured" : stats.wpm < 105 ? "Measured" : stats.wpm <= 155 ? "Steady" : "Quick";
  const sentenceLabel = averageSentenceWords < 10 ? "Compact" : averageSentenceWords <= 19 ? "Balanced" : "Expansive";
  const varietyLabel = uniquePercent >= 70 ? "Varied" : uniquePercent >= 50 ? "Balanced" : "Consistent";
  const pacePercent = stats.wpm === 0 ? 0 : clamp(Math.round((stats.wpm / 190) * 100), 12, 100);
  const sentencePercent = clamp(Math.round((averageSentenceWords / 28) * 100), 8, 100);
  const varietyPercent = clamp(uniquePercent, 8, 100);

  const counts = new Map<string, number>();
  allWords.filter((word) => word.length > 2 && !STOP_WORDS.has(word)).forEach((word) => counts.set(word, (counts.get(word) ?? 0) + 1));
  const frequentWords = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word, count]) => ({ word, count }));

  return {
    paceLabel,
    sentenceLabel,
    varietyLabel,
    pacePercent,
    sentencePercent,
    varietyPercent,
    averageSentenceWords,
    uniquePercent,
    frequentWords,
    headline: `${paceLabel === "Not measured" ? "A" : paceLabel} pace with ${sentenceLabel.toLocaleLowerCase()} phrasing`,
    summary: `Your saved dictations average ${averageSentenceWords} words per sentence, with ${uniquePercent}% unique vocabulary in this period.`,
  };
}

function momentumHeadline(wordCount: number, streak: number): string {
  if (streak >= 7) return `${streak} days of keeping ideas moving.`;
  if (wordCount >= 5_000) return `${formatNumber(wordCount)} words without sending audio away.`;
  if (wordCount > 0) return `${formatNumber(wordCount)} words captured in your own flow.`;
  return "Your local dictation story starts here.";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function SearchIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>; }
function ExportIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v10m0-10L6.5 5.5M10 2l3.5 3.5M4 10v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" /></svg>; }
function MoreIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="4" cy="10" r="1" /><circle cx="10" cy="10" r="1" /><circle cx="16" cy="10" r="1" /></svg>; }
function CopyIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="10" height="10" rx="2" /><path d="M14 6V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1" /></svg>; }
function ShieldIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 16 5v4.4c0 3.7-2.3 6.5-6 8.1-3.7-1.6-6-4.4-6-8.1V5l6-2.5Z" /><path d="m7.5 10 1.7 1.7 3.5-4" /></svg>; }
function LockIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4" y="8" width="12" height="9" rx="2" /><path d="M7 8V6a3 3 0 0 1 6 0v2" /></svg>; }
function WordIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 5h14M3 10h10M3 15h7" /></svg>; }
function TimerIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="11" r="6.5" /><path d="M10 11 13 9M8 2h4" /></svg>; }
function ClockIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 6v4l3 2" /></svg>; }
function AppIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="11" y="3" width="6" height="6" rx="1" /><rect x="3" y="11" width="6" height="6" rx="1" /><rect x="11" y="11" width="6" height="6" rx="1" /></svg>; }
function InfoIcon() { return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 9v5M10 6.5h.01" /></svg>; }
function CategoryIcon({ category }: { category: AppCategoryKey }) {
  if (category === "personal" || category === "work") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4h12v9H9l-4 3v-3H4V4Z" /></svg>;
  if (category === "ai") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2v3m0 10v3M2 10h3m10 0h3M4.3 4.3l2.1 2.1m7.2 7.2 2.1 2.1m0-11.4-2.1 2.1m-7.2 7.2-2.1 2.1" /><circle cx="10" cy="10" r="3" /></svg>;
  if (category === "email") return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="5" width="14" height="10" rx="1.5" /><path d="m4 6 6 5 6-5" /></svg>;
  if (category === "development") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 5-4 5 4 5m6-10 4 5-4 5m-2-12L9 17" /></svg>;
  if (category === "browser") return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M3 10h14M10 3c2 2 3 4.3 3 7s-1 5-3 7c-2-2-3-4.3-3-7s1-5 3-7Z" /></svg>;
  if (category === "documents") return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 2.5h7l3 3V17.5H5Z" /><path d="M12 2.5v3h3M8 9h4m-4 3h4" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="2" /><path d="M10 3v2m0 10v2M3 10h2m10 0h2M5 5l1.5 1.5m7 7L15 15M15 5l-1.5 1.5m-7 7L5 15" /></svg>;
}
