# Agent Composer Controls — Research Findings & Design Proposal

Status: **research + proposal only, no code changed**. Written for review before any implementation.

Methodology: every claim below is tagged with how it was verified:
- **[BINARY]** — confirmed by running the actual installed CLI (`claude --version 2.1.207`, `codex-cli 0.139.0`, `kimi 0.27.0`) in this environment, or a live ACP JSON-RPC handshake against `kimi acp`.
- **[SCHEMA]** — confirmed from a generated protocol schema (`codex app-server generate-json-schema`), which describes a protocol surface this app does **not currently use** (see Codex section).
- **[DOCS]** — vendor documentation only, not independently verified against the binary in this environment. Treated as lower-confidence.
- **[APP]** — read directly from this repo's source, with file:line citations.

---

## 0. Headline findings (read this part first)

1. **Kimi's ACP layer already ships a native permission-mode select** (`default | plan | auto | yolo`, matching the CLI's own `--plan/--auto/--yolo` flags) **[BINARY — live `session/new` handshake]**. This app ignores it and instead runs its own client-side 5-tier interception scheme (`PERMISSION_MODES` in [KimiTab.tsx:67](src/renderer/src/components/KimiTab.tsx:67)). Worse, the native `mode` config option isn't filtered out of the generic model-picker submenu, so it likely already surfaces today as a stray, unlabeled "Mode" row with 4 options buried inside `KimiModelPicker`, redundant with and disconnected from the composer's dedicated permission `<select>`. This is a real, confirmed duplication, not a hypothetical.
2. **Claude Code's CLI supports six permission modes** (`acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` — `claude --help`) **[BINARY]**, but this app hardcodes `--permission-mode acceptEdits` on every spawn ([claudecode.ts:227-228](src/main/claudecode.ts:227)) with **no UI control at all**. This is the single biggest gap of the three tabs.
3. **Codex CLI has two independent permission axes** — sandbox (`-s read-only|workspace-write|danger-full-access`) and approval policy (`-a untrusted|on-request|never`, plus deprecated `on-failure`) **[BINARY]**. The app only ever passes `-s`; `-a`/`--ask-for-approval` is never constructed anywhere in [codex.ts](src/main/codex.ts) (confirmed by grep — zero matches). The composer's 3-way sandbox pill is real and correct, but it's silently missing half of Codex's real permission model.
4. Claude Code has **no CLI flag for thinking budget** — it's controlled by the `MAX_THINKING_TOKENS` env var, and is a no-op on adaptive-reasoning models (Sonnet 5, Opus 4.7+, Fable 5 "always use adaptive reasoning and have no fixed-budget mode") **[DOCS, code.claude.com/docs/en/desktop]**. The app's thinking toggle already implements this correctly via env var ([claudecode.ts:295-297](src/main/claudecode.ts:295)), but the toggle state isn't persisted (no localStorage key, unlike model/effort) **[APP]** — and for current-generation Claude models the toggle may frequently be inert.
5. Codex's richer per-model reasoning-effort metadata (`Model.supportedReasoningEfforts` with human descriptions, `ThreadTokenUsage.modelContextWindow`) only exists in the **app-server** protocol **[SCHEMA]**, which is what VS Code/JetBrains extensions use. This app spawns `codex exec` / `codex exec resume` directly and reads context/effort data from `-c model_reasoning_effort=` overrides and the rollout JSONL file **[APP, codex.ts:262-341]** — a different, real, but less structured integration path. Don't assume app-server capabilities are available without switching integration mechanisms.

---

## 1. Claude Code tab

### Control matrix

