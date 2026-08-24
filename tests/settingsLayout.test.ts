import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsModal } from "../src/renderer/settings/screens/StyleSettings";

const settingsCss = readFileSync(
  resolve(process.cwd(), "src/renderer/settings/screens/style-settings.css"),
  "utf8",
);

function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = settingsCss.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

describe("settings modal layout", () => {
  it("constrains the content grid so long settings pages scroll instead of expanding behind the footer", () => {
    expect(declarations(".ls-settings-modal")).toMatch(/min-height:\s*0\s*;/);

    const main = declarations(".ls-settings-main");
    expect(main).toMatch(/min-height:\s*0\s*;/);
    expect(main).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/);
    expect(main).toMatch(/overflow:\s*hidden\s*;/);

    const scroll = declarations(".ls-settings-scroll");
    expect(scroll).toMatch(/min-height:\s*0\s*;/);
    expect(scroll).toMatch(/overflow-y:\s*auto\s*;/);
    expect(scroll).toMatch(/padding:\s*22px\s+24px\s+68px\s*;/);
  });

  it("keeps the sidebar chrome fixed while allowing its category list to scroll at short window heights", () => {
    const sidebar = declarations(".ls-settings-sidebar");
    expect(sidebar).toMatch(/min-height:\s*0\s*;/);
    expect(sidebar).toMatch(/grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)\s+auto\s*;/);

    const navigation = declarations(".ls-settings-sidebar nav");
    expect(navigation).toMatch(/min-height:\s*0\s*;/);
    expect(navigation).toMatch(/overflow-y:\s*auto\s*;/);
  });

  it("places a keyboard-scrollable content region between the fixed header and footer", () => {
    const html = renderToStaticMarkup(createElement(SettingsModal, {
      onClose: () => undefined,
    }));
    const header = html.indexOf('class="ls-settings-header"');
    const scroll = html.indexOf('class="ls-settings-scroll"');
    const footer = html.indexOf('class="ls-settings-footer"');

    expect(header).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(header);
    expect(footer).toBeGreaterThan(scroll);
    expect(html).toContain('class="ls-settings-scroll" role="region" aria-labelledby="settings-title"');
    expect(html).toContain('tabindex="0"');
  });

  it("keeps the model confirmation reachable while a long catalog scrolls", () => {
    const apply = declarations(".ls-model-apply-card");
    expect(apply).toMatch(/position:\s*sticky\s*;/);
    expect(apply).toMatch(/top:\s*0\s*;/);

    expect(settingsCss).toMatch(/\.ls-settings-modal button,[\s\S]*?cursor:\s*default !important\s*;/);
    expect(declarations(".ls-model-experience-options")).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
  });
});
