import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  scratchpadNoteSchema,
  type RuntimePlatform,
  type ScratchpadNote,
} from "../../shared/contracts";
import {
  GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE,
} from "../generativeTextAvailability";
import { scratchpadNoteMatches } from "./search";
import { createWordCountCache } from "./wordCounts";
import "./scratchpad-window.css";

type NoteSaveState = "saved" | "saving" | "save-error";
type ScratchpadStatus = "loading" | NoteSaveState | "load-error" | "create-error" | "delete-error";

function requiredMaxLength(value: number | null): number {
  if (value === null) {
    throw new Error("Scratchpad body contract must define a maximum length.");
  }
  return value;
}

const SCRATCHPAD_BODY_MAX_LENGTH = requiredMaxLength(scratchpadNoteSchema.shape.body.maxLength);

export function scratchpadStatusLabel(state: ScratchpadStatus): string {
  if (state === "loading") return "Loading";
  if (state === "saving") return "Saving";
  if (state === "save-error") return "Save failed";
  if (state === "load-error") return "Notes unavailable";
  if (state === "create-error") return "Note creation failed";
  if (state === "delete-error") return "Delete failed";
  return "Saved";
}

export function shouldShowCustomWindowActions(platform: RuntimePlatform | null): boolean {
  return platform === "darwin";
}

export function scratchpadWindowControlMode(
  platform: RuntimePlatform | null,
): "pending" | "custom" | "native" {
  if (platform === null) return "pending";
  return shouldShowCustomWindowActions(platform) ? "custom" : "native";
}

export function scratchpadHeaderTitle(
  activeTitle: string | null,
  status: ScratchpadStatus,
): string {
  if (activeTitle) return activeTitle;
  return status === "loading" ? "Loading notes…" : "Scratchpad";
}

function statusTone(state: ScratchpadStatus): "loading" | "saved" | "saving" | "error" {
  if (state === "loading" || state === "saved" || state === "saving") return state;
  return "error";
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

function TrashIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>;
}

function CloseIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" /></svg>;
}

function ExpandIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5v4M15 5h4v4M9 19H5v-4M15 19h4v-4" /></svg>;
}

export function ScratchpadWindowControls({ platform }: { platform: RuntimePlatform | null }) {
  if (!shouldShowCustomWindowActions(platform)) return null;
  return (
    <>
      <button className="scratchpad-window__window-action" type="button" onClick={() => void window.localScribe.windows.toggleScratchpadSize()} aria-label="Toggle expanded Scratchpad" title="Toggle expanded Scratchpad">
        <ExpandIcon />
      </button>
      <button className="scratchpad-window__window-action" type="button" onClick={() => void window.localScribe.windows.closeScratchpad()} aria-label="Close Scratchpad" title="Close Scratchpad">
        <CloseIcon />
      </button>
    </>
  );
}

