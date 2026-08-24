import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  dictionaryEntrySchema,
  snippetSchema,
  type DictionaryEntry,
  type Snippet,
} from "../../../shared/contracts";
import { rendererSafeErrorMessage } from "../../../shared/rendererErrors";
import "./library-notes.css";

type LibraryError = {
  message: string;
  canReload: boolean;
};

type LibraryKind = "dictionary" | "snippets";
type LibraryCountState = "loading" | "ready" | "unavailable";

function requiredMaxLength(value: number | null, field: string): number {
  if (value === null) throw new Error(`${field} contract must define a maximum length.`);
  return value;
}

export const DICTIONARY_PHRASE_MAX_LENGTH = requiredMaxLength(
  dictionaryEntrySchema.shape.phrase.maxLength,
  "Dictionary phrase",
);
export const DICTIONARY_REPLACEMENT_MAX_LENGTH = requiredMaxLength(
  dictionaryEntrySchema.shape.replacement.maxLength,
  "Dictionary replacement",
);
export const SNIPPET_TRIGGER_MAX_LENGTH = requiredMaxLength(
  snippetSchema.shape.trigger.maxLength,
  "Snippet trigger",
);
export const SNIPPET_EXPANSION_MAX_LENGTH = requiredMaxLength(
  snippetSchema.shape.expansion.maxLength,
  "Snippet expansion",
);

const LIBRARY_HERO_DISMISSAL_KEYS: Record<LibraryKind, string> = {
  dictionary: "localscribe.library.dictionary-introduction-dismissed",
  snippets: "localscribe.library.snippets-introduction-dismissed",
};

export function shouldShowLibraryHero(
  itemCount: number,
  loading: boolean,
  unavailable: boolean,
  dismissed: boolean,
): boolean {
  return !loading && !unavailable && !dismissed && itemCount === 0;
}

export function libraryCountLabel(
  kind: LibraryKind,
  count: number,
  state: LibraryCountState,
): string {
  if (state === "loading") return "Loading…";
  if (state === "unavailable") return "Unavailable";
  const itemName = kind === "dictionary" ? "term" : "snippet";
  return `${count.toLocaleString()} ${itemName}${count === 1 ? "" : "s"}`;
}

function useLibraryHeroDismissal(kind: LibraryKind): [boolean, () => void] {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(LIBRARY_HERO_DISMISSAL_KEYS[kind]) === "true";
    } catch {
      return false;
    }
  });

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(LIBRARY_HERO_DISMISSAL_KEYS[kind], "true");
    } catch {
      // The current view still honors dismissal when storage is unavailable.
    }
  }, [kind]);

  return [dismissed, dismiss];
}

export function libraryListMessage(
  kind: LibraryKind,
  query: string,
  unavailable: boolean,
): { title: string; body: string } {
  if (unavailable) {
    return kind === "dictionary"
      ? { title: "Dictionary unavailable", body: "Try loading your local terms again." }
      : { title: "Snippets unavailable", body: "Try loading your local snippets again." };
  }
  if (query.trim()) {
    return {
      title: kind === "dictionary" ? "No matching terms" : "No matching snippets",
      body: "Try another search.",
    };
  }
  return kind === "dictionary"
    ? {
        title: "Your dictionary is ready for its first term",
        body: "Add a name or phrase that your speech model may spell differently.",
      }
    : {
        title: "Create your first spoken snippet",
        body: "A short cue can expand into any reusable block of local text.",
      };
}

export function libraryErrorMessage(error: unknown, fallback: string): string {
  return rendererSafeErrorMessage(error, fallback);
}

