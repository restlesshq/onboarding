import path from 'path';
import { spawn } from 'child_process';
import * as debug from '../lib/debug.js';
import { AgentAuthError } from '../lib/errors.js';
import { spawnSpec } from '../lib/portable-exec.js';

// Mirrors the truncation budget in providers/claude.js so debug logs from
// either provider stay roughly the same size.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

// Codex runs commands through a login shell, so `command` arrives as something
// like `/bin/zsh -lc 'npm install foo'`. Peel off the wrapper so phase
// detection (npm/curl/etc.) sees the real command, not the shell harness.
function unwrapShell(cmd) {
  const s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd || '');
  const m = s.match(/-l?c\s+'([\s\S]*)'\s*$/) || s.match(/-l?c\s+"([\s\S]*)"\s*$/);
  return m ? m[1] : s;
}

// Match the phase taxonomy used by claude.js so the spinner reads the same
// regardless of which agent is actually running underneath.
function describeExec(rawCommand) {
  const raw = unwrapShell(rawCommand)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .join(' ');
  let phase = 'Running commands';
  if (/^(npm|pnpm|yarn|bun|pip|gem|go|cargo)\s/.test(raw)) phase = 'Installing packages';
  else if (/^(ls|cat|find|head|tail|rg|grep)\s/.test(raw)) phase = 'Checking files';
  else if (/^curl\s/.test(raw)) phase = 'Making requests';
  else if (/^mkdir\s/.test(raw)) phase = 'Creating directories';
  return {
    phase,
    detail: `Bash ${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}`,
  };
}

function describePatch(paths) {
  const list = Array.isArray(paths) ? paths : [];
  const first = list[0] || 'file';
  return {
    phase: 'Editing files',
    detail: list.length > 1 ? `Edit ${first} (+${list.length - 1} more)` : `Edit ${first}`,
  };
}

