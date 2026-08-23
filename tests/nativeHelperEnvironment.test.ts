import { describe, expect, it } from "vitest";
import { nativeHelperEnvironment } from "../src/main/nativeHelperEnvironment";

describe("native helper child-process environment", () => {
  it("forwards no ambient values to the macOS helper", () => {
    expect(nativeHelperEnvironment("darwin", {
      PATH: "/untrusted/bin",
      HF_TOKEN: "secret",
      HTTPS_PROXY: "http://proxy.invalid",
    })).toEqual({});
  });
});