export function DictionaryScreen() {
  const [items, setItems] = useState<DictionaryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [heroDismissed, dismissHero] = useLibraryHeroDismissal("dictionary");
  const loadSequence = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!mounted.current) return;
    setLoading(true);
    try {
      setError(null);
      const next = await window.localScribe.dictionary.list();
      if (mounted.current && sequence === loadSequence.current) setItems(next);
    } catch (loadError) {
      if (mounted.current && sequence === loadSequence.current) {
        setError({
          message: libraryErrorMessage(loadError, "Your local dictionary could not be loaded."),
          canReload: true,
        });
      }
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
    };
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.phrase} ${item.replacement}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);
  const emptyMessage = libraryListMessage(
    "dictionary",
    query,
    Boolean(error?.canReload && items.length === 0),
  );
  const unavailable = Boolean(error?.canReload && items.length === 0);
  const showHero = shouldShowLibraryHero(items.length, loading, unavailable, heroDismissed);
  const countState: LibraryCountState = loading
    ? "loading"
    : unavailable
      ? "unavailable"
      : "ready";

  const remove = async (entry: DictionaryEntry) => {
    if (deletingIds.has(entry.id)) return;
    if (!window.confirm(`Remove “${entry.replacement}” from your local dictionary?`)) return;
    setDeletingIds((current) => new Set(current).add(entry.id));
    try {
      setError(null);
      await window.localScribe.dictionary.delete(entry.id);
      await load();
    } catch (removeError) {
      setError({
        message: libraryErrorMessage(removeError, "That term could not be removed."),
        canReload: false,
      });
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
    }
  };

  return (
    <>
      <div inert={showAdd}>
        <LibraryPage
          title="Dictionary"
          subtitle="Help LocalScribe recognize names, products, and specialized language the way you write them."
          actionLabel="Add new"
          actionDisabled={loading || unavailable}
          onAction={() => setShowAdd(true)}
        >
        {showHero && (
          <OnboardingHero
            eyebrow="A vocabulary that stays yours"
            title="Make every proper noun land correctly."
            body="Add a phrase as it may be recognized, then choose the spelling you want. Entries are applied on this computer after transcription."
            onDismiss={dismissHero}
            artwork={<DictionaryArtwork />}
          />
        )}

        <LibraryToolbar
          count={items.length}
          countState={countState}
          kind="dictionary"
          query={query}
          onQueryChange={setQuery}
          placeholder="Search dictionary"
        />

        {error && (
          <InlineError
            actionLabel={error.canReload ? "Try again" : undefined}
            onAction={error.canReload ? () => void load() : undefined}
          >
            {error.message}
          </InlineError>
        )}
        <section className="ln-list" aria-label="Dictionary entries" aria-busy={loading}>
          <div className="ln-list__heading ln-list__heading--dictionary" aria-hidden="true">
            <span>Heard phrase</span>
            <span>Preferred spelling</span>
            <span />
          </div>
          {loading ? (
            <ListMessage title="Loading your dictionary…" status />
          ) : filtered.length === 0 ? (
            <ListMessage {...emptyMessage} />
          ) : (
            filtered.map((item) => (
              <article className="ln-row ln-row--dictionary" aria-busy={deletingIds.has(item.id)} key={item.id}>
                <div className="ln-row__cell">
                  <span className="ln-row__label">Heard phrase</span>
                  <strong>{item.phrase}</strong>
                </div>
                <div className="ln-row__cell ln-row__preferred">
                  <span className="ln-row__label">Preferred spelling</span>
                  <strong>{item.replacement}</strong>
                </div>
                <button
                  className="ln-icon-button ln-icon-button--danger"
                  type="button"
                  aria-label={`Remove ${item.replacement}`}
                  title="Remove term"
                  disabled={deletingIds.has(item.id)}
                  onClick={() => void remove(item)}
                >
                  <TrashIcon />
                </button>
              </article>
            ))
          )}
        </section>
        </LibraryPage>
      </div>

      {showAdd && (
        <DictionaryModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            await load();
            setShowAdd(false);
          }}
        />
      )}
    </>
  );
}