export default {
  name: 'codex',

  async run(prompt, cwd, { onStatus, onReport } = {}) {
    const edited = new Set();
    // Mirrors the claude.js mutation counter so debug logs from either
    // provider answer "did the AI actually write?" the same way. Codex
    // reports each edited file as a `file_change` item; we count files
    // touched, not change events, so a single patch over 3 files counts as 3.
    let mutations = 0;
    let execs = 0;

    // New thread/turn/item protocol (codex-cli >= ~0.30): the assistant's
    // text arrives as `agent_message` items, often several per run. Keep the
    // latest text per item id (so a streamed item.updated -> item.completed
    // pair doesn't double-count) and join in arrival order at the end.
    const textById = new Map();
    // Dedupe action items across their started+completed lifecycle so the
    // exec / mutation counters fire exactly once per item.
    const countedActions = new Set();
    // Legacy fallback buffers for older codex builds that still emit the flat
    // agent_message / exec_command_begin protocol. `legacyFinal` wins over the
    // accumulated deltas so we never double up the same text.
    let legacyDeltas = '';
    let legacyFinal = '';

    debug.log('ai.run.start', {
      provider: 'codex',
      cwd,
      promptChars: prompt?.length ?? 0,
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });

    return new Promise((resolve, reject) => {
      // `codex exec --json` runs non-interactively and streams newline-delimited
      // protocol events on stdout. `--sandbox workspace-write` confines writes to
      // the workspace (replaces the deprecated `--full-auto`, which now just warns
      // and will eventually be removed). `--skip-git-repo-check` stops Codex from
      // refusing to run in a directory it doesn't recognize as a trusted git repo.
      // The prompt goes in via stdin (`-`) so multi-line prompts (which most of
      // ours are) don't get mangled by the shell.
      const args = [
        'exec',
        '--json',
        '--sandbox',
        'workspace-write',
        '--skip-git-repo-check',
        '-C',
        cwd,
        '-',
      ];
      let child;
      try {
        // npm installs `codex` as a .cmd shim on Windows, which a bare
        // spawn cannot start; the spec routes it through cmd.exe there.
        const spec = spawnSpec('codex', args);
        child = spawn(spec.file, spec.args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
          ...spec.options,
        });
      } catch (err) {
        reject(new Error(`Failed to spawn codex: ${err.message}`));
        return;
      }

      child.stdin.write(prompt);
      child.stdin.end();

      let stdoutBuffer = '';
      let stderrBuffer = '';

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // keep trailing partial line

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt;
          try { evt = JSON.parse(line); } catch { continue; }
          handleEvent(evt);
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        debug.log('ai.run.end', { provider: 'codex', error: err.message });
        // ENOENT = `codex` not on PATH. We already gate the menu on this, so
        // this fallback is just a safety net.
        if (err.code === 'ENOENT') {
          reject(new Error(`Codex CLI not found. Install with: npm install -g @openai/codex`));
          return;
        }
        reject(new Error(`Failed to spawn codex: ${err.message}`));
      });

      child.on('close', (code) => {
        // Assistant text from the new protocol, then the legacy fallback. Only
        // one path is ever populated in a given run, so the concat is safe.
        const result = ([...textById.values()].join('\n') + (legacyFinal || legacyDeltas)).trim();
        debug.log('ai.run.end', {
          provider: 'codex',
          resultChars: result.length,
          exitCode: code,
          mutations,
          execs,
        });
        // Codex's sandbox confines writes to cwd, so nothing is ever refused here.
        onReport?.({ edited: [...edited], denied: [] });
        if (code !== 0) {
          const stderrTail = stderrBuffer.split('\n').slice(-8).join('\n').trim();
          // Auth is the most common first-run failure. Surface a concrete next
          // step instead of dumping the raw stderr.
          if (/not\s+logged\s+in|please\s+run\s+codex\s+login|api[-_ ]?key|unauthor/i.test(stderrTail)) {
            reject(new AgentAuthError('codex'));
            return;
          }
          reject(new Error(`Codex exited with code ${code}${stderrTail ? `:\n${stderrTail}` : ''}`));
          return;
        }
        resolve(result);
      });

      // Handle one `item` payload from an item.started / item.updated /
      // item.completed event. Items carry their own `type`; we care about the
      // assistant text and the two activity kinds (commands, file edits).
      function handleItem(item) {
        if (!item || typeof item !== 'object') return;
        const id = item.id;
        switch (item.type) {
          case 'agent_message': {
            if (typeof item.text === 'string') {
              const key = id ?? `msg_${textById.size}`;
              const isNew = !textById.has(key);
              textById.set(key, item.text);
              onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
              // Log once per message so streamed updates don't spam the log.
              if (isNew) debug.log('ai.text', { text: truncate(item.text, MAX_AI_TEXT) });
            }
            break;
          }
          case 'reasoning':
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            break;
          case 'command_execution': {
            const key = id ?? `cmd_${execs}`;
            if (!countedActions.has(key)) {
              countedActions.add(key);
              execs++;
              onStatus?.(describeExec(item.command));
              debug.log('ai.tool_use', {
                tool: 'Bash',
                input: { command: truncate(unwrapShell(item.command), MAX_TOOL_INPUT_FIELD) },
              });
            }
            break;
          }
          case 'file_change': {
            const key = id ?? `patch_${mutations}`;
            if (!countedActions.has(key)) {
              countedActions.add(key);
              const paths = Array.isArray(item.changes) ? item.changes.map((c) => c.path) : [];
              mutations += paths.length;
              for (const p of paths) edited.add(path.resolve(cwd || '.', p));
              onStatus?.(describePatch(paths));
              debug.log('ai.tool_use', { tool: 'Patch', input: { paths } });
            }
            break;
          }
          case 'mcp_tool_call':
            onStatus?.({ phase: 'Working', detail: item.server || item.tool || 'Tool call' });
            break;
          default:
            // Unrecognized item - log so we can extend the mapping if a new
            // item type appears in a future Codex release.
            debug.log('ai.item', { type: item.type });
        }
      }

      function handleEvent(evt) {
        // Older codex releases used a flatter `{ msg: { type } }` shape; accept
        // either so both protocol generations flow through one path.
        const type = evt.msg?.type ?? evt.type;
        const data = evt.msg ?? evt;
        if (!type) return;

        // ── New thread/turn/item protocol ──────────────────────────────────
        if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
          handleItem(data.item);
          return;
        }
        if (type === 'thread.started' || type === 'turn.started') {
          onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
          return;
        }
        if (type === 'turn.completed' || type === 'thread.completed') return;
        if (type === 'turn.failed' || type === 'thread.error') {
          // Don't reject - the process exit code is the source of truth for
          // whether the run actually failed.
          debug.log('ai.error', { message: truncate(JSON.stringify(data), 500) });
          return;
        }

        // ── Legacy flat protocol (older codex installs) ────────────────────
        switch (type) {
          case 'agent_message_delta': {
            const text = data.delta ?? '';
            if (text) legacyDeltas += text;
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            break;
          }
          case 'agent_message': {
            // Terminal message carries the complete text; prefer it over the
            // accumulated deltas rather than appending on top of them.
            const text = data.message ?? '';
            if (text) {
              legacyFinal = text;
              debug.log('ai.text', { text: truncate(text, MAX_AI_TEXT) });
            }
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            break;
          }
          case 'agent_reasoning_delta':
          case 'agent_reasoning':
            onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
            break;
          case 'exec_command_begin': {
            execs++;
            onStatus?.(describeExec(data.command));
            const cmdStr = Array.isArray(data.command) ? data.command.join(' ') : data.command;
            debug.log('ai.tool_use', { tool: 'Bash', input: { command: truncate(cmdStr, MAX_TOOL_INPUT_FIELD) } });
            break;
          }
          case 'patch_apply_begin': {
            const paths = Object.keys(data.changes || {});
            mutations += paths.length;
            for (const p of paths) edited.add(path.resolve(cwd || '.', p));
            onStatus?.(describePatch(paths));
            debug.log('ai.tool_use', { tool: 'Patch', input: { paths } });
            break;
          }
          case 'mcp_tool_call_begin':
            onStatus?.({ phase: 'Working', detail: data.tool || data.server || 'Tool call' });
            break;
          case 'error':
            debug.log('ai.error', { message: truncate(data.message || JSON.stringify(data), 500) });
            break;
          default:
            // Unrecognized event - log it so we can extend the mapping if a
            // new event type appears in a future Codex release.
            debug.log('ai.event', { type });
        }
      }
    });
  },
};
