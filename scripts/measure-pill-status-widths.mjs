/**
 * Measures every status string the pill can display, in Chromium, at the exact
 * type shipped by `.pill__status-copy`.
 *
 * `PILL_LAYOUT.status.width` is a fixed number — the pill is centred on the work
 * area, so a width that tracked the current message would slide the window
 * sideways under a stationary pointer on every status change. That fixed number
 * has to be large enough for the longest message, and the only way to know it is
 * to measure. `tests/pillLayout.test.ts` pins the table this prints; when it
 * fails because a message was added or reworded, re-run:
 *
 *   npx electron scripts/measure-pill-status-widths.mjs
 *
 * and update both the pinned table and `STATUS_COPY_WIDTH`.
 */
import { app, BrowserWindow } from "electron";

/** Kept in sync with the pinned set in tests/pillLayout.test.ts. */
const MESSAGES = [
  "Ready",
  "Listening",
  "Finishing",
  "Finishing recording",
  "Finishing Live dictation",
  "Transcribing",
  "Transcribing locally",
  "Inserting",
  "Copying",
  "Inserted",
  "Inserted · copied as backup",
  "Copied to clipboard",
  "Copied — allow Accessibility",
  "Done",
  "Try again",
];

// .pill--status padding (8 + 6) + .pill__status-mark (22) + .pill__status-close
// (22) + two 7px flex gaps. tests/pillLayout.test.ts re-derives this from the
// stylesheet so a chrome change cannot silently invalidate the measurement.
const CHROME = 8 + 6 + 22 + 22 + 7 + 7;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await window.loadURL("data:text/html,<title>pill status measurement</title>");
  const measured = await window.webContents.executeJavaScript(`(() => {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;"
      + "font-size:10px;font-weight:600;"
      + "font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI Variable Text','Segoe UI',sans-serif";
    document.body.appendChild(probe);
    return ${JSON.stringify(MESSAGES)}.map((message) => {
      probe.textContent = message;
      return [message, Math.ceil(probe.getBoundingClientRect().width)];
    });
  })()`);

  for (const [message, width] of measured) {
    console.log(`${String(width).padStart(4)}px copy · ${String(width + CHROME).padStart(4)}px box   ${message}`);
  }
  const widest = Math.max(...measured.map(([, width]) => width));
  console.log(`\nchrome ${CHROME}px · widest copy ${widest}px · required box ${widest + CHROME}px`);
  app.exit(0);
});
