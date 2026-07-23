import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type { DictionaryEntry, Snippet } from "../../../shared/contracts";
import "./library-notes.css";

export function DictionaryScreen() {
  const [items, setItems] = useState<DictionaryEntry[]>([]);
  const [query, setQuery] = useState("");
  const [showHero, setShowHero] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setItems(await window.localScribe.dictionary.list());
    } catch {
      setError("Your local dictionary could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.phrase} ${item.replacement}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);

  const remove = async (entry: DictionaryEntry) => {
    if (!window.confirm(`Remove “${entry.replacement}” from your local dictionary?`)) return;
    try {
      setError(null);
      await window.localScribe.dictionary.delete(entry.id);
      await load();
    } catch {
      setError("That term could not be removed.");
    }
  };

  return (
    <LibraryPage
      title="Dictionary"
      subtitle="Help LocalScribe recognize names, products, and specialized language the way you write them."
      actionLabel="Add new"
      onAction={() => setShowAdd(true)}
    >
      {showHero && (
        <OnboardingHero
          eyebrow="A vocabulary that stays yours"
          title="Make every proper noun land correctly."
          body="Add a phrase as it may be recognized, then choose the spelling you want. Entries are applied on this computer after transcription."
          onDismiss={() => setShowHero(false)}
          artwork={<DictionaryArtwork />}
        />
      )}

      <LibraryToolbar
        count={items.length}
        itemName="term"
        query={query}
        onQueryChange={setQuery}
        placeholder="Search dictionary"
      />

      {error && <InlineError>{error}</InlineError>}
      <section className="ln-list" aria-label="Dictionary entries">
        <div className="ln-list__heading ln-list__heading--dictionary" aria-hidden="true">
          <span>Heard phrase</span>
          <span>Preferred spelling</span>
          <span />
        </div>
        {loading ? (
          <ListMessage title="Loading your dictionary…" />
        ) : filtered.length === 0 ? (
          <ListMessage
            title={query ? "No matching terms" : "Your dictionary is ready for its first term"}
            body={query ? "Try another search." : "Add a name or phrase that your speech model may spell differently."}
          />
        ) : (
          filtered.map((item) => (
            <article className="ln-row ln-row--dictionary" key={item.id}>
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
                onClick={() => void remove(item)}
              >
                <TrashIcon />
              </button>
            </article>
          ))
        )}
      </section>

      {showAdd && (
        <DictionaryModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            setShowAdd(false);
            await load();
          }}
        />
      )}
    </LibraryPage>
  );
}

export function SnippetsScreen() {
  const [items, setItems] = useState<Snippet[]>([]);
  const [query, setQuery] = useState("");
  const [showHero, setShowHero] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setItems(await window.localScribe.snippets.list());
    } catch {
      setError("Your local snippets could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      `${item.trigger} ${item.expansion}`.toLocaleLowerCase().includes(needle),
    );
  }, [items, query]);

  const remove = async (snippet: Snippet) => {
    if (!window.confirm(`Remove the “${snippet.trigger}” snippet?`)) return;
    try {
      setError(null);
      await window.localScribe.snippets.delete(snippet.id);
      await load();
    } catch {
      setError("That snippet could not be removed.");
    }
  };

  return (
    <LibraryPage
      title="Snippets"
      subtitle="Turn short spoken cues into text you use often, without sending the cue or expansion anywhere."
      actionLabel="Add new"
      onAction={() => setShowAdd(true)}
    >
      {showHero && (
        <OnboardingHero
          eyebrow="A shorter route to repeatable writing"
          title="Say the cue. Get the full thought."
          body="Create memorable triggers for signatures, links, directions, or recurring replies. LocalScribe expands them after local transcription."
          onDismiss={() => setShowHero(false)}
          artwork={<SnippetArtwork />}
        />
      )}

      <LibraryToolbar
        count={items.length}
        itemName="snippet"
        query={query}
        onQueryChange={setQuery}
        placeholder="Search snippets"
      />

      {error && <InlineError>{error}</InlineError>}
      <section className="ln-list" aria-label="Saved snippets">
        <div className="ln-list__heading ln-list__heading--snippets" aria-hidden="true">
          <span>Spoken trigger</span>
          <span>Expansion</span>
          <span />
        </div>
        {loading ? (
          <ListMessage title="Loading your snippets…" />
        ) : filtered.length === 0 ? (
          <ListMessage
            title={query ? "No matching snippets" : "Create your first spoken shortcut"}
            body={query ? "Try another search." : "A short cue can expand into any reusable block of local text."}
          />
        ) : (
          filtered.map((item) => (
            <article className="ln-row ln-row--snippets" key={item.id}>
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
                onClick={() => void remove(item)}
              >
                <TrashIcon />
              </button>
            </article>
          ))
        )}
      </section>

      {showAdd && (
        <SnippetModal
          onClose={() => setShowAdd(false)}
          onSaved={async () => {
            setShowAdd(false);
            await load();
          }}
        />
      )}
    </LibraryPage>
  );
}