export function SnippetsScreen() {
  const [items, setItems] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [heroDismissed, dismissHero] = useLibraryHeroDismissal("snippets");
  const loadSequence = useRef(0);
  const mounted = useRef(false);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    if (!mounted.current) return;
    setLoading(true);
    try {
      setError(null);
      const next = await window.localScribe.snippets.list();
      if (mounted.current && sequence === loadSequence.current) setItems(next);
    } catch (loadError) {
      if (mounted.current && sequence === loadSequence.current) {
        setError({
          message: libraryErrorMessage(loadError, "Your local snippets could not be loaded."),
          canReload: true,
        });
      }
    } finally {
      if (mounted.current && sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadSequence.current += 1;
    };
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.trigger} ${item.expansion}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);
  const emptyMessage = libraryListMessage(
    "snippets",
    query,
    Boolean(error?.canReload && items.length === 0),
  );
  const unavailable = Boolean(error?.canReload && items.length === 0);
  const showHero = shouldShowLibraryHero(items.length, loading, unavailable, heroDismissed);
  const countState: LibraryCountState = loading
    ? "loading"
    : unavailable
      ? "unavailable"
      : "ready";

  const remove = async (snippet: Snippet) => {
    if (deletingIds.has(snippet.id)) return;
    if (!window.confirm(`Remove the “${snippet.trigger}” snippet?`)) return;
    setDeletingIds((current) => new Set(current).add(snippet.id));
    try {
      setError(null);
      await window.localScribe.snippets.delete(snippet.id);
      await load();
    } catch (removeError) {
      setError({
        message: libraryErrorMessage(removeError, "That snippet could not be removed."),
        canReload: false,
      });
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(snippet.id);
        return next;
      });
    }
  };

  return (
    <>
      <div inert={showAdd}>
        <LibraryPage
          title="Snippets"
          subtitle="Turn short spoken cues into text you use often, without sending the cue or expansion anywhere."
          actionLabel="Add new"
          actionDisabled={loading || unavailable}
          onAction={() => setShowAdd(true)}
        >
        {showHero && (
          <OnboardingHero
            eyebrow="A shorter route to repeatable writing"
            title="Say the cue. Get the full thought."
            body="Create memorable triggers for signatures, links, directions, or recurring replies. LocalScribe expands them after local transcription."
            onDismiss={dismissHero}
            artwork={<SnippetArtwork />}
          />
        )}

        <LibraryToolbar
          count={items.length}
          countState={countState}
          kind="snippets"
          query={query}
          onQueryChange={setQuery}
          placeholder="Search snippets"
        />

        {error && (
          <InlineError
            actionLabel={error.canReload ? "Try again" : undefined}
            onAction={error.canReload ? () => void load() : undefined}
          >
            {error.message}
          </InlineError>
        )}
        <section className="ln-list" aria-label="Saved snippets" aria-busy={loading}>
          <div className="ln-list__heading ln-list__heading--snippets" aria-hidden="true">
            <span>Spoken trigger</span>
            <span>Expansion</span>
            <span />
          </div>
          {loading ? (
            <ListMessage title="Loading your snippets…" status />
          ) : filtered.length === 0 ? (
            <ListMessage {...emptyMessage} />
          ) : (
            filtered.map((item) => (
              <article className="ln-row ln-row--snippets" aria-busy={deletingIds.has(item.id)} key={item.id}>
                <div className="ln-row__cell">
                  <span className="ln-row__label">Spoken trigger</span>
                  <strong>{item.trigger}</strong>
                </div>
                <div className="ln-row__cell ln-row__expansion">
                  <span className="ln-row__label">Expansion</span>
                  <p>{item.expansion}</p>
                </div>
                <button
                  className="ln-icon-button ln-icon-button--danger"
                  type="button"
                  aria-label={`Remove ${item.trigger}`}
                  title="Remove snippet"
                  disabled={deletingIds.has(item.id)}
                  onClick={() => void remove(item)}
                >
                  <TrashIcon />
                </button>
              </article>
            ))
          )}
        </section>
        </LibraryPage>
      </div>

      {showAdd && (
        <SnippetModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            await load();
            setShowAdd(false);
          }}
        />
      )}
    </>
  );
}

