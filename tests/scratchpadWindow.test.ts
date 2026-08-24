import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE } from "../src/renderer/generativeTextAvailability";
import { scratchpadNoteSchema } from "../src/shared/contracts";
import {
  ScratchpadWindow,
  ScratchpadWindowControls,
  scratchpadHeaderTitle,
  scratchpadInitialLoadAction,
  scratchpadIntegrityWarning,
  scratchpadStatusLabel,
  scratchpadWindowControlMode,
  shouldShowCustomWindowActions,
} from "../src/renderer/scratchpad/ScratchpadWindow";

const scratchpadCss = readFileSync(
  resolve(process.cwd(), "src/renderer/scratchpad/scratchpad-window.css"),
  "utf8",
);
const scratchpadSource = readFileSync(
  resolve(process.cwd(), "src/renderer/scratchpad/ScratchpadWindow.tsx"),
  "utf8",
);

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = scratchpadCss.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

function mediaBlock(query: string): string {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = scratchpadCss.match(new RegExp(`@media ${escaped} \\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`Missing media query for ${query}`);
  return match[1]!;
}

describe("scratchpad window presentation", () => {
  it("uses operation-specific status copy", () => {
    expect(scratchpadStatusLabel("save-error")).toBe("Save failed");
    expect(scratchpadStatusLabel("load-error")).toBe("Notes unavailable");
    expect(scratchpadStatusLabel("create-error")).toBe("Note creation failed");
    expect(scratchpadStatusLabel("delete-error")).toBe("Delete failed");
  });

  it("does not invent a persisted note title while data is loading or unavailable", () => {
    expect(scratchpadHeaderTitle(null, "loading")).toBe("Loading notes…");
    expect(scratchpadHeaderTitle(null, "load-error")).toBe("Scratchpad");
    expect(scratchpadHeaderTitle("Persisted note", "saved")).toBe("Persisted note");
  });

  it("distinguishes a genuinely empty scratchpad from all-unreadable storage", () => {
    expect(scratchpadInitialLoadAction({ items: [], totalStored: 0 })).toBe("create");
    expect(scratchpadInitialLoadAction({ items: [], totalStored: 2 })).toBe("blocked-unreadable");
    expect(scratchpadInitialLoadAction({
      items: [{ id: "n", title: "Note", body: "", createdAt: 1, updatedAt: 1 }],
      totalStored: 2,
    })).toBe("select");
    expect(scratchpadIntegrityWarning(0)).toBeNull();
    expect(scratchpadIntegrityWarning(2)).toContain("will not overwrite it");
  });

  it("uses the custom macOS window controls", () => {
    expect(shouldShowCustomWindowActions()).toBe(true);
    expect(scratchpadWindowControlMode()).toBe("custom");

    const macControls = renderToStaticMarkup(
      createElement(ScratchpadWindowControls, { onClose: () => undefined }),
    );
    expect(macControls).toContain('aria-label="Toggle expanded Scratchpad"');
    expect(macControls).toContain('aria-label="Close Scratchpad"');
    expect(scratchpadSource).not.toContain("window.localScribe.system.appInfo()");
    expect(scratchpadSource).not.toContain("navigator.userAgent");
    expect(scratchpadSource).not.toContain("shortcutDisplayPlatform");
  });

  it("flushes and awaits pending note writes before closing", () => {
    expect(scratchpadSource).toContain("if (!await drainPendingSaves())");
    expect(scratchpadSource).toContain("await window.localScribe.windows.closeScratchpad()");
    expect(scratchpadSource.indexOf("if (!await drainPendingSaves())"))
      .toBeLessThan(scratchpadSource.indexOf("await window.localScribe.windows.closeScratchpad()"));
    expect(scratchpadSource).toContain("inFlightSavePromisesRef");
  });

  it("does not auto-create over an all-unreadable stored scratchpad", () => {
    expect(scratchpadInitialLoadAction({ items: [], totalStored: 1 })).toBe("blocked-unreadable");
    expect(scratchpadSource).toContain('loadAction === "blocked-unreadable"');
  });

  it("renders a bounded editor and keyboard-scrollable note list", () => {
    const html = renderToStaticMarkup(createElement(ScratchpadWindow));
    expect(html).toContain('data-window-controls="custom"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toContain('role="list" aria-label="Saved notes" tabindex="0"');
    expect(html).toContain(`maxLength="${scratchpadNoteSchema.shape.body.maxLength}"`);
    expect(html).toContain("Loading notes…");
    expect(html).not.toContain("0 words");
    expect(html).not.toContain("On-device only");
    expect(html).not.toContain("Stored locally");
    expect(html).toContain("Generative Rewrite");
    expect(html).toContain("Formatting");
    expect(html.match(new RegExp(GENERATIVE_TEXT_MODEL_REQUIRED_NOTICE, "g"))).toHaveLength(2);
    expect(html.match(/class="scratchpad-window__unavailable" type="button" disabled=""/g)).toHaveLength(2);
    expect(html).not.toContain("not installed");
    expect(html).not.toContain("Additional generative text model required");
  });

  it("constrains short-window overflow while retaining a visible editor focus state", () => {
    expect(declarations(".scratchpad-window__workspace")).toMatch(/overflow:\s*hidden\s*;/);
    expect(declarations(".scratchpad-window__notes")).toMatch(/min-height:\s*0\s*;/);
    expect(declarations(".scratchpad-window__notes")).toMatch(
      /grid-template-rows:\s*40px\s+minmax\(0,\s*1fr\)\s+minmax\(0,\s*auto\)\s*;/,
    );
    expect(declarations(".scratchpad-window__notes-bottom")).toMatch(/overflow-y:\s*auto\s*;/);
    expect(declarations(".scratchpad-window__editor:focus-within")).toMatch(/box-shadow:/);

    const shortWindowRules = mediaBlock("(max-height: 360px)");
    expect(shortWindowRules).toContain(".scratchpad-window__notes-bottom { display: none; }");
    expect(shortWindowRules).toContain(".scratchpad-window__editor textarea");
  });
});
