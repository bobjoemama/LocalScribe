import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  rendererUrlForSurface,
  resolvePackagedRendererPath,
} from "../src/main/rendererProtocol";

const rendererRoot = path.resolve("/tmp/localscribe-renderer");

describe("packaged renderer protocol", () => {
  it("uses a single local origin in packaged builds and preserves the surface query", () => {
    expect(rendererUrlForSurface("pill")).toBe("localscribe://app/index.html?surface=pill");
    expect(rendererUrlForSurface("settings")).toBe("localscribe://app/index.html?surface=settings");
  });

  it("keeps Vite's development-server origin and existing query parameters", () => {
    expect(rendererUrlForSurface("scratchpad", "http://127.0.0.1:5173/?token=dev"))
      .toBe("http://127.0.0.1:5173/?token=dev&surface=scratchpad");
  });

  it("maps only bundled paths below the renderer root", () => {
    expect(resolvePackagedRendererPath("localscribe://app/index.html?surface=pill", rendererRoot))
      .toBe(path.join(rendererRoot, "index.html"));
    expect(resolvePackagedRendererPath("localscribe://app/assets/main.js", rendererRoot))
      .toBe(path.join(rendererRoot, "assets", "main.js"));
    expect(resolvePackagedRendererPath("localscribe://app/", rendererRoot))
      .toBe(path.join(rendererRoot, "index.html"));
  });

  it("rejects an unexpected origin, credentials, ports, and traversal attempts", () => {
    for (const requestUrl of [
      "https://app/index.html",
      "localscribe://other/index.html",
      "localscribe://app:443/index.html",
      "localscribe://user@app/index.html",
      "localscribe://app/../secret.txt",
      "localscribe://app/%2e%2e/secret.txt",
      "localscribe://app/assets%2f..%2fsecret.txt",
      "localscribe://app/assets%5c..%5csecret.txt",
      "localscribe://app/%zz",
    ]) {
      expect(resolvePackagedRendererPath(requestUrl, rendererRoot)).toBeNull();
    }
  });
});
