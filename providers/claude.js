import path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as debug from '../lib/debug.js';
import { AgentAuthError } from '../lib/errors.js';
import { getGitRoot, listCheckouts } from '../lib/pathGuard.js';
import { makeToolGuard } from '../lib/tool-guard.js';
import { createToolProgressTracker } from '../lib/stream-progress.js';

// AI tool inputs (especially Write/Edit) carry full file contents that
// blow up the debug log size. Truncate every string field at the source
// so we still see *what* the AI did without dragging the body along.
const MAX_TOOL_INPUT_FIELD = 500;
const MAX_TOOL_INPUT_TOTAL = 2000;
const MAX_AI_TEXT = 1500;

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} chars)` : s;
}

function truncatedToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = truncate(v, MAX_TOOL_INPUT_FIELD);
    else out[k] = v;
  }
  // Belt-and-suspenders: if the trimmed object is still huge (lots of
  // small fields), cap the serialized form as well.
  const json = JSON.stringify(out);
  if (json.length <= MAX_TOOL_INPUT_TOTAL) return out;
  return { _truncated: json.slice(0, MAX_TOOL_INPUT_TOTAL) + `…(+${json.length - MAX_TOOL_INPUT_TOTAL} chars)` };
}

/**
 * Map a tool_use block into {phase, detail}:
 *  - phase: high-level human category (e.g. "Looking for files")
 *  - detail: the specific tool call (e.g. 'Glob *.{js,ts}')
 *
 * Phase is stable across many calls of the same category; detail changes
 * with every call.
 */
function describeToolUse(toolName, input) {
  switch (toolName) {
    case 'Read':
      return {
        phase: 'Reading files',
        detail: `Read ${input.file_path || 'file'}`,
      };
    case 'Glob':
      return {
        phase: 'Looking for files',
        detail: `Glob ${input.pattern || '*'}${input.path ? ` in ${input.path}` : ''}`,
      };
    case 'Grep': {
      const pat = (input.pattern || '').slice(0, 40);
      const glob = input.glob ? ` --include="${input.glob}"` : '';
      return {
        phase: 'Searching the code',
        detail: `Grep "${pat}"${glob}`,
      };
    }
    case 'Write':
      return {
        phase: 'Writing files',
        detail: `Write ${input.file_path || 'file'}`,
      };
    case 'Edit':
      return {
        phase: 'Editing files',
        detail: `Edit ${input.file_path || 'file'}`,
      };
    case 'Bash': {
      // Claude often prefixes commands with a `# comment` line and joins pipes
      // with real newlines. Flatten to one line so the spinner detail stays
      // on a single visual row, and strip leading comments.
      const raw = (input.command || '')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .join(' ');
      let phase = 'Running commands';
      if (/^(npm|pnpm|yarn|bun|pip|gem|go|cargo)\s/.test(raw)) phase = 'Installing packages';
      else if (/^(ls|cat|find|head|tail)\s/.test(raw)) phase = 'Checking files';
      else if (/^curl\s/.test(raw)) phase = 'Making requests';
      else if (/^mkdir\s/.test(raw)) phase = 'Creating directories';
      return {
        phase,
        detail: `Bash ${raw.slice(0, 80)}${raw.length > 80 ? '…' : ''}`,
      };
    }
    default:
      return {
        phase: 'Working',
        detail: toolName,
      };
  }
}

