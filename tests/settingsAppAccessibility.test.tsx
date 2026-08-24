import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsApp } from "../src/renderer/settings/SettingsApp";

describe("settings app shell accessibility", () => {
  it("exposes the active destination and settings dialog relationship to assistive technology", () => {
    const html = renderToStaticMarkup(createElement(SettingsApp));

    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html.match(/<main\b/g)).toHaveLength(1);
  });
});