export function ScratchpadWindow() {
  const [notes, setNotes] = useState<ScratchpadNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [notesCollapsed, setNotesCollapsed] = useState(false);
  const [status, setStatus] = useState<ScratchpadStatus>("loading");
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [runtimePlatform, setRuntimePlatform] = useState<RuntimePlatform | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const notesRef = useRef<ScratchpadNote[]>([]);
  const selectedIdRef = useRef<string | null>(null);
  const persistedBodiesRef = useRef(new Map<string, string>());
  const pendingBodiesRef = useRef(new Map<string, string>());
  const saveTimersRef = useRef(new Map<string, number>());
  const saveSequencesRef = useRef(new Map<string, number>());
  const inFlightSequencesRef = useRef(new Map<string, number>());
  const noteSaveStatesRef = useRef(new Map<string, NoteSaveState>());
  const deletedIdsRef = useRef(new Set<string>());
  const creatingRef = useRef(false);
  const copyMessageTimerRef = useRef<number | null>(null);
  const flushPendingSavesRef = useRef<() => void>(() => undefined);
  /*
   * One cache for the window's lifetime, so a note keeps its count until its
   * own body changes. See ./wordCounts for what recomputing all of them on
   * every keystroke was costing.
   */
  const wordCountFor = useRef(createWordCountCache()).current;

  const replaceNotes = useCallback((next: ScratchpadNote[]) => {
    notesRef.current = next;
    setNotes(next);
  }, []);

  const selectNote = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setStatus(noteSaveStatesRef.current.get(id) ?? "saved");
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const replaceSavedNote = (saved: ScratchpadNote) => {
    replaceNotes([saved, ...notesRef.current.filter((note) => note.id !== saved.id)]);
  };

  const persistNote = (id: string, body: string, sequence: number) => {
    if (deletedIdsRef.current.has(id)) return;
    if (inFlightSequencesRef.current.get(id) === sequence) return;
    inFlightSequencesRef.current.set(id, sequence);
    noteSaveStatesRef.current.set(id, "saving");
    if (selectedIdRef.current === id) setStatus("saving");

    void window.localScribe.scratchpad.update(id, body).then(
      (saved) => {
        if (inFlightSequencesRef.current.get(id) === sequence) {
          inFlightSequencesRef.current.delete(id);
        }
        if (deletedIdsRef.current.has(id)) return;
        persistedBodiesRef.current.set(id, saved.body);
        if (saveSequencesRef.current.get(id) === sequence) {
          pendingBodiesRef.current.delete(id);
          noteSaveStatesRef.current.set(id, "saved");
          replaceSavedNote(saved);
        }
        if (selectedIdRef.current === id && saveSequencesRef.current.get(id) === sequence) {
          setStatus("saved");
        }
      },
      () => {
        if (inFlightSequencesRef.current.get(id) === sequence) {
          inFlightSequencesRef.current.delete(id);
        }
        if (selectedIdRef.current === id && saveSequencesRef.current.get(id) === sequence) {
          noteSaveStatesRef.current.set(id, "save-error");
          setStatus("save-error");
        } else if (saveSequencesRef.current.get(id) === sequence) {
          noteSaveStatesRef.current.set(id, "save-error");
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
    noteSaveStatesRef.current.set(id, "saving");
    if (selectedIdRef.current === id) setStatus("saving");
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

  const flushScheduledSave = (id: string) => {
    const timer = saveTimersRef.current.get(id);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    saveTimersRef.current.delete(id);
    const body = pendingBodiesRef.current.get(id);
    const sequence = saveSequencesRef.current.get(id);
    if (body !== undefined && sequence !== undefined && !deletedIdsRef.current.has(id)) {
      persistNote(id, body, sequence);
    }
  };

  const addNewNote = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    if (notesRef.current.length === 0) setStatus("loading");
    try {
      const note = await window.localScribe.scratchpad.create();
      deletedIdsRef.current.delete(note.id);
      persistedBodiesRef.current.set(note.id, note.body);
      noteSaveStatesRef.current.set(note.id, "saved");
      replaceNotes([note, ...notesRef.current.filter((current) => current.id !== note.id)]);
      selectNote(note.id);
    } catch {
      setStatus("create-error");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [replaceNotes, selectNote]);

  useEffect(() => {
    let active = true;
    void window.localScribe.scratchpad.list().then(
      async (listedNotes) => {
        if (!active) return;
        if (listedNotes.length) {
          const initialNote = listedNotes[0];
          if (!initialNote) return;
          for (const note of listedNotes) {
            persistedBodiesRef.current.set(note.id, note.body);
            noteSaveStatesRef.current.set(note.id, "saved");
          }
          replaceNotes(listedNotes);
          selectNote(initialNote.id);
          return;
        }
        await addNewNote();
      },
      () => {
        if (active) setStatus("load-error");
      },
    );
    return () => { active = false; };
  }, [addNewNote, replaceNotes, selectNote]);

  useEffect(() => {
    let active = true;
    void window.localScribe.system.appInfo().then(
      (info) => {
        if (active) setRuntimePlatform(info.platform);
      },
      () => undefined,
    );
    return () => { active = false; };
  }, []);

  flushPendingSavesRef.current = () => {
    for (const [id, body] of pendingBodiesRef.current) {
      const timer = saveTimersRef.current.get(id);
      if (timer !== undefined) window.clearTimeout(timer);
      saveTimersRef.current.delete(id);
      if (deletedIdsRef.current.has(id)) continue;
      if (persistedBodiesRef.current.get(id) === body) {
        pendingBodiesRef.current.delete(id);
        noteSaveStatesRef.current.set(id, "saved");
        if (selectedIdRef.current === id) setStatus("saved");
        continue;
      }
      const sequence = saveSequencesRef.current.get(id);
      if (sequence === undefined || inFlightSequencesRef.current.get(id) === sequence) continue;
      persistNote(id, body, sequence);
    }
  };

  useEffect(() => {
    const flushPendingSaves = () => flushPendingSavesRef.current();
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flushPendingSaves();
    };
    window.addEventListener("blur", flushPendingSaves);
    window.addEventListener("pagehide", flushPendingSaves);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      window.removeEventListener("blur", flushPendingSaves);
      window.removeEventListener("pagehide", flushPendingSaves);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushPendingSaves();
      if (copyMessageTimerRef.current !== null) {
        window.clearTimeout(copyMessageTimerRef.current);
      }
    };
  }, []);

  const activeNote = notes.find((note) => note.id === selectedId) ?? null;
  const activeBody = activeNote?.body ?? "";
  const activeWordCount = activeNote ? wordCountFor(activeNote) : 0;
  const headerTitle = scratchpadHeaderTitle(activeNote?.title ?? null, status);
  const windowControlMode = scratchpadWindowControlMode(runtimePlatform);
  const filteredNotes = useMemo(() => notes.filter((note) => scratchpadNoteMatches(note, query)), [notes, query]);

  const updateActiveBody = (body: string) => {
    if (!activeNote) return;
    const noteId = activeNote.id;
    if (deletedIdsRef.current.has(noteId)) return;
    replaceNotes(notesRef.current.map((note) => note.id === noteId ? { ...note, body } : note));
    scheduleSave(noteId, body);
  };

  const deleteNote = async (note: ScratchpadNote) => {
    if (deletedIdsRef.current.has(note.id)) return;
    if (!window.confirm(`Delete “${note.title}”?`)) return;
    const unsavedBody = pendingBodiesRef.current.get(note.id)
      ?? (persistedBodiesRef.current.get(note.id) !== note.body ? note.body : undefined);
    const scheduled = saveTimersRef.current.get(note.id);
    if (scheduled !== undefined) window.clearTimeout(scheduled);
    saveTimersRef.current.delete(note.id);
    pendingBodiesRef.current.delete(note.id);
    deletedIdsRef.current.add(note.id);
    setDeletingIds((current) => new Set(current).add(note.id));
    try {
      await window.localScribe.scratchpad.delete(note.id);
      persistedBodiesRef.current.delete(note.id);
      const remaining = notesRef.current.filter((item) => item.id !== note.id);
      inFlightSequencesRef.current.delete(note.id);
      noteSaveStatesRef.current.delete(note.id);
      saveSequencesRef.current.delete(note.id);
      replaceNotes(remaining);
      if (selectedIdRef.current === note.id) {
        const next = remaining[0];
        if (next) selectNote(next.id);
        else await addNewNote();
      }
    } catch {
      deletedIdsRef.current.delete(note.id);
      if (unsavedBody !== undefined && persistedBodiesRef.current.get(note.id) !== unsavedBody) {
        scheduleSave(note.id, unsavedBody, true);
      }
      setStatus("delete-error");
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(note.id);
        return next;
      });
    }
  };

  const showCopyMessage = (message: string, duration: number) => {
    if (copyMessageTimerRef.current !== null) {
      window.clearTimeout(copyMessageTimerRef.current);
    }
    setCopyMessage(message);
    copyMessageTimerRef.current = window.setTimeout(() => {
      copyMessageTimerRef.current = null;
      setCopyMessage(null);
    }, duration);
  };

  const copyNote = async () => {
    if (!activeBody) return;
    try {
      await navigator.clipboard.writeText(activeBody);
      showCopyMessage("Copied", 1_500);
    } catch {
      showCopyMessage("Copy failed", 3_000);
    }
  };

  return (
    <main
      className={`scratchpad-window${notesCollapsed ? " scratchpad-window--notes-collapsed" : ""}`}
      data-window-controls={windowControlMode}
      aria-busy={status === "loading"}
      aria-label="Scratchpad"
    >
      <header className="scratchpad-window__titlebar">
        <div className="scratchpad-window__drag-region" />
        <span className="scratchpad-window__brand-mark" aria-hidden="true">L</span>
        <h1 title={headerTitle}>{headerTitle}</h1>
        <button
          className="scratchpad-window__title-action"
          type="button"
          disabled={!activeNote || deletingIds.has(activeNote.id)}
          onClick={() => activeNote && void deleteNote(activeNote)}
          aria-label="Delete current note"
          title="Delete current note"
        >
          <TrashIcon />
        </button>
        <button className="scratchpad-window__title-action" type="button" disabled={creating || status === "loading"} onClick={() => void addNewNote()} aria-label="New note" title="New note">
          <PlusIcon />
        </button>
        <span className="scratchpad-window__title-spacer" />
        <ScratchpadWindowControls platform={runtimePlatform} />
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
            <button className="scratchpad-window__new-note" type="button" disabled={creating || status === "loading"} onClick={() => void addNewNote()}>
              <PlusIcon /> <span>New note</span>
            </button>

            <label className="scratchpad-window__search">
              <SearchIcon />
              <span className="scratchpad-window__visually-hidden">Search notes</span>
              <input
                type="search"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search notes"
              />
            </label>

            <div className="scratchpad-window__note-list" role="list" aria-label="Saved notes" tabIndex={0}>
              {filteredNotes.map((note) => {
                const noteWordCount = wordCountFor(note);
                const selected = note.id === selectedId;
                const deleting = deletingIds.has(note.id);
                return (
                  <div className={`scratchpad-window__note-row${selected ? " scratchpad-window__note-row--active" : ""}`} role="listitem" aria-busy={deleting} key={note.id}>
                    <button className="scratchpad-window__note-card" type="button" disabled={deleting} onClick={() => selectNote(note.id)} aria-current={selected ? "true" : undefined}>
                      <span className="scratchpad-window__note-icon"><NoteIcon /></span>
                      <span className="scratchpad-window__note-details">
                        <strong>{note.title}</strong>
                        <small>{noteWordCount} {noteWordCount === 1 ? "word" : "words"}</small>
                      </span>
                    </button>
                    <button className="scratchpad-window__delete-note" type="button" disabled={deleting} onClick={() => void deleteNote(note)} aria-label={`Delete ${note.title}`} title="Delete note">
                      <TrashIcon />
                    </button>
                  </div>
                );
              })}
              {notes.length > 0 && filteredNotes.length === 0 && <p className="scratchpad-window__empty-search">No matching notes</p>}
            </div>
          </div>

          <div className="scratchpad-window__notes-bottom" aria-label="Unavailable text tools">
            <button className="scratchpad-window__unavailable" type="button" disabled>
              <WandIcon />
              <span><strong>Generative Rewrite</strong><small>{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</small></span>
            </button>
            <button className="scratchpad-window__unavailable" type="button" disabled>
              <FormattingIcon />
              <span><strong>Formatting</strong><small>{GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE}</small></span>
            </button>
          </div>
        </aside>

        <section className="scratchpad-window__editor-panel" aria-label="Note editor">
          <div className="scratchpad-window__editor-status">
            <span className="scratchpad-window__save-state-announcer" role="status" aria-live="polite">
              {status === "save-error" ? (
                <button
                  className="scratchpad-window__save-state scratchpad-window__save-state--error"
                  type="button"
                  onClick={() => flushPendingSavesRef.current()}
                  title="Retry saving this note"
                >
                  <i aria-hidden="true" /> Save failed — Retry
                </button>
              ) : (
                <span className={`scratchpad-window__save-state scratchpad-window__save-state--${statusTone(status)}`}><i aria-hidden="true" /> {scratchpadStatusLabel(status)}</span>
              )}
            </span>
            {activeNote && <span>{activeWordCount} {activeWordCount === 1 ? "word" : "words"}</span>}
          </div>
          <label className="scratchpad-window__editor">
            <span className="scratchpad-window__visually-hidden">Scratchpad note</span>
            <textarea
              ref={textareaRef}
              value={activeBody}
              onChange={(event) => updateActiveBody(event.target.value)}
              onBlur={() => activeNote && flushScheduledSave(activeNote.id)}
              maxLength={SCRATCHPAD_BODY_MAX_LENGTH}
              placeholder="Start writing…"
              spellCheck
              disabled={!activeNote || deletingIds.has(activeNote.id)}
            />
          </label>
          <footer className="scratchpad-window__editor-footer">
            <button className="scratchpad-window__copy" type="button" disabled={!activeBody} onClick={() => void copyNote()} aria-live="polite">
              <CopyIcon /> {copyMessage ?? "Copy"}
            </button>
          </footer>
        </section>
      </div>
    </main>
  );
}
