import { describe, expect, it } from "vitest";
import {
  nativeHelperEnvironment,
  validatedWindowsRuntimeEnvironment,
} from "../src/main/nativeHelperEnvironment";

describe("native helper child-process environment", () => {
  it("forwards nothing to the macOS helper", () => {
    expect(nativeHelperEnvironment("darwin", {
      PATH: "/untrusted/bin",
      HF_TOKEN: "secret",
      HTTPS_PROXY: "http://proxy.invalid",
    })).toEqual({});
  });

  it("forwards only non-secret Windows runtime locations", () => {
    expect(nativeHelperEnvironment("win32", {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      PATH: "C:\\untrusted",
      HF_TOKEN: "secret",
      HTTPS_PROXY: "http://proxy.invalid",
    })).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
    });
  });

  it("normalizes aliases that identify the same Windows directory", () => {
    expect(validatedWindowsRuntimeEnvironment({
      SystemRoot: "C:/Windows/",
      WINDIR: "c:\\windows",
    })).toEqual({
      SystemRoot: "C:\\Windows",
      WINDIR: "c:\\windows",
    });
  });

  it.each([
    [{ SystemRoot: "Windows" }, /drive-absolute/u],
    [{ SystemRoot: "\\\\server\\share\\Windows" }, /drive-absolute/u],
    [{ SystemRoot: "C:\\Windows\0evil" }, /clean absolute/u],
    [{ SystemRoot: " C:\\Windows" }, /clean absolute/u],
    [{ SystemRoot: "C:\\Windows", WINDIR: "D:\\Windows" }, /same Windows directory/u],
  ])("rejects malformed or disagreeing Windows runtime locations", (environment, expected) => {
    expect(() => validatedWindowsRuntimeEnvironment(environment)).toThrow(expected);
  });
});