function LibraryPage({
  title,
  subtitle,
  actionLabel,
  actionDisabled,
  onAction,
  children,
}: {
  title: string;
  subtitle: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction(): void;
  children: ReactNode;
}) {
  return (
    <div className="ln-page-frame">
      <div className="ln-page">
        <div className="ln-page__topbar">
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <button className="ln-primary" type="button" disabled={actionDisabled} onClick={onAction}>
            <PlusIcon /> {actionLabel}
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function OnboardingHero({
  eyebrow,
  title,
  body,
  artwork,
  onDismiss,
}: {
  eyebrow: string;
  title: string;
  body: string;
  artwork: ReactNode;
  onDismiss(): void;
}) {
  return (
    <section className="ln-hero">
      <button className="ln-hero__dismiss" type="button" aria-label="Dismiss introduction" onClick={onDismiss}>
        <CloseIcon />
      </button>
      <div className="ln-hero__copy">
        <span>{eyebrow}</span>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
      <div className="ln-hero__art" aria-hidden="true">{artwork}</div>
    </section>
  );
}

function LibraryToolbar({
  count,
  countState,
  kind,
  query,
  onQueryChange,
  placeholder,
}: {
  count: number;
  countState: LibraryCountState;
  kind: LibraryKind;
  query: string;
  onQueryChange(value: string): void;
  placeholder: string;
}) {
  return (
    <div className="ln-toolbar">
      <div className="ln-toolbar__count">
        <strong>Your {kind === "dictionary" ? "terms" : "snippets"}</strong>
        <span aria-live="polite">{libraryCountLabel(kind, count, countState)}</span>
      </div>
      <div className="ln-search">
        <SearchIcon />
        <input
          type="search"
          autoComplete="off"
          aria-label={placeholder}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={placeholder}
        />
        {query && (
          <button type="button" aria-label="Clear search" onClick={() => onQueryChange("")}>
            <CloseIcon />
          </button>
        )}
      </div>
    </div>
  );
}

export function DictionaryModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [phrase, setPhrase] = useState("");
  const [replacement, setReplacement] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const requestClose = () => {
    if (!saveInFlight.current) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await window.localScribe.dictionary.save({ phrase, replacement });
      await onSaved();
    } catch (saveError) {
      setError(libraryErrorMessage(
        saveError,
        "LocalScribe could not save this term. Check both fields and try again.",
      ));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <LibraryModal title="Add a dictionary term" description="Choose what LocalScribe should write when it recognizes this phrase." onClose={requestClose} busy={saving}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Phrase it may hear</span>
          <input
            autoFocus
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder="For example, local scribe"
            maxLength={DICTIONARY_PHRASE_MAX_LENGTH}
            required
          />
          <small>Use a likely phonetic or alternate spelling.</small>
        </label>
        <label>
          <span>Preferred spelling</span>
          <input
            value={replacement}
            onChange={(event) => setReplacement(event.target.value)}
            placeholder="For example, LocalScribe"
            maxLength={DICTIONARY_REPLACEMENT_MAX_LENGTH}
            required
          />
          <small>This exact text replaces the recognized phrase.</small>
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !phrase.trim() || !replacement.trim()}>
            {saving ? "Saving…" : "Add term"}
          </button>
        </div>
      </form>
    </LibraryModal>
  );
}

export function SnippetModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [trigger, setTrigger] = useState("");
  const [expansion, setExpansion] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const requestClose = () => {
    if (!saveInFlight.current) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      await window.localScribe.snippets.save({ trigger, expansion });
      await onSaved();
    } catch (saveError) {
      setError(libraryErrorMessage(
        saveError,
        "LocalScribe could not save this snippet. Check both fields and try again.",
      ));
    } finally {
      saveInFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <LibraryModal title="Create a snippet" description="Pair a memorable spoken cue with the complete text you want inserted." onClose={requestClose} busy={saving}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Spoken trigger</span>
          <input
            autoFocus
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            placeholder="For example, my sign off"
            maxLength={SNIPPET_TRIGGER_MAX_LENGTH}
            required
          />
          <small>Choose a distinct phrase that is easy to remember.</small>
        </label>
        <label>
          <span>Expansion</span>
          <textarea
            value={expansion}
            onChange={(event) => setExpansion(event.target.value)}
            placeholder="Thanks,&#10;Your name"
            maxLength={SNIPPET_EXPANSION_MAX_LENGTH}
            required
          />
          <small>{expansion.length.toLocaleString()} / {SNIPPET_EXPANSION_MAX_LENGTH.toLocaleString()} characters</small>
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !trigger.trim() || !expansion.trim()}>
            {saving ? "Saving…" : "Add snippet"}
          </button>
        </div>
      </form>
    </LibraryModal>
  );
}

