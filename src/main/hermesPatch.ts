import { spawn, ChildProcess } from 'child_process'
import { getHermesConfig, type RemoteHermesConfig } from './hermes'

// Hermes ACP reasoning-effort patch.
//
// Hermes 0.16.0's ACP adapter never passes `reasoning_config` to the agent:
// `SessionManager._make_agent` (acp_adapter/session.py) builds `AIAgent(**kwargs)`
// without it, so `agent.reasoning_config` stays None and the transports fall back
// to a hardcoded `{"enabled": True, "effort": "medium"}`. Only the terminal TUI
// reads `agent.reasoning_effort` from config (cli.py). Over ACP — which is how
// this app talks to Hermes — effort is therefore not adjustable at all.
//
// The adapter *does* already accept `session/set_config_option` and persists
// arbitrary ids into `state.config_options`; nothing consumes them. This patch
// makes that real: `_make_agent` grows a `reasoning_effort` parameter, and
// `set_config_option` rebuilds the agent when the `reasoning_effort` option is
// set (exactly how `set_session_model` already swaps the agent in place).
// Per-session, protocol-level, and therefore identical for local WSL and remote
// SSH once each host is patched.
//
// The patch is applied to the user's own Hermes checkout (~/.hermes/hermes-agent
// is an editable git install), so it is revertible with `git checkout` and shows
// up in `git status` there. A marker file records that we applied it, matching
// the `~/.ai-workspace-hermes/installed` convention setup-hermes.ps1 uses.

const IS_WIN = process.platform === 'win32'
const SSH_EXE = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'

const HERMES_REPO = '$HOME/.hermes/hermes-agent'
const MARKER_DIR = '$HOME/.ai-workspace-hermes'
const MARKER_FILE = `${MARKER_DIR}/acp-reasoning-patch`

export const HERMES_PATCH_NAME = '0001-acp-reasoning-effort'

// Canonical patch text. scripts/hermes-patches/0001-acp-reasoning-effort.patch
// holds a human-readable copy (useful for upstreaming or applying by hand);
// scripts/test-hermes.ts asserts the two are byte-identical so they cannot drift.
export const HERMES_PATCH_TEXT = `diff --git a/acp_adapter/server.py b/acp_adapter/server.py
index 6901fe2..c426378 100644
--- a/acp_adapter/server.py
+++ b/acp_adapter/server.py
@@ -1991,6 +1991,7 @@ class HermesACPAgent(acp.Agent):
                 requested_provider=requested_provider,
                 base_url=current_base_url,
                 api_mode=current_api_mode,
+                reasoning_effort=self._session_reasoning_effort(state),
             )
             self.session_manager.save_session(session_id)
             logger.info(
@@ -2019,6 +2020,18 @@ class HermesACPAgent(acp.Agent):
         logger.info("Session %s: mode switched to %s", session_id, normalized_mode)
         return SetSessionModeResponse()
 
+    _REASONING_EFFORT_CONFIG_ID = "reasoning_effort"
+
+    @staticmethod
+    def _session_reasoning_effort(state) -> str | None:
+        """Return the session's ACP-set reasoning effort, if any."""
+        options = getattr(state, "config_options", None)
+        if isinstance(options, dict):
+            value = options.get(HermesACPAgent._REASONING_EFFORT_CONFIG_ID)
+            if value:
+                return str(value)
+        return None
+
     async def set_config_option(
         self, config_id: str, session_id: str, value: str, **kwargs: Any
     ) -> SetSessionConfigOptionResponse | None:
@@ -2037,6 +2050,18 @@ class HermesACPAgent(acp.Agent):
                 options = {}
             options[str(config_id)] = value
             setattr(state, "config_options", options)
+            if str(config_id) == self._REASONING_EFFORT_CONFIG_ID:
+                # Rebuild the agent so the new effort reaches the transport,
+                # mirroring how set_session_model swaps the agent in place.
+                state.agent = self.session_manager._make_agent(
+                    session_id=session_id,
+                    cwd=state.cwd,
+                    model=state.model or None,
+                    requested_provider=getattr(state.agent, "provider", None),
+                    base_url=getattr(state.agent, "base_url", None),
+                    api_mode=getattr(state.agent, "api_mode", None),
+                    reasoning_effort=str(value or ""),
+                )
         self.session_manager.save_session(session_id)
         logger.info("Session %s: config option %s updated", session_id, config_id)
         return SetSessionConfigOptionResponse(config_options=[])
diff --git a/acp_adapter/session.py b/acp_adapter/session.py
index c124229..2fe03d9 100644
--- a/acp_adapter/session.py
+++ b/acp_adapter/session.py
@@ -564,6 +564,7 @@ class SessionManager:
         requested_provider: str | None = None,
         base_url: str | None = None,
         api_mode: str | None = None,
+        reasoning_effort: str | None = None,
     ):
         if self._agent_factory is not None:
             return self._agent_factory()
@@ -600,6 +601,26 @@ class SessionManager:
             "model": model or default_model,
         }
 
+        # Reasoning effort. An explicit per-session value (set over ACP via
+        # session/set_config_option) wins; otherwise fall back to the user's
+        # configured default, matching what the TUI does in cli.py. Anything
+        # empty or unrecognized leaves reasoning_config unset so the agent keeps
+        # its built-in default.
+        effort = reasoning_effort
+        if effort is None:
+            agent_cfg = config.get("agent") or {}
+            if isinstance(agent_cfg, dict):
+                effort = agent_cfg.get("reasoning_effort")
+        try:
+            from hermes_constants import parse_reasoning_effort
+
+            reasoning_config = parse_reasoning_effort(str(effort or ""))
+        except Exception:
+            logger.debug("Could not parse reasoning effort %r", effort, exc_info=True)
+            reasoning_config = None
+        if reasoning_config is not None:
+            kwargs["reasoning_config"] = reasoning_config
+
         try:
             runtime = resolve_runtime_provider(requested=requested_provider or config_provider)
             kwargs.update(
`