| Control | Real backend support | Current app support | Proposed treatment |
|---|---|---|---|
| Model picker | Yes — `--model <id>` accepts alias or full name **[BINARY]** | Yes — `ClaudeModelPicker`, persisted (`MODEL_PREF_KEY`) **[APP]** | Keep as-is |
| Effort/thinking-level (discrete) | Yes — `--effort <low\|medium\|high\|xhigh\|max>` **[BINARY]** | Yes — discrete slider, persisted (`EFFORT_PREF_KEY`) **[APP]** | Keep as-is |
| Thinking on/off (budget) | Partial — no CLI flag; `MAX_THINKING_TOKENS` env var, ignored on adaptive-reasoning models **[DOCS]** | Yes, but unpersisted `useState(false)` **[APP, ClaudeCodeTab.tsx:1001]** | Persist to localStorage like model/effort. Consider hiding or relabeling for models known to use adaptive reasoning only, once model metadata distinguishes them — don't promise an effect the model can't honor |
| Permission mode | Yes — 6 modes via `--permission-mode` **[BINARY]**; Desktop's own GUI exposes 5 of them (`Manual, Accept edits, Plan, Auto, Bypass permissions`) via a mode selector + `Cmd+Shift+M` shortcut, with Bypass gated behind a plan/settings check **[DOCS]** | **No** — hardcoded to `acceptEdits`, no picker exists **[APP, claudecode.ts:227]** | Add a permission-mode control (see below) |
| Context/capacity | Partial — no session-resume flag is used; every turn is a fresh `-p` invocation, conversation continuity lives in this app's own SQLite history, not the CLI process **[APP, claudecode.ts]**. Real per-turn usage is read from the `result` event's `modelUsage` **[APP]** | Yes — `ContextMeter` shows real token usage **[APP]** | No change needed to the meter itself. There's no CLI capacity/window-size flag to expose (unlike Codex's rate-limit windows) — nothing to add here beyond what already exists |

### Design proposal

Add a permission-mode control mirroring Claude Code Desktop's own mode selector, since the CLI genuinely supports it and Desktop's GUI is the closest first-party reference for how Anthropic itself presents this exact same six-value enum:

