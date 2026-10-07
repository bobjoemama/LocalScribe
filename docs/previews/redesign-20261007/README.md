# October 7 redesign captures

Production React renderers use synthetic transcripts, model states and IPC fixtures.
These captures contain no user records and do not measure recognition performance.
The version shown in the workspace fixture is synthetic dev.20; the installed
package is dev.21 with the same final renderer code.

`light` and `dark` retain selected screenshots and full `layout-report.json` reports
from the 16 native Chromium scenarios at 1220×760 and 900×640. Each complete
temporary capture set had 70 screenshots. Coverage includes Dictation, search and
menus, Insights, Dictionary/Snippets dialogs and errors, Cleanup, Models operation
states and guards, Settings, focus and appearance persistence.

`pill-notes` contains 18 captures and `evidence.json` from the actual production
Notes/pill renderers. Real fixture interactions verify pending-save drain before
Escape, failed-save retention, Retry/Copy and live review/Latest. Audio, clipboard,
models, user storage and the installed app are stubbed or untouched.

Hidden-window static repaint omissions were resolved with Electron offscreen
rendering and explicit invalidation. This was a capture issue; production code
was unchanged. Physical microphone-to-target delivery remains user-operated.
