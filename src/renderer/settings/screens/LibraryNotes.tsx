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
        title: "No dictionary terms",
        body: "Add a name or phrase that your speech model may spell differently.",
      }
    : {
        title: "No snippets",
        body: "Add a spoken phrase and the text it should insert.",
      };
}

export function libraryEditorCanClose(saving: boolean, changed: boolean, confirmDiscard: () => boolean): boolean {
  if (saving) return false;
  return !changed || confirmDiscard();
}

export function libraryErrorMessage(error: unknown, fallback: string): string {
  return rendererSafeErrorMessage(error, fallback);
}

export function DictionaryScreen() {
  const [items, setItems] = useState<DictionaryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editingEntry, setEditingEntry] = useState<DictionaryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [unreadableCount, setUnreadableCount] = useState(0);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
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
    void window.localScribe.system.savedDataStatus().then(
      (status) => { if (mounted.current) setUnreadableCount(status.dictionary); },
      () => undefined,
    );
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
      setItems((current) => current.filter((item) => item.id !== entry.id));
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
          subtitle="Replace recognized words with your preferred spelling."
          actionLabel="Add term"
          actionDisabled={loading || unavailable}
          onAction={() => { setEditingEntry(null); setShowAdd(true); }}
        >
        <LibraryToolbar
          count={items.length}
          countState={countState}
          kind="dictionary"
          query={query}
          onQueryChange={setQuery}
          placeholder="Search dictionary"
        />

        {unreadableCount > 0 && (
          <InlineError actionLabel="Manage saved data…" onAction={() => void window.localScribe.windows.showSettings("data")}>
            {unreadableCount.toLocaleString()} saved {unreadableCount === 1 ? "record could" : "records could"} not be opened. Manage saved data to resolve this before adding terms.
          </InlineError>
        )}
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
            <span>Replace with</span>
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
                  <span className="ln-row__arrow" aria-hidden="true">→</span>
                  <span className="ln-row__label">Replace with</span>
                  <strong>{item.replacement}</strong>
                </div>
                <div className="ln-row__actions">
                  <button className="ln-edit-button" type="button" aria-label={`Edit ${item.replacement}`} disabled={deletingIds.has(item.id)} onClick={() => { setEditingEntry(item); setShowAdd(true); }}>Edit</button>
                  <button className="ln-delete-button" type="button" aria-label={`Delete ${item.replacement}`} disabled={deletingIds.has(item.id)} onClick={() => void remove(item)}>Delete</button>
                </div>
              </article>
            ))
          )}
        </section>
        </LibraryPage>
      </div>

      {showAdd && (
        <DictionaryModal
          entry={editingEntry ?? undefined}
          onClose={() => setShowAdd(false)}
          onSaved={async (saved) => {
            setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
            setQuery("");
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
  const [editingEntry, setEditingEntry] = useState<Snippet | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<LibraryError | null>(null);
  const [unreadableCount, setUnreadableCount] = useState(0);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
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
    void window.localScribe.system.savedDataStatus().then(
      (status) => { if (mounted.current) setUnreadableCount(status.snippets); },
      () => undefined,
    );
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
      setItems((current) => current.filter((item) => item.id !== snippet.id));
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
          subtitle="Insert saved text when you say a trigger phrase."
          actionLabel="Add snippet"
          actionDisabled={loading || unavailable}
          onAction={() => { setEditingEntry(null); setShowAdd(true); }}
        >
        <LibraryToolbar
          count={items.length}
          countState={countState}
          kind="snippets"
          query={query}
          onQueryChange={setQuery}
          placeholder="Search snippets"
        />

        {unreadableCount > 0 && (
          <InlineError actionLabel="Manage saved data…" onAction={() => void window.localScribe.windows.showSettings("data")}>
            {unreadableCount.toLocaleString()} saved {unreadableCount === 1 ? "record could" : "records could"} not be opened. Manage saved data to resolve this before adding snippets.
          </InlineError>
        )}
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
            <span>Say</span>
            <span>Insert</span>
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
                <div className="ln-row__actions">
                  <button className="ln-edit-button" type="button" aria-label={`Edit ${item.trigger}`} disabled={deletingIds.has(item.id)} onClick={() => { setEditingEntry(item); setShowAdd(true); }}>Edit</button>
                  <button className="ln-delete-button" type="button" aria-label={`Delete ${item.trigger}`} disabled={deletingIds.has(item.id)} onClick={() => void remove(item)}>Delete</button>
                </div>
              </article>
            ))
          )}
        </section>
        </LibraryPage>
      </div>

      {showAdd && (
        <SnippetModal
          entry={editingEntry ?? undefined}
          onClose={() => setShowAdd(false)}
          onSaved={async (saved) => {
            setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
            setQuery("");
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

export function DictionaryModal({ entry, onClose, onSaved }: { entry?: DictionaryEntry; onClose(): void; onSaved(saved: DictionaryEntry): Promise<void> }) {
  const [phrase, setPhrase] = useState(entry?.phrase ?? "");
  const [replacement, setReplacement] = useState(entry?.replacement ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const requestClose = () => {
    const changed = phrase !== (entry?.phrase ?? "") || replacement !== (entry?.replacement ?? "");
    if (libraryEditorCanClose(saveInFlight.current, changed, () => window.confirm("Discard your unsaved dictionary changes?"))) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.localScribe.dictionary.save({ ...(entry ? { id: entry.id } : {}), phrase, replacement });
      await onSaved(saved);
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
    <LibraryModal title={entry ? "Edit dictionary term" : "Add dictionary term"} description="Replaces the recognized phrase without changing the speech model." onClose={requestClose} busy={saving}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Say</span>
          <input
            autoFocus
            value={phrase}
            disabled={saving}
            onChange={(event) => { setPhrase(event.target.value); setError(null); }}
            placeholder="For example, local scribe"
            maxLength={DICTIONARY_PHRASE_MAX_LENGTH}
            required
          />
        </label>
        <label>
          <span>Replace with</span>
          <input
            value={replacement}
            disabled={saving}
            onChange={(event) => { setReplacement(event.target.value); setError(null); }}
            placeholder="For example, LocalScribe"
            maxLength={DICTIONARY_REPLACEMENT_MAX_LENGTH}
            required
          />
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !phrase.trim() || !replacement.trim() || Boolean(entry && phrase === entry.phrase && replacement === entry.replacement)}>
            {saving ? "Saving…" : entry ? "Save changes" : "Add term"}
          </button>
        </div>
      </form>
    </LibraryModal>
  );
}

export function SnippetModal({ entry, onClose, onSaved }: { entry?: Snippet; onClose(): void; onSaved(saved: Snippet): Promise<void> }) {
  const [trigger, setTrigger] = useState(entry?.trigger ?? "");
  const [expansion, setExpansion] = useState(entry?.expansion ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveInFlight = useRef(false);
  const requestClose = () => {
    const changed = trigger !== (entry?.trigger ?? "") || expansion !== (entry?.expansion ?? "");
    if (libraryEditorCanClose(saveInFlight.current, changed, () => window.confirm("Discard your unsaved snippet changes?"))) onClose();
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveInFlight.current) return;
    saveInFlight.current = true;
    setSaving(true);
    setError(null);
    try {
      const saved = await window.localScribe.snippets.save({ ...(entry ? { id: entry.id } : {}), trigger, expansion });
      await onSaved(saved);
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
    <LibraryModal title={entry ? "Edit snippet" : "Create a snippet"} description="Say the trigger to insert the saved text." onClose={requestClose} busy={saving}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Say</span>
          <input
            autoFocus
            value={trigger}
            disabled={saving}
            onChange={(event) => { setTrigger(event.target.value); setError(null); }}
            placeholder="For example, my sign off"
            maxLength={SNIPPET_TRIGGER_MAX_LENGTH}
            required
          />
        </label>
        <label>
          <span>Insert</span>
          <textarea
            value={expansion}
            disabled={saving}
            onChange={(event) => { setExpansion(event.target.value); setError(null); }}
            placeholder="Thanks,&#10;Your name"
            maxLength={SNIPPET_EXPANSION_MAX_LENGTH}
            required
          />
          <small>{expansion.length.toLocaleString()} / {SNIPPET_EXPANSION_MAX_LENGTH.toLocaleString()} characters</small>
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" disabled={saving} onClick={requestClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !trigger.trim() || !expansion.trim() || Boolean(entry && trigger === entry.trigger && expansion === entry.expansion)}>
            {saving ? "Saving…" : entry ? "Save changes" : "Add snippet"}
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

function Icon({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">{children}</svg>;
}
function PlusIcon() { return <Icon><path d="M12 5v14M5 12h14" /></Icon>; }
function CloseIcon() { return <Icon><path d="m6.5 6.5 11 11m0-11-11 11" /></Icon>; }
function SearchIcon() { return <Icon><circle cx="10.8" cy="10.8" r="6.2" /><path d="m15.4 15.4 4.1 4.1" /></Icon>; }
function NoteIcon() { return <Icon><path d="M6 3.5h9l3 3V20H6z" /><path d="M15 3.5V7h3M9 11h6m-6 3h6m-6 3h4" /></Icon>; }
