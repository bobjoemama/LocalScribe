import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sharedCss = readFileSync("src/renderer/styles.css", "utf8");
const workspaceCss = readFileSync("src/renderer/workspace-theme.css", "utf8");
const styleCss = readFileSync("src/renderer/settings/screens/style-settings.css", "utf8");
const settingsSource = readFileSync("src/renderer/settings/screens/StyleSettings.tsx", "utf8");
const librarySource = readFileSync("src/renderer/settings/screens/LibraryNotes.tsx", "utf8");

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function appearanceColor(token: string, appearance: "light" | "dark", visited = new Set<string>()): string {
  expect(visited.has(token), `Circular semantic token: ${token}`).toBe(false);
  visited.add(token);
  const declaration = workspaceCss.match(new RegExp(`--${token}:\\s*([^;]+);`, "iu"))?.[1]?.trim();
  expect(declaration, `Missing semantic appearance token: ${token}`).toBeDefined();
  const alias = declaration?.match(/^var\(\s*--([a-z0-9-]+)\s*\)$/iu)?.[1];
  if (alias) return appearanceColor(alias, appearance, visited);
  const dynamic = declaration?.match(/^light-dark\(\s*(#[a-f0-9]{3,6}),\s*(#[a-f0-9]{3,6})\s*\)$/iu);
  const color = dynamic?.[appearance === "light" ? 1 : 2] ?? declaration;
  expect(color, `Unsupported semantic color: ${token}`).toMatch(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu);
  return color!.length === 4 ? `#${[...color!.slice(1)].map(channel => channel + channel).join("")}` : color!;
}

describe("renderer contrast contract", () => {
  for (const appearance of ["light", "dark"] as const) {
    it(`keeps essential semantic ${appearance} text at or above WCAG AA`, () => {
      const pairs = [
        ["ink", "surface"], ["muted", "surface"], ["faint", "surface-soft"], ["faint", "canvas"],
        ["ink", "surface-raised"], ["muted", "surface-raised"],
        ["selection-ink", "accent-soft"], ["accent", "surface-raised"],
        ["local", "local-soft"], ["danger", "danger-soft"], ["warning", "warning-soft"],
      ];
      for (const [foreground, background] of pairs) {
        expect(contrast(appearanceColor(foreground!, appearance), appearanceColor(background!, appearance)), `${appearance}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
      for (const action of ["action-fill", "action-hover", "action-pressed"]) {
        expect(contrast(appearanceColor("on-accent", appearance), appearanceColor(action, appearance)), `${appearance}: primary action ${action}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`keeps enabled custom ${appearance} control boundaries above the 3:1 floor`, () => {
      for (const background of ["surface", "surface-soft", "surface-raised"]) {
        for (const foreground of ["control-line", "accent"]) {
          expect(contrast(appearanceColor(foreground, appearance), appearanceColor(background, appearance)), `${appearance}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(3);
        }
      }
      // The shipped switch uses the inverse accent knob, muted off track and
      // semantic success on track. Check both against their containing surface.
      expect(workspaceCss).toContain(".ls-switch::after { background: var(--on-accent); }");
      expect(workspaceCss).toContain(".ls-switch:checked { background: var(--success); }");
      expect(styleCss).toMatch(/\.ls-switch \{[^}]*background: var\(--muted\);/u);
      for (const background of ["muted", "success"]) {
        expect(contrast(appearanceColor("on-accent", appearance), appearanceColor(background, appearance)), `${appearance}: switch knob on ${background}`).toBeGreaterThanOrEqual(3);
        expect(contrast(appearanceColor(background, appearance), appearanceColor("surface", appearance)), `${appearance}: switch track on surface`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});

describe("renderer operation latches", () => {
  it("uses one synchronous latch for every user-started model operation", () => {
    expect(settingsSource).not.toContain("modelApplyInFlight");
    expect(settingsSource).not.toContain("modelLibraryActionInFlight");
    expect(settingsSource.match(/if \(modelOperationInFlight\.current\) return;/g)).toHaveLength(4);
    expect(settingsSource).toContain("if (!settings || modelOperationInFlight.current) return;");
    expect(settingsSource.match(/modelOperationInFlight\.current = true;/g)).toHaveLength(6);
  });

  it("guards bulk installs before awaiting and releases the shared latch", () => {
    const bulk = settingsSource.slice(settingsSource.indexOf("  const installAllModels = async"), settingsSource.indexOf("  const removeModel = async"));
    expect(bulk).toContain("if (modelOperationInFlight.current || !modelCatalog) return;");
    const latch = bulk.indexOf("modelOperationInFlight.current = true;");
    const firstAwait = bulk.indexOf("await ");
    expect(latch).toBeGreaterThan(bulk.indexOf("if (!window.confirm(confirmation)) return;"));
    expect(firstAwait).toBeGreaterThan(latch);
    expect(bulk).toMatch(/finally \{\s*modelOperationInFlight\.current = false;\s*setModelAction\(null\);\s*setInstallingAllModels\(false\);/);
    expect(bulk).toContain("if (downloads.length === 0 && familiesToAdd.length === 0)");
    expect(bulk.indexOf("for (const family of familiesToAdd)")).toBeLessThan(bulk.indexOf("for (const item of downloads)"));
    expect(bulk).not.toContain("setPendingModelSelection");
    expect(bulk).not.toContain("applyModelSelection");
  });

  it("latches ordinary and cleanup saves before awaiting persistence", () => {
    expect(settingsSource).toContain("if (!settings || settingsSaveInFlight.current) return;");
    expect(settingsSource).toContain("settingsSaveInFlight.current = true;");
    expect(settingsSource).toContain("if (!settings || cleanupSaveInFlight.current) return;");
    expect(settingsSource).toContain("cleanupSaveInFlight.current = true;");
  });
});

describe("library modal and load lifecycle", () => {
  it("accepts only the latest mounted list result", () => {
    expect(librarySource.match(/sequence === loadSequence\.current/g)).toHaveLength(6);
    expect(librarySource.match(/loadSequence\.current \+= 1/g)).toHaveLength(2);
  });

  it("makes the page inert behind each add dialog and blocks dismissal while saving", () => {
    expect(librarySource.match(/<div inert=\{showAdd\}>/g)).toHaveLength(2);
    expect(librarySource.match(/libraryEditorCanClose\(saveInFlight\.current, changed, \(\) => window\.confirm\(/g)).toHaveLength(2);
    expect(librarySource).toMatch(/export function libraryEditorCanClose[\s\S]*?if \(saving\) return false;/u);
    expect(librarySource.match(/busy=\{saving\}/g)).toHaveLength(2);
  });
});

describe("confirmed renderer cleanup", () => {
  it("keeps full read-only values visible and removes dead selectors", () => {
    const readOnlyRule = styleCss.slice(
      styleCss.indexOf(".ls-readonly-value {"),
      styleCss.indexOf("}", styleCss.indexOf(".ls-readonly-value {")),
    );
    expect(readOnlyRule).toContain("overflow-wrap: anywhere");
    expect(readOnlyRule).toContain("white-space: normal");
    expect(readOnlyRule).not.toContain("text-overflow: ellipsis");

    for (const deadSelector of [
      ".screen-page",
      ".screen-heading",
      ".danger-button",
      ".ls-rule-input",
      ".ls-model-row",
      ".ls-model-dot",
      ".ls-model-unknown-actions",
    ]) {
      expect(`${sharedCss}\n${styleCss}`).not.toContain(deadSelector);
    }
  });
});