export default {
  name: 'claude',

  /**
   * `maxTurns` defaults to the 30 that suits a focused task (write this spec,
   * wire this SDK). A caller whose job is open-ended - reading a whole
   * repository, say - raises it, because hitting the cap does NOT degrade
   * gracefully the way a partial edit does: the agent never reaches the turn
   * where it emits its answer, so the run returns nothing at all rather than
   * returning less.
   *
   * `onError` exists for the same reason. The loop below deliberately swallows
   * SDK errors and returns whatever partial text it has (see the note above
   * it), which is right for steps that re-check their own output. But it makes
   * "the model found nothing" and "the model never got to answer" identical
   * from the outside, and a caller that reports the second as the first is
   * lying to the user. Callers that cannot otherwise tell those apart pass
   * this and check.
   *
   * `onReport` receives `{ edited, denied }` (absolute paths) when the run ends.
   */
  async run(prompt, cwd, { onStatus, maxTurns = 30, onError, onReport } = {}) {
    let result = '';
    // Counts so the debug log answers "did the AI actually write?" in a
    // single line. Useful post-mortem when install-sdk later finds nothing
    // wired and we need to know whether the AI tried to edit or just
    // produced commentary.
    const toolCounts = { Read: 0, Glob: 0, Grep: 0, Bash: 0, Edit: 0, Write: 0, other: 0 };
    const gitRoot = getGitRoot();
    const guard = makeToolGuard({ gitRoot, cwd, checkouts: listCheckouts(gitRoot) });
    const editPaths = new Map(); // tool_use id -> absolute path
    const deniedIds = new Set(); // refused by the guard, or failed
    const denied = [];
    const preToolUse = async (input) => {
      const verdict = guard(input.tool_name, input.tool_input);
      if (!verdict) return {};
      deniedIds.add(input.tool_use_id);
      denied.push(verdict.path);
      debug.log('ai.tool.denied', { tool: input.tool_name, path: verdict.path, reason: verdict.owner ? 'other-checkout' : 'outside-project' });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: verdict.message,
        },
      };
    };
    debug.log('ai.run.start', {
      provider: 'claude',
      cwd,
      gitRoot,
      promptChars: prompt?.length ?? 0,
      // Just the first slice - full prompt is reproducible from
      // prompts/*.md + the variables, so don't send the whole thing.
      promptHead: typeof prompt === 'string' ? truncate(prompt, 400) : '',
    });
    // The Agent SDK rejects its async iterator on terminal conditions -
    // most commonly "Reached maximum number of turns", but also process
    // exits and transport errors. A throw here used to escape runAI and,
    // for any call site that didn't wrap it (e.g. generate-oas), bubble up
    // to `uncaughtException` and kill the whole CLI mid-run. Swallow it
    // instead: log the reason and return whatever partial text we already
    // accumulated. Every step has its own retry / re-check logic (the
    // install-sdk retry loop, generate-oas's validation, final-checks) and
    // is built to handle an empty or partial AI result, so degrading is
    // always better than crashing.
    let runError = null;
    // Set from the SDK's typed error, not the text: a logged-out agent answers
    // "Not logged in" in ~1s, which otherwise reads as an empty result.
    let authFailed = false;
    // Reports the tool call currently being generated. Without it the UI
    // shows the PREVIOUS tool for as long as the model spends composing the
    // next one, which for a large `Write` is a minute or more of apparent
    // hang. See `lib/stream-progress.js`.
    const progress = createToolProgressTracker({ cwd, onStatus });
    try {
      for await (const message of query({
        prompt,
        options: {
          maxTurns,
          allowedTools: ['Read', 'Edit', 'Glob', 'Grep', 'Bash', 'Write'],
          cwd,
          // A hook, not `canUseTool`: allowedTools auto-approve and never reach
          // canUseTool, so a guard there never ran for Edit/Write/Bash.
          hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
          // Keep user settings (auth, env) but not the user's CLAUDE.md or memory,
          // which name other checkouts' paths when this one is a git worktree.
          settingSources: ['user'],
          settings: {
            autoMemoryEnabled: false,
            claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/AGENTS.md', '**/.claude/rules/**'],
          },
          // Streaming events are what let the spinner track the model while
          // it is generating a tool call. A tool_use block only reaches the
          // `assistant` branch below once its ENTIRE input has been
          // generated, and for the OpenAPI spec that is a ~40KB argument
          // taking a minute or more. Without these events the CLI showed the
          // PREVIOUS tool's label for that whole minute - a profiled run sat
          // on "Creating directories" for 118 seconds while it was actually
          // writing the spec, which reads as a hang.
          includePartialMessages: true,
        }
      })) {
        // ── Streaming: track the tool call being generated right now ──────
        if (message.type === 'stream_event') {
          progress.handle(message.event);
          continue;
        }

        // An API-level retry, which is invisible from the outside and looks
        // exactly like a slow model. A profiled run had one unexplained 49.5s
        // gap; this is the event that would have named it.
        if (message.type === 'system' && message.subtype === 'api_retry') {
          debug.log('ai.api-retry', {
            attempt: message.attempt,
            maxRetries: message.max_retries,
            retryDelayMs: message.retry_delay_ms,
            errorStatus: message.error_status,
            error: message.error,
          });
          onStatus?.({ phase: 'Retrying', detail: `API retry ${message.attempt}/${message.max_retries}` });
          continue;
        }

        // A tool_result that errored (an Edit whose old_string didn't match)
        // changed nothing, so it must not count as an edit.
        if (message.type === 'user' && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) {
            if (block?.type === 'tool_result' && block.is_error) deniedIds.add(block.tool_use_id);
          }
          continue;
        }

        if (message.type === 'assistant') {
          if (message.error === 'authentication_failed') authFailed = true;
          for (const block of message.message.content) {
            if (block.type === 'text') {
              result += block.text;
              onStatus?.({ phase: 'Analyzing', detail: 'Thinking…' });
              debug.log('ai.text', { text: truncate(block.text, MAX_AI_TEXT) });
            } else if (block.type === 'tool_use') {
              onStatus?.(describeToolUse(block.name, block.input));
              debug.log('ai.tool_use', { tool: block.name, input: truncatedToolInput(block.input) });
              const file = block.input?.file_path || block.input?.notebook_path;
              if (['Edit', 'Write', 'NotebookEdit'].includes(block.name) && typeof file === 'string') {
                editPaths.set(block.id, path.resolve(cwd || '.', file));
              }
              if (block.name in toolCounts) toolCounts[block.name]++;
              else toolCounts.other++;
            }
          }
        } else if (message.type === 'result' && message.is_error) {
          // The SDK emits the terminal error result here just before it
          // rejects the iterator; capture the reason for the log.
          runError =
            message.subtype === 'success'
              ? message.result
              : Array.isArray(message.errors)
                ? message.errors.join('; ')
                : message.subtype || 'error';
        }
      }
    } catch (err) {
      runError = runError || err?.message || String(err);
    }

    if (runError) {
      debug.log('ai.run.error', {
        provider: 'claude',
        message: runError,
        resultChars: result.length,
      });
      onError?.(runError);
    }
    debug.log('ai.run.end', {
      provider: 'claude',
      resultChars: result.length,
      toolCounts,
      // Surface the "did it write" answer at the top level so a quick
      // grep of the debug log doesn't have to parse the per-tool list.
      mutations: toolCounts.Edit + toolCounts.Write,
      // Present only when the run ended on an SDK error (max turns, etc.).
      error: runError || undefined,
    });
    const edited = [...new Set([...editPaths].filter(([id]) => !deniedIds.has(id)).map(([, p]) => p))];
    onReport?.({ edited, denied: [...new Set(denied)] });
    if (authFailed) throw new AgentAuthError('claude', runError || result.trim());
    return result;
  },
};
