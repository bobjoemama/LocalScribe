import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Pill } from "./pill/Pill";
import { ScratchpadWindow } from "./scratchpad/ScratchpadWindow";
import { SettingsApp } from "./settings/SettingsApp";
import "./styles.css";

const surface = new URLSearchParams(window.location.search).get("surface");
document.documentElement.dataset.surface = surface ?? "settings";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {surface === "pill" ? <Pill /> : surface === "scratchpad" ? <ScratchpadWindow /> : <SettingsApp />}
  </StrictMode>,
);