export type HermesPatchStatus = 'applied' | 'already-applied' | 'conflict' | 'unavailable'

export interface HermesPatchResult {
  ok: boolean
  status: HermesPatchStatus
  message?: string
}

// ---- shell plumbing ---------------------------------------------------------
// Both hosts run the same POSIX script; only the transport differs. The script
// is fed on stdin (`bash -s`) so nothing has to survive a quoting round-trip.

function runShell(script: string, config: RemoteHermesConfig, distro: string, timeoutMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    if (!IS_WIN) return resolve({ code: null, out: '', err: 'Not supported on this platform' })

    let child: ChildProcess
    try {
      if (config.mode === 'remote') {
        if (!config.sshHost) return resolve({ code: null, out: '', err: 'No SSH host configured' })
        child = spawn(
          SSH_EXE,
          [
            '-i', config.sshKeyPath,
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=10',
            '-o', 'StrictHostKeyChecking=accept-new',
            `${config.sshUser}@${config.sshHost}`,
            'bash -s'
          ],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
      } else {
        child = spawn('wsl.exe', ['-d', distro, '--', 'bash', '-s'], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      }
    } catch (e: any) {
      return resolve({ code: null, out: '', err: e?.message ?? String(e) })
    }

    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { out += d })
    child.stderr?.on('data', (d: string) => { err += d })
    child.on('error', (e: any) => resolve({ code: null, out, err: e?.message ?? String(e) }))
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ code: null, out, err: 'Timed out' })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })

    try {
      child.stdin?.write(script)
      child.stdin?.end()
    } catch {
      /* process died before we could write — close handler reports it */
    }
  })
}

// ---- probe ------------------------------------------------------------------

// Reports whether the running Hermes actually has the patch, rather than
// trusting the marker alone: a `hermes update` (git pull/checkout) can revert
// the source while leaving our marker behind. The source grep is authoritative.
const PROBE_SCRIPT = `
set -u
REPO="${HERMES_REPO}"
if [ ! -d "$REPO" ]; then echo "NO_REPO"; exit 0; fi
if grep -q "reasoning_effort" "$REPO/acp_adapter/session.py" 2>/dev/null \\
   && grep -q "_REASONING_EFFORT_CONFIG_ID" "$REPO/acp_adapter/server.py" 2>/dev/null; then
  echo "PATCHED"
else
  echo "UNPATCHED"
fi
`

export async function checkHermesReasoningPatch(distro = 'Ubuntu'): Promise<boolean> {
  const config = getHermesConfig()
  const { out } = await runShell(PROBE_SCRIPT, config, distro, 20_000)
  return out.includes('PATCHED')
}

// ---- apply ------------------------------------------------------------------

function applyScript(patchBase64: string): string {
  return `
set -u
REPO="${HERMES_REPO}"
PATCH=/tmp/aiw-hermes-${HERMES_PATCH_NAME}.patch

if [ ! -d "$REPO/.git" ]; then echo "NO_REPO"; exit 0; fi
printf '%s' '${patchBase64}' | base64 -d > "$PATCH" || { echo "DECODE_FAILED"; exit 0; }

cd "$REPO" || { echo "NO_REPO"; exit 0; }

# Already applied? (reverse-apply would succeed only if the change is present.)
if git apply --reverse --check "$PATCH" >/dev/null 2>&1; then
  STATUS=ALREADY
elif git apply --check "$PATCH" >/dev/null 2>&1; then
  git apply "$PATCH" && STATUS=APPLIED || STATUS=CONFLICT
else
  STATUS=CONFLICT
fi

if [ "$STATUS" = "CONFLICT" ]; then echo "CONFLICT"; exit 0; fi

mkdir -p "${MARKER_DIR}"
printf '%s\\n' "${HERMES_PATCH_NAME}" > "${MARKER_FILE}"
echo "$STATUS"
`
}

// Applies the patch to whichever host is configured (local WSL distro or the
// remote SSH machine). Idempotent — a second run reports 'already-applied'.
export async function applyHermesReasoningPatch(distro = 'Ubuntu'): Promise<HermesPatchResult> {
  const config = getHermesConfig()
  const patchBase64 = Buffer.from(HERMES_PATCH_TEXT, 'utf8').toString('base64')
  const { code, out, err } = await runShell(applyScript(patchBase64), config, distro, 90_000)

  if (out.includes('APPLIED')) return { ok: true, status: 'applied' }
  if (out.includes('ALREADY')) return { ok: true, status: 'already-applied' }
  if (out.includes('CONFLICT')) {
    return {
      ok: false,
      status: 'conflict',
      message: 'Hermes source has diverged from the patch (likely a `hermes update`). Re-apply by hand or reinstall Hermes.'
    }
  }
  if (out.includes('NO_REPO')) {
    return { ok: false, status: 'unavailable', message: 'No Hermes git checkout found at ~/.hermes/hermes-agent.' }
  }
  return {
    ok: false,
    status: 'unavailable',
    message: err.trim() || `Patch script failed (exit ${code ?? 'unknown'}).`
  }
}
