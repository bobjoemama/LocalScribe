import { useEffect, useMemo, useRef, useState } from "react";
import type { ScratchpadNote } from "../../shared/contracts";
import "./scratchpad-window.css";

type SaveState = "loading" | "saved" | "saving" | "error";
const isMacOS = navigator.userAgent.includes("Macintosh");

function saveStateLabel(state: SaveState): string {
  if (state === "loading") return "Loading";
  if (state === "saving") return "Saving";
  if (state === "error") return "Save failed";
  return "Saved";
}

function CopyIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></svg>;
}

function SearchIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="5.8" /><path d="m15.2 15.2 4.3 4.3" /></svg>;
}

function NoteIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5M9 12h6M9 16h6" /></svg>;
}

function ChevronIcon({ direction = "left" }: { direction?: "left" | "right" }) {
  return <svg className={direction === "right" ? "scratchpad-window__icon--right" : undefined} viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6" /></svg>;
}

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function WandIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 19 14-14M14 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM5 13l.6 1.7L7.3 15l-1.7.6L5 17.3l-.6-1.7L2.7 15l1.7-.6z" /></svg>;
}

function FormattingIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14M12 5v14M8 19h8" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

function ExpandIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" /></svg>;
}

function wordCount(body: string): number {
  return body.trim() ? body.trim().split(/\s+/u).length : 0;
}

function noteMatches(note: ScratchpadNote, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || note.title.toLocaleLowerCase().includes(needle) || note.body.toLocaleLowerCase().includes(needle);
}