function LibraryPage({
  title,
  subtitle,
  actionLabel,
  onAction,
  children,
}: {
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction(): void;
  children: ReactNode;
}) {
  return (
    <div className="ln-page">
      <div className="ln-page__topbar">
        <div>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        <button className="ln-primary" type="button" onClick={onAction}>
          <PlusIcon /> {actionLabel}
        </button>
      </div>
      {children}
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
  itemName,
  query,
  onQueryChange,
  placeholder,
}: {
  count: number;
  itemName: string;
  query: string;
  onQueryChange(value: string): void;
  placeholder: string;
}) {
  return (
    <div className="ln-toolbar">
      <div className="ln-toolbar__count">
        <strong>Your {itemName === "term" ? "terms" : "snippets"}</strong>
        <span>{count} {itemName}{count === 1 ? "" : "s"}</span>
      </div>
      <div className="ln-search">
        <SearchIcon />
        <input
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

function DictionaryModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [phrase, setPhrase] = useState("");
  const [replacement, setReplacement] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseOnEscape(onClose);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await window.localScribe.dictionary.save({ phrase, replacement });
      await onSaved();
    } catch {
      setError("LocalScribe could not save this term. Check both fields and try again.");
      setSaving(false);
    }
  };

  return (
    <Modal title="Add a dictionary term" description="Choose what LocalScribe should write when it recognizes this phrase." onClose={onClose}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Phrase it may hear</span>
          <input
            autoFocus
            value={phrase}
            onChange={(event) => setPhrase(event.target.value)}
            placeholder="For example, local scribe"
            maxLength={200}
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
            maxLength={200}
            required
          />
          <small>This exact text replaces the recognized phrase.</small>
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !phrase.trim() || !replacement.trim()}>
            {saving ? "Saving…" : "Add term"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SnippetModal({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [trigger, setTrigger] = useState("");
  const [expansion, setExpansion] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useCloseOnEscape(onClose);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await window.localScribe.snippets.save({ trigger, expansion });
      await onSaved();
    } catch {
      setError("LocalScribe could not save this snippet. Check both fields and try again.");
      setSaving(false);
    }
  };

  return (
    <Modal title="Create a snippet" description="Pair a memorable spoken cue with the complete text you want inserted." onClose={onClose}>
      <form className="ln-modal__form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>Spoken trigger</span>
          <input
            autoFocus
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            placeholder="For example, my sign off"
            maxLength={80}
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
            maxLength={10_000}
            required
          />
          <small>{expansion.length.toLocaleString()} / 10,000 characters</small>
        </label>
        {error && <InlineError>{error}</InlineError>}
        <div className="ln-modal__actions">
          <button className="ln-secondary" type="button" onClick={onClose}>Cancel</button>
          <button className="ln-primary" type="submit" disabled={saving || !trigger.trim() || !expansion.trim()}>
            {saving ? "Saving…" : "Add snippet"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose(): void;
  children: ReactNode;
}) {
  const titleId = `ln-modal-${title.replace(/\W+/gu, "-").toLocaleLowerCase()}`;
  const descriptionId = `${titleId}-description`;
  return (
    <div className="ln-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="ln-modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <button className="ln-modal__close" type="button" aria-label="Close dialog" onClick={onClose}>
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

function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}

function InlineError({ children }: { children: ReactNode }) {
  return <div className="ln-error" role="alert">{children}</div>;
}

function ListMessage({ title, body }: { title: string; body?: string }) {
  return (
    <div className="ln-list-message">
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