export function LibraryModal({
  title,
  description,
  onClose,
  busy = false,
  children,
}: {
  title: string;
  description: string;
  onClose(): void;
  busy?: boolean;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const [restoreFocusTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined" || typeof HTMLElement === "undefined") return null;
    return document.activeElement instanceof HTMLElement ? document.activeElement : null;
  });
  const titleId = `ln-modal-${title.replace(/\W+/gu, "-").toLocaleLowerCase()}`;
  const descriptionId = `${titleId}-description`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.querySelector<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)?.focus();
    }
    return () => {
      if (restoreFocusTarget?.isConnected) restoreFocusTarget.focus();
    };
  }, [restoreFocusTarget]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR));
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const targetIndex = modalTabTarget(activeIndex, focusable.length, event.shiftKey);
    if (targetIndex === null) return;
    event.preventDefault();
    focusable[targetIndex]?.focus();
  };

  return (
    <div className="ln-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className="ln-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <button className="ln-modal__close" type="button" aria-label="Close dialog" disabled={busy} onClick={onClose}>
          <CloseIcon />
        </button>
        <header>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </header>
        {children}
      </section>
    </div>
  );
}

const MODAL_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function modalTabTarget(
  activeIndex: number,
  focusableCount: number,
  shiftKey: boolean,
): number | null {
  if (focusableCount < 1) return null;
  if (activeIndex < 0) return shiftKey ? focusableCount - 1 : 0;
  if (shiftKey && activeIndex === 0) return focusableCount - 1;
  if (!shiftKey && activeIndex === focusableCount - 1) return 0;
  return null;
}

function InlineError({
  children,
  actionLabel,
  onAction,
}: {
  children: ReactNode;
  actionLabel?: string;
  onAction?(): void;
}) {
  return (
    <div className="ln-error" role="alert">
      <span>{children}</span>
      {actionLabel && onAction && (
        <button className="ln-secondary ln-secondary--compact" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function ListMessage({ title, body, status = false }: { title: string; body?: string; status?: boolean }) {
  return (
    <div className="ln-list-message" role={status ? "status" : undefined}>
      <span><NoteIcon /></span>
      <strong>{title}</strong>
      {body && <p>{body}</p>}
    </div>
  );
}

function DictionaryArtwork() {
  return (
    <div className="ln-art ln-art--dictionary">
      <span className="ln-art__orb" />
      <span className="ln-word-card ln-word-card--one"><small>Heard</small>local scribe</span>
      <span className="ln-word-card ln-word-card--two"><small>Write</small>LocalScribe</span>
      <span className="ln-art__arrow">→</span>
    </div>
  );
}

function SnippetArtwork() {
  return (
    <div className="ln-art ln-art--snippets">
      <span className="ln-art__orb" />
      <span className="ln-trigger-pill">“meeting link”</span>
      <span className="ln-expansion-sheet"><i /><i /><i /><small>Expanded locally</small></span>
    </div>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>;
}
function PlusIcon() { return <Icon><path d="M12 5v14M5 12h14" /></Icon>; }
function CloseIcon() { return <Icon><path d="m6.5 6.5 11 11m0-11-11 11" /></Icon>; }
function SearchIcon() { return <Icon><circle cx="10.8" cy="10.8" r="6.2" /><path d="m15.4 15.4 4.1 4.1" /></Icon>; }
function TrashIcon() { return <Icon><path d="M8 8.5v8m4-8v8m4-8v8M5.5 6h13m-9-2h5m-7.5 2 .7 14h8.6L17 6" /></Icon>; }
function NoteIcon() { return <Icon><path d="M6 3.5h9l3 3V20H6z" /><path d="M15 3.5V7h3M9 11h6m-6 3h6m-6 3h4" /></Icon>; }