export function ScratchpadWindow() {
  const [notes, setNotes] = useState<ScratchpadNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<ScratchpadNote[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const persistedBodiesRef = useRef(new Map<string, string>());
  const pendingBodiesRef = useRef(new Map<string, string>());
  const saveTimersRef = useRef(new Map<string, number>());
  const saveSequencesRef = useRef(new Map<string, number>());
  const deletedIdsRef = useRef(new Set<string>());

  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);

  const selectNote = (id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setSaveState("saved");
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const replaceSavedNote = (saved: ScratchpadNote) => {
    setNotes((current) => [saved, ...current.filter((note) => note.id !== saved.id)]);
  };

  const persistNote = (id: string, body: string, sequence: number) => {
    if (selectedIdRef.current === id) setSaveState("saving");

    void window.localScribe.scratchpad.update(id, body).then(
      (saved) => {
        if (deletedIdsRef.current.has(id)) return;
        persistedBodiesRef.current.set(id, saved.body);
        if (saveSequencesRef.current.get(id) === sequence) {
          pendingBodiesRef.current.delete(id);
          replaceSavedNote(saved);
        }
        if (selectedIdRef.current === id && saveSequencesRef.current.get(id) === sequence) {
          setSaveState("saved");
        }
      },
      () => {
        if (selectedIdRef.current === id && saveSequencesRef.current.get(id) === sequence) {
          setSaveState("error");
        }
      },
    );
  };

  const scheduleSave = (id: string, body: string, immediately = false) => {
    const existing = saveTimersRef.current.get(id);
    if (existing !== undefined) window.clearTimeout(existing);
    pendingBodiesRef.current.set(id, body);
    const sequence = (saveSequencesRef.current.get(id) ?? 0) + 1;
    saveSequencesRef.current.set(id, sequence);
    if (immediately) {
      saveTimersRef.current.delete(id);
      persistNote(id, body, sequence);
      return;
    }
    const timer = window.setTimeout(() => {
      saveTimersRef.current.delete(id);
      persistNote(id, body, sequence);
    }, 350);
    saveTimersRef.current.set(id, timer);
  };

  const addNewNote = async () => {
    setSaveState("loading");
    try {
      const note = await window.localScribe.scratchpad.create();
      deletedIdsRef.current.delete(note.id);
      persistedBodiesRef.current.set(note.id, note.body);
      setNotes((current) => [note, ...current]);
      selectNote(note.id);
    } catch {
      setSaveState("error");
    }
  };

  useEffect(() => {
    let active = true;
    void window.localScribe.scratchpad.list().then(
      async (listedNotes) => {
        if (!active) return;
        if (listedNotes.length) {
          const initialNote = listedNotes[0];
          if (!initialNote) return;
          for (const note of listedNotes) persistedBodiesRef.current.set(note.id, note.body);
          setNotes(listedNotes);
          selectNote(initialNote.id);
          return;
        }
        await addNewNote();
      },
      () => {
        if (active) setSaveState("error");
      },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => () => {
    for (const timer of saveTimersRef.current.values()) window.clearTimeout(timer);
    for (const [id, body] of pendingBodiesRef.current) {
      if (!deletedIdsRef.current.has(id) && persistedBodiesRef.current.get(id) !== body) {
        void window.localScribe.scratchpad.update(id, body);
      }
    }
  }, []);

  const activeNote = notes.find((note) => note.id === selectedId) ?? null;
  const activeBody = activeNote?.body ?? "";
  const activeWordCount = wordCount(activeBody);
  const filteredNotes = useMemo(() => notes.filter((note) => noteMatches(note, query)), [notes, query]);

  const updateActiveBody = (body: string) => {
    if (!activeNote) return;
    const noteId = activeNote.id;
    setNotes((current) => current.map((note) => note.id === noteId ? { ...note, body } : note));
    scheduleSave(noteId, body);
  };

  const deleteNote = async (note: ScratchpadNote) => {
    if (!window.confirm(`Delete “${note.title}”?`)) return;
    const scheduled = saveTimersRef.current.get(note.id);
    if (scheduled !== undefined) window.clearTimeout(scheduled);
    saveTimersRef.current.delete(note.id);
    pendingBodiesRef.current.delete(note.id);
    deletedIdsRef.current.add(note.id);
    try {
      await window.localScribe.scratchpad.delete(note.id);
      persistedBodiesRef.current.delete(note.id);
      const remaining = notesRef.current.filter((item) => item.id !== note.id);
      notesRef.current = remaining;
      setNotes(remaining);
      if (selectedIdRef.current === note.id) {
        const next = remaining[0];
        if (next) selectNote(next.id);
        else await addNewNote();
      }
    } catch {
      deletedIdsRef.current.delete(note.id);
      setSaveState("error");
    }
  };

  const copyNote = async () => {
    if (!activeBody) return;
    try {
      await navigator.clipboard.writeText(activeBody);
      setCopyMessage("Copied");
      window.setTimeout(() => setCopyMessage(null), 1_500);
    } catch {
      setCopyMessage("Copy failed");
    }
  };

  return (
    <main className={`scratchpad-window${notesCollapsed ? " scratchpad-window--notes-collapsed" : ""}`} aria-label="Scratchpad">
      <header className="scratchpad-window__titlebar">
        <div className="scratchpad-window__drag-region" />
        <span className="scratchpad-window__brand-mark" aria-hidden="true">L</span>
        <h1 title={activeNote?.title ?? "Untitled note"}>{activeNote?.title ?? "Untitled note"}</h1>
        <button
          className="scratchpad-window__title-action"
          type="button"
          disabled={!activeNote}
          onClick={() => activeNote && void deleteNote(activeNote)}
          aria-label="Delete current note"
          title="Delete current note"
        >
          <CloseIcon />
        </button>
        <button className="scratchpad-window__title-action" type="button" onClick={() => void addNewNote()} aria-label="New note" title="New note">
          <PlusIcon />
        </button>
        <span className="scratchpad-window__title-spacer" />
        {isMacOS && (
          <>
            <button className="scratchpad-window__window-action" type="button" onClick={() => void window.localScribe.windows.toggleScratchpadSize()} aria-label="Toggle expanded Scratchpad" title="Toggle expanded Scratchpad">
              <ExpandIcon />
            </button>
            <button className="scratchpad-window__window-action" type="button" onClick={() => void window.localScribe.windows.closeScratchpad()} aria-label="Close Scratchpad" title="Close Scratchpad">
              <CloseIcon />
            </button>
          </>
        )}
      </header>

      <div className="scratchpad-window__workspace">
        <aside className="scratchpad-window__notes" aria-label="Notes">
          <div className="scratchpad-window__notes-top">
            <button
              className="scratchpad-window__collapse"
              type="button"
              aria-label={notesCollapsed ? "Expand Notes" : "Collapse Notes"}
              title={notesCollapsed ? "Expand Notes" : "Collapse Notes"}
              onClick={() => setNotesCollapsed((collapsed) => !collapsed)}
            >
              <ChevronIcon direction={notesCollapsed ? "right" : "left"} />
              <span>{notesCollapsed ? "Expand Notes" : "Collapse Notes"}</span>
            </button>
          </div>

          <div className="scratchpad-window__notes-content">
            <button className="scratchpad-window__new-note" type="button" onClick={() => void addNewNote()}>
              <PlusIcon /> <span>New note</span>
            </button>

            <label className="scratchpad-window__search">
              <SearchIcon />
              <span className="scratchpad-window__visually-hidden">Search notes</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" />
            </label>

            <div className="scratchpad-window__note-list" aria-label="Saved notes">
              {filteredNotes.map((note) => {
                const noteWordCount = wordCount(note.body);
                const selected = note.id === selectedId;
                return (
                  <div className={`scratchpad-window__note-row${selected ? " scratchpad-window__note-row--active" : ""}`} key={note.id}>
                    <button className="scratchpad-window__note-card" type="button" onClick={() => selectNote(note.id)} aria-current={selected ? "page" : undefined}>
                      <span className="scratchpad-window__note-icon"><NoteIcon /></span>
                      <span className="scratchpad-window__note-details">
                        <strong>{note.title}</strong>
                        <small>{noteWordCount} {noteWordCount === 1 ? "word" : "words"}</small>
                      </span>
                    </button>
                    <button className="scratchpad-window__delete-note" type="button" onClick={() => void deleteNote(note)} aria-label={`Delete ${note.title}`} title="Delete note">
                      <TrashIcon />
                    </button>
                  </div>
                );
              })}
              {notes.length > 0 && filteredNotes.length === 0 && <p className="scratchpad-window__empty-search">No matching notes</p>}
            </div>
          </div>

          <div className="scratchpad-window__notes-bottom">
            <button className="scratchpad-window__unavailable" type="button" disabled title="Additional generative text model required — not installed">
              <WandIcon />
              <span><strong>Generative Rewrite</strong><small>Additional generative text model required — not installed</small></span>
            </button>
            <button className="scratchpad-window__unavailable" type="button" disabled title="Unavailable in this build">
              <FormattingIcon />
              <span><strong>Formatting</strong><small>Unavailable in this build</small></span>
            </button>
          </div>
        </aside>

        <section className="scratchpad-window__editor-panel" aria-label="Note editor">
          <div className="scratchpad-window__editor-status">
            <span className={`scratchpad-window__save-state scratchpad-window__save-state--${saveState}`} aria-live="polite"><i /> {saveStateLabel(saveState)}</span>
            <span>{activeWordCount} {activeWordCount === 1 ? "word" : "words"}</span>
          </div>
          <label className="scratchpad-window__editor">
            <span className="scratchpad-window__visually-hidden">Scratchpad note</span>
            <textarea
              ref={textareaRef}
              value={activeBody}
              onChange={(event) => updateActiveBody(event.target.value)}
              placeholder="Start writing…"
              spellCheck
              disabled={!activeNote}
            />
          </label>
          <footer className="scratchpad-window__editor-footer">
            <span><LockIcon /> Stored locally</span>
            <button className="scratchpad-window__copy" type="button" disabled={!activeBody} onClick={() => void copyNote()}>
              <CopyIcon /> {copyMessage ?? "Copy"}
            </button>
          </footer>
        </section>
      </div>
    </main>
  );
}
