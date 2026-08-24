# LocalScribe Wispr-parity redesign

This document records a clean-room product/UI inventory made by observing the installed
Wispr Flow application through macOS Accessibility and screenshots. LocalScribe may reuse
the interaction model, information architecture, and broad visual language, but it must use
the LocalScribe name, an original black `L` mark, original icons, original copy, and no Wispr
assets or source code.

## Design system

- Warm off-white application canvas (`#f5f3ef`) with a slightly darker fixed sidebar.
- White content surface with a 24px top-left radius and thin warm-gray dividers.
- Black primary actions, warm-gray secondary actions, restrained teal for local/privacy state.
- System sans-serif for controls and headings; a restrained serif display face only for
  editorial hero copy and insight callouts.
- Compact 14px navigation, 15px body copy, 24-30px page titles, 12px metadata.
- Cards use 12-16px radii, 1px borders, almost no shadow. Promotional/reference heroes use
  original blurred CSS gradients instead of copied imagery.
- Brand: black rounded-square `L` mark plus `LocalScribe`; never use Wispr's waveform/logo.

## Application shell

- Fixed 196px sidebar: Dictation, Insights, Dictionary, Snippets, Style, Transforms,
  Scratchpad; Settings and Local-only status at the bottom.
- Main content sits in a large white rounded panel and scrolls independently.
- Window target: about 1220x760, responsive down to 900px.
- No team invites, referrals, account billing, or cloud-sync upsells. Those cloud-only areas
  are replaced by an always-visible `Local only` privacy status and local model information.

## Screens

### Dictation

- `Welcome back` heading, local-processing hero, today-grouped transcript rows, search toggle,
  copy and overflow actions, and right-side statistics/profile cards.
- Transcript actions stay local: copy, delete, export, clear. Never expose transcript bodies
  to the network.

### Insights

- Tabs: Usage and Voice profile. Team leaderboard is omitted because LocalScribe has no team
  service.
- Usage cards derive word count, estimated WPM, duration, app count, source-app categories,
  and recent streak data from encrypted local transcript metadata.
- Voice profile is a deterministic, clearly labeled local summary; it must not pretend to be
  a generative analysis.

### Dictionary and snippets

- Header with black `Add new` action, search, a dismissible original onboarding hero, and
  bordered list rows.
- Add/edit surfaces are centered modals. Dictionary supports heard phrase and preferred
  spelling. Snippets support spoken trigger and expansion.
- No sharing/team controls.

### Style

- Tabs: Personal messages, Work messages, Email, Other, Auto cleanup.
- Style cards: Formal, Casual, Very casual/Excited where appropriate, with realistic preview
  cards. Existing local app profiles remain reachable from this screen.
- Auto cleanup levels: None, Light, Medium. Only behavior implemented by the deterministic
  local cleanup pipeline may be promised.

### Transforms

- Local deterministic controls for Polish and spoken structure, plus a
  custom-rule editor surface. These perform exact, source-defined transforms.
- Concise semantic rewriting remains visibly disabled because it requires a
  separately installed local text-generation model. The ASR model does not
  provide rewriting, and deterministic cleanup must not be described as an LLM
  transformation.

### Scratchpad

- Wispr-like hero, search/new controls, recent-note cards, and a full-height encrypted editor.
- Local-only banner replaces cloud-sync marketing.

### Settings modal

- Modal overlay with internal sidebar: General, System, Writing, Experimental, Data & Privacy.
- General: hold-to-talk shortcut, microphone, dictation language, app language, permissions.
- System: login item, floating bar, automatic paste, history, retention, cleanup, model status.
- Writing: app profiles, style/cleanup explanation, dictionary/snippet shortcuts.
- Experimental: command mode, press-enter command, stacked messages, bulk import (only mark a
  switch active when its behavior exists).
- Data & Privacy: local-only processing, context boundaries, encrypted storage, export, clear,
  model removal, data/model paths, diagnostics.

## Floating bar

- Idle state collapses to a quiet 42x7 warm-gray/black capsule at bottom center.
- Hover/focus expands to an original compact LocalScribe control with the black `L`, shortcut
  hint, and settings action.
- Listening expands to a dark capsule with an original animated waveform; processing shows a
  restrained progress treatment; success/error collapse after feedback.
- Microphone access is never triggered merely to inspect or hover over the bar.

## Privacy and correctness boundaries

- Preserve sandboxed renderer, narrow validated IPC, OS-encrypted private text fields, raw-audio deletion,
  target-guarded insertion, conditional clipboard restoration, pinned model revision/hash,
  hardened fuses, and no listening server.
- Never copy Wispr source, assets, screenshots, account/team data, private text, or proprietary
  wording into LocalScribe.
- UI controls must either call an existing local implementation or clearly communicate that
  they are informational; no deceptive functional parity.
