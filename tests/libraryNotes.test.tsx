import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dictionaryEntrySchema, snippetSchema } from "../src/shared/contracts";
import {
  DICTIONARY_PHRASE_MAX_LENGTH,
  DICTIONARY_REPLACEMENT_MAX_LENGTH,
  DictionaryModal,
  DictionaryScreen,
  LibraryModal,
  SNIPPET_EXPANSION_MAX_LENGTH,
  SNIPPET_TRIGGER_MAX_LENGTH,
  libraryCountLabel,
  libraryErrorMessage,
  libraryListMessage,
  modalTabTarget,
  shouldShowLibraryHero,
  SnippetModal,
  SnippetsScreen,
} from "../src/renderer/settings/screens/LibraryNotes";

const libraryCss = readFileSync(
  resolve(process.cwd(), "src/renderer/settings/screens/library-notes.css"),
  "utf8",
);

describe("library page states", () => {
  it("presents safe library failures without Windows or macOS local paths", () => {
    expect(libraryErrorMessage(
      new Error("SQLITE_CANTOPEN at C:\\Users\\Alice\\AppData\\Local\\LocalScribe\\localscribe.db"),
      "Your local dictionary could not be loaded.",
    )).toBe("Your local dictionary could not be loaded.");
    expect(libraryErrorMessage(
      new Error("SQLITE_CANTOPEN at /Users/Alice/Library/Application Support/LocalScribe/localscribe.db"),
      "Your local snippets could not be loaded.",
    )).toBe("Your local snippets could not be loaded.");
    expect(libraryErrorMessage(
      new Error("That term is already in your dictionary."),
      "LocalScribe could not save this term.",
    )).toBe("That term is already in your dictionary.");
  });

  it("derives editor limits from the shared persistence contracts", () => {
    expect(DICTIONARY_PHRASE_MAX_LENGTH).toBe(
      dictionaryEntrySchema.shape.phrase.maxLength,
    );
    expect(DICTIONARY_REPLACEMENT_MAX_LENGTH).toBe(
      dictionaryEntrySchema.shape.replacement.maxLength,
    );
    expect(SNIPPET_TRIGGER_MAX_LENGTH).toBe(snippetSchema.shape.trigger.maxLength);
    expect(SNIPPET_EXPANSION_MAX_LENGTH).toBe(snippetSchema.shape.expansion.maxLength);

    const modalProps = {
      onClose: () => undefined,
      onSaved: async () => undefined,
    };
    const dictionaryHtml = renderToStaticMarkup(
      createElement(DictionaryModal, modalProps),
    );
    const snippetsHtml = renderToStaticMarkup(
      createElement(SnippetModal, modalProps),
    );
    expect(dictionaryHtml).toContain(`maxLength="${DICTIONARY_PHRASE_MAX_LENGTH}"`);
    expect(dictionaryHtml).toContain(`maxLength="${DICTIONARY_REPLACEMENT_MAX_LENGTH}"`);
    expect(snippetsHtml).toContain(`maxLength="${SNIPPET_TRIGGER_MAX_LENGTH}"`);
    expect(snippetsHtml).toContain(`maxLength="${SNIPPET_EXPANSION_MAX_LENGTH}"`);
    expect(snippetsHtml).toContain(
      `/ ${SNIPPET_EXPANSION_MAX_LENGTH.toLocaleString()} characters`,
    );
  });

  it("shows onboarding only after a successful empty load and honors dismissal", () => {
    expect(shouldShowLibraryHero(0, true, false, false)).toBe(false);
    expect(shouldShowLibraryHero(0, false, true, false)).toBe(false);
    expect(shouldShowLibraryHero(2, false, false, false)).toBe(false);
    expect(shouldShowLibraryHero(0, false, false, true)).toBe(false);
    expect(shouldShowLibraryHero(0, false, false, false)).toBe(true);
  });

  it("does not claim zero persisted items while counts are unresolved", () => {
    expect(libraryCountLabel("dictionary", 0, "loading")).toBe("Loading…");
    expect(libraryCountLabel("snippets", 0, "unavailable")).toBe("Unavailable");
    expect(libraryCountLabel("dictionary", 1, "ready")).toBe("1 term");
    expect(libraryCountLabel("snippets", 2, "ready")).toBe("2 snippets");
  });

  it("does not present a failed initial load as a valid empty library", () => {
    expect(libraryListMessage("dictionary", "", true)).toEqual({
      title: "Dictionary unavailable",
      body: "Try loading your local terms again.",
    });
    expect(libraryListMessage("snippets", "", true)).toEqual({
      title: "Snippets unavailable",
      body: "Try loading your local snippets again.",
    });
  });

  it("keeps empty and search states specific without calling snippets keyboard shortcuts", () => {
    expect(libraryListMessage("dictionary", "name", false)).toEqual({
      title: "No matching terms",
      body: "Try another search.",
    });
    expect(libraryListMessage("snippets", "sign off", false)).toEqual({
      title: "No matching snippets",
      body: "Try another search.",
    });
    expect(libraryListMessage("snippets", "", false).title).toBe(
      "Create your first spoken snippet",
    );
  });

  it("announces loading without fixture-like onboarding or enabled mutations", () => {
    const dictionaryHtml = renderToStaticMarkup(createElement(DictionaryScreen));
    const snippetsHtml = renderToStaticMarkup(createElement(SnippetsScreen));

    for (const html of [dictionaryHtml, snippetsHtml]) {
      expect(html).toContain('class="ln-page-frame"');
      expect(html).toContain('aria-busy="true"');
      expect(html).toContain('role="status"');
      expect(html).toContain("Loading…");
      expect(html).toContain('class="ln-primary" type="button" disabled=""');
      expect(html).not.toContain('class="ln-hero"');
      expect(html).not.toContain("0 terms");
      expect(html).not.toContain("0 snippets");
    }
  });
});

describe("library responsive layout", () => {
  it("responds to the content pane width rather than the wider Electron viewport", () => {
    expect(libraryCss).toMatch(
      /\.ln-page-frame\s*\{[^}]*container-type:\s*inline-size\s*;/s,
    );
    expect(libraryCss).toContain("@container (max-width: 840px)");
    expect(libraryCss).toContain("@container (max-width: 650px)");
    expect(libraryCss).not.toContain("@media (max-width: 840px)");
  });
});

describe("library dialog keyboard behavior", () => {
  it("wraps Tab at both ends of the dialog and directs outside focus inward", () => {
    expect(modalTabTarget(2, 3, false)).toBe(0);
    expect(modalTabTarget(0, 3, true)).toBe(2);
    expect(modalTabTarget(-1, 3, false)).toBe(0);
    expect(modalTabTarget(-1, 3, true)).toBe(2);
    expect(modalTabTarget(1, 3, false)).toBeNull();
    expect(modalTabTarget(0, 0, false)).toBeNull();
  });

  it("renders a named modal focus boundary", () => {
    const html = renderToStaticMarkup(
      createElement(
        LibraryModal,
        {
          title: "Test dialog",
          description: "Test description",
          onClose: () => undefined,
          children: createElement("button", { type: "button" }, "Action"),
        },
      ),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="ln-modal-test-dialog"');
    expect(html).toContain('aria-describedby="ln-modal-test-dialog-description"');
    expect(html).toContain('tabindex="-1"');
  });
});
