import { describe, expect, it } from "vitest";
import { workerLanguageForModel } from "../src/shared/modelLanguage";

const parakeetCapabilities = { supportedLanguages: ["en"] };

describe("worker language resolution", () => {
  it("keeps an already-applied English-only Parakeet runtime usable when legacy settings say Auto", () => {
    expect(workerLanguageForModel("auto", parakeetCapabilities, "Parakeet Unified")).toBe("en");
    expect(workerLanguageForModel("Automatic", parakeetCapabilities, "Parakeet Unified")).toBe("en");
    expect(workerLanguageForModel("English", parakeetCapabilities, "Parakeet Unified")).toBe("en");
  });

  it("still rejects an explicit language that an English-only model cannot transcribe", () => {
    expect(() => workerLanguageForModel("Spanish", parakeetCapabilities, "Parakeet Unified"))
      .toThrow("Set Dictation language to English before applying or dictating with this model.");
  });

  it("preserves Auto for a model that actually supports language detection", () => {
    expect(workerLanguageForModel("auto", {
      supportedLanguages: ["auto", "en", "es"],
    }, "Whisper")).toBe("auto");
  });
});
