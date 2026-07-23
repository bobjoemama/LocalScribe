import type { LocalScribeApi } from "./contracts";

declare global {
  interface Window {
    localScribe: LocalScribeApi;
  }
}

export {};