- A `mode-pill-toggle`-style segmented control (reusing Codex's existing pattern for visual consistency across tabs) or a compact dropdown if 6 options don't fit a pill row. Suggested visible set, dropping the CLI-only `dontAsk` (Desktop itself doesn't show it — "available only in the CLI" per docs) and matching Desktop's five: **Manual, Accept edits, Plan, Auto, Bypass permissions**.
- `Bypass permissions` should require a confirmation step before first use in a session, exactly like Codex's existing `danger-full-access` confirm overlay ([CodexTab.tsx:938-949](src/renderer/src/components/CodexTab.tsx:938)) — this app already has that pattern built, reuse it rather than inventing a new one.
- Persist the chosen mode per-project (or per-app, matching Kimi's current per-app persistence) the same way model/effort preferences are persisted today.
- Do not attempt to expose `plan` mode as a no-tool-execution mode unless the CLI's plan-mode behavior is verified end-to-end in this environment first (it wasn't tested in this pass — flagged as an open question below).

---

## 2. Codex tab

### Control matrix

| Control | Real backend support | Current app support | Proposed treatment |
|---|---|---|---|
| Model picker | Yes — `-m/--model` **[BINARY]** | Yes, plus custom-model entry with localStorage history **[APP]** | Keep as-is |
| Reasoning effort | Yes — `-c model_reasoning_effort=<level>` TOML override **[BINARY]**; app-server's `Model.supportedReasoningEfforts` shows this is genuinely per-model with descriptions **[SCHEMA — different protocol, not confirmed for `exec` path]** | Yes — per-model real levels from `~/.codex/models_cache.json` **[APP]** | Keep as-is |
| Service tier / speed | Yes — `-c service_tier="priority"` **[BINARY]** | Yes — shown only when model has a real `fastTier` **[APP]** | Keep as-is |
| Sandbox mode | Yes — `-s read-only\|workspace-write\|danger-full-access` **[BINARY]** | Yes — 3-way pill **[APP]** | Keep as-is |
| Approval policy | Yes — separate axis, `-a untrusted\|on-request\|never` (`on-failure` deprecated) **[BINARY]** | **No — flag never constructed anywhere in codex.ts** | Add as a second, distinct control (see below) |
| "Allow untrusted" checkbox | Maps to `--skip-git-repo-check` **[APP]** — note this is a git-repo-check bypass, unrelated to the approval-policy `untrusted` value; the current label risks being confused with the missing approval-policy control | Yes **[APP]** | Rename/re-caption to avoid collision once the real approval-policy control is added, e.g. "Skip git-repo check" |
| Context/capacity | Yes — real rate-limit windows (5-hour/weekly) parsed from rollout JSONL **[APP, codex.ts:262-341]** | Yes — `ContextMeter` + `CodexPlanUsage`, the richest of the three tabs today **[APP]** | Keep as-is |

### Design proposal

> **⚠ CORRECTION (Step 3 implementation, verified against Codex v0.139.0).** The approval-policy axis below was proposed as "real per the CLI's own `--help`" — but that cited the *top-level* `codex --help`. Deeper testing against the `codex exec` path this app actually uses **disproved the premise**:
> - `codex exec` **rejects `-a/--ask-for-approval`** outright (`error: unexpected argument '-a' found`) — it is an interactive-only flag.
> - The `-c approval_policy=<x>` config override *parses*, but is **inert in non-interactive exec**: with a `read-only` sandbox + a write request, both `never` and `on-request` produced no file (no human can grant an escalation); `on-request` merely burned an extra turn. Codex's own help says "prefer `never` for non-interactive runs."
> - `codex exec --json` **never emits an approval-request event**, and the app has no approval handler — so there is nothing to wire an approval UI to. The **sandbox (`-s`) is the only real autonomy control** on this path.
>
> **Decision (user-approved): do NOT build the approval-policy control** — it would be a knob that doesn't change what Codex can do. What Step 3 shipped instead: (1) the app now sets `-c approval_policy="never"` explicitly so non-interactive runs are deterministic and don't waste a turn trying to escalate (the sandbox is unchanged, so nothing is loosened); (2) the "Allow untrusted" checkbox was **relabeled to "Skip Git check"** with an accurate tooltip (it maps to `--skip-git-repo-check`, a Git-safety bypass, not an autonomy setting); (3) the Codex tab got the same boxed-picker visual polish as the Kimi/Claude Code tabs; (4) a pre-existing light-mode accent bug (`.mode-codex`/`.panel-codex` used violet `--accent-claudecode` instead of blue `--accent-codex`) was fixed. A real approval axis would require the `codex exec → codex app-server` migration, which the task explicitly deferred.
>
> The original (now-superseded) proposal text is kept below for the record.

~~Add the missing approval-policy axis as its own small control, not folded into the sandbox pill (they're independent in the real CLI — e.g. `workspace-write` + `never` is a legitimate, meaningfully different combination from `workspace-write` + `on-request`):~~

- ~~A second, smaller segmented control or dropdown next to the sandbox pill, three values: **Untrusted** (ask unless command is in the trusted set), **On request** (model decides), **Never** (no prompts, failures surface to the model). Skip the deprecated `on-failure`.~~
- ~~Style it as a smaller sibling of `mode-pill-toggle` — same neutral `--bg-3`/`--bg-4` tokens, not accent-colored, so it doesn't visually compete with the sandbox pill for primacy.~~
- Rename the "Allow untrusted" checkbox — **done** (→ "Skip Git check"), so it's not mistaken for an autonomy/approval setting.

---

## 3. Kimi tab

### Control matrix

| Control | Real backend support | Current app support | Proposed treatment |
|---|---|---|---|
| Model picker | Yes — `session/new` returns a real `model` configOption with 3 live models **[BINARY — live ACP handshake]** | Yes — `KimiModelPicker`, driven by live ACP data with a static fallback catalog **[APP]** | Keep as-is |
| Thinking/effort | Partial — confirmed real per-model: current default models (`kimi-for-coding`, `-highspeed`) expose only one fixed value (`"Thinking On"`, no levels); `k3` has real `support_efforts = [low, high, max]`, `default_effort = "max"` in `config.toml` **[BINARY — config file + handshake]**. Whether selecting `k3` causes the ACP server to push updated `thinking` options with those 3 levels was **not verified in this pass** — the handshake round-trip to test that wasn't completed | Generic — any non-model configSelect (including `thinking`) is rendered by `KimiModelPicker` automatically, driven by whatever the server reports **[APP, kimi.ts:442-446]** | Correct generic design already. Before investing more UI polish here, verify (a follow-up session) that switching to `k3` actually pushes a `thinking` select with `low/high/max` — if confirmed, no UI change needed since the generic mechanism already handles it |
| Permission mode | Yes, natively — `session/new` returns a `mode` configOption: `default / plan / auto / yolo`, each with a real description, matching the CLI's own `--plan/--auto/--yolo` flags exactly **[BINARY — live ACP handshake]** | **Confused** — the composer has its own bespoke 5-tier `<select>` (`PERMISSION_MODES`) that classifies and answers `session/request_permission` client-side via `APPROVAL_MATRIX`, entirely separate from the native `mode` option. The native `mode` value is very likely never set at all (no `session/set_config_option` call for `configId: 'mode'` found), meaning Kimi's own server-side plan/auto/yolo behavior is never engaged — every action still reaches `request_permission` and gets intercepted client-side regardless of what the app's 5-tier select says. The native `mode` option is also not filtered out of the generic config-select list, so it may already render as a stray, unlabeled duplicate row inside `KimiModelPicker` | See below — this is the most consequential proposed change in the whole document |
| Context/capacity | Real usage telemetry exists (`usage_update` ACP event → used/size) **[BINARY — matches ACP capability, though the exact event wasn't captured live in this pass]**; a real `compact` slash command is advertised by the server (`available_commands_update` → `compact`, "Compact the conversation context") **[BINARY — seen live in handshake]**. No dedicated "context size" configOption exists in the real `session/new` response — only `model`, `thinking`, `mode` **[BINARY]** | `ContextMeter` uses real usage data; no explicit "compact now" button was found tied to the real `compact` command | Add a small "Compact" action near `ContextMeter`, mirroring Claude Code Desktop's click-through-the-usage-ring pattern, that sends the already-supported `compact` command instead of requiring the user to type `/compact` |

### Design proposal — the permission-mode unification

This is the one place where "don't propose identical UI across all three tabs" matters most, because Kimi's real backend genuinely differs from both Claude Code and Codex: it has a **native, coarse, 4-value mode concept that changes server-side agent behavior**, layered underneath which the ACP protocol still asks per-action permission regardless of mode (that's inherent to ACP, not a Kimi quirk). The app currently only implements the per-action interception layer and has built a parallel, finer-grained (5-tier) scheme for it, never engaging the coarse native layer at all.

Proposed direction:
1. Keep the app's existing 5-tier `APPROVAL_MATRIX` client-side interception — it's a legitimate finer-grained policy layer that ACP's `request_permission` flow supports regardless of `mode`.
2. **Additionally** set the native `mode` configOption via `session/set_config_option` whenever the user's chosen tier implies a natural native mode, e.g.: tier 1 ("Ask before everything") → `default`; a dedicated "Plan" tier → `mode: plan` (so the model itself is told to stay read-only, not just have its write calls denied after the fact); top tier ("High autonomy") → `mode: auto` or `yolo` depending on how the tiers map. This makes the composer's single dropdown drive both layers instead of only one.
3. Explicitly filter the native `mode` entry out of the generic non-model configSelect list rendered by `KimiModelPicker` (the `configSelectsFrom` filter in [kimi.ts:442-446](src/main/kimi.ts:442)), so it can't show up a second time as an unlabeled duplicate.
4. This is a two-file change (`kimi.ts` + `KimiTab.tsx`) but is design/behavior work, not styling — flagging it clearly as **out of scope for this proposal pass** per the task's "no code" constraint, but it should be the first thing implemented once this document is approved, since it's a correctness gap, not just a polish item.

---

## 4. Visual polish

### What's there today (confirmed via source, not opinion)

[styles.css:1908-1911](src/renderer/src/styles.css:1908) documents the current convention explicitly in a comment: composer triggers are **deliberately plain** — text + chevron, `background:none; border:none` at rest, gaining only `--hover-bg`/`--active-bg` on interaction, with selection color carried entirely by `var(--accent)` (the per-mode accent token). The only control with real visual weight anywhere in any composer bar today is `.composer-send-btn` (solid `background: var(--text)` pill). This is a documented, intentional design decision, not an oversight — so the fix here is a considered evolution of that decision, not a rewrite.

Meanwhile, `CardSelect` (Settings-only today) already has a "boxed" trigger one step up: `background: var(--bg-4); border: 1px solid var(--border); border-radius: var(--radius); padding: 6px 10px`. `mode-pill-toggle` (Codex's sandbox control) also already has a persistent background (`var(--bg-3)` wrapper, `var(--bg-4)` for the active segment) — it's the one composer control today that isn't purely flat.

### Proposed change

Don't invent new visual language. Promote the two conventions that already exist elsewhere in the app (`CardSelect`'s boxed trigger, `mode-pill-toggle`'s segmented-control chrome) to be the baseline for **all** composer-bar controls that represent a persistent choice (model, effort, permission mode, sandbox, approval policy) — not just Codex's sandbox pill:

- Give `model-picker-trigger`, the permission-mode control (both current Kimi `<select>` and any new Claude Code / Codex additions), and `composer-text-toggle` (Claude Code's Thinking toggle) a resting-state background using `var(--bg-3)` and `1px solid var(--border)`, `border-radius: var(--radius-sm)`, matching `mode-pill-toggle`'s existing weight rather than `CardSelect`'s (composer bars are denser than Settings, so the smaller radius/padding fits better).
- Keep `--accent` doing the same job it does today — selected/active state and hover, not the resting fill — so mode-tinting (violet/blue/rose) still reads as the per-agent identity signal it's meant to be, and the new boxed chrome doesn't wash that out.
- Reuse the existing `model-picker-option-badge` pill style (`color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 10px`) for any new compact status badges (e.g., a small "Bypass" or "YOLO" warning badge next to the permission control when a risky mode is active), since that token already exists and already reads as "accent-tinted inline badge" elsewhere.
- Leave `context-meter-chip` and plain icon buttons (attach, mic) alone — the proposal in the task description is about "buttons, badges, dropdown triggers" specifically, and those two are legitimately lightweight, high-frequency-glance elements where extra chrome would add noise rather than considered weight.
- `NumberStepper` has no natural home in any of the three composer bars today (no control needs a bounded numeric value) — no proposed use, noted only because the task asked about it explicitly.

### Aside (not in scope, flagging only)

[styles.css:80](src/renderer/src/styles.css:80) maps `.mode-codex` to `--accent-claudecode` (violet) in light mode, even though a dedicated `--accent-codex` (blue) token exists and is correctly used in dark mode ([styles.css:4768](src/renderer/src/styles.css:4768)). This looks like a copy-paste regression independent of this proposal — worth a separate one-line fix, not bundled into this design work.

---

## 5. Open questions / things this pass could not verify

1. **Claude Code `plan` permission mode's actual tool-execution behavior via CLI** — not exercised end-to-end in this environment. Before wiring a Plan option into the proposed mode selector, confirm it actually blocks edits the way Desktop's docs describe ("proposes a plan without editing your source code").
2. **Whether selecting Kimi's `k3` model live-updates the `thinking` configOption to expose `low/high/max`** — the ACP round-trip to test this (switch model, re-inspect `session/set_config_option` response) was not completed in this pass. This determines whether Kimi's effort control needs any UI work at all or whether the existing generic mechanism already handles it.
3. **Exact native ACP method/event names for context-window size reporting beyond `usage_update`** — inferred from the app's existing code and the one live handshake performed, not independently re-verified against a fresh capture in this pass.
4. **Codex's `-a on-request` vs `never` interaction with the existing sandbox pill in practice** — real per the CLI's own `--help` text, but not run end-to-end together in this environment to confirm there's no surprising interaction (e.g., `never` + `read-only` sandbox behavior on a write attempt).
5. Whether Claude Code Desktop's `Cmd+Shift+E` "effort menu" / `Cmd+Shift+M` "permission mode menu" keyboard shortcuts are worth mirroring in this app's own keybinding surface — deferred as a separate, smaller decision from the core control-bar design.
