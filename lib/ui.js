import readline from 'readline';
import * as debug from './debug.js';
import * as timings from './timings.js';
import { isInteractive } from './env.js';
import { CLI_NAME, IS_LINKED_INSTALL } from './config.js';

/**
 * Wipe the viewport AND the scrollback, then home the cursor.
 *
 * Order matters: `2J` erases the display, and most terminals push those
 * erased lines into the scrollback buffer as they go - so clearing the
 * scrollback first (`3J`) leaves the screen you just wiped scrollable again.
 * Erase, then drop the history, then home.
 */
export const clearScreen = () => process.stdout.write('\x1b[2J\x1b[3J\x1b[H');

/**
 * Dim, and stays dim across nested styles.
 *
 * Every helper here closes with a full reset (`0m`), so a nested one used to
 * switch dim off for the remainder of the line: `dim(\`a ${bold('b')} c\`)`
 * rendered "c" at full brightness. Re-asserting `2m` after each inner reset
 * keeps the rest of the string dim.
 *
 * This does NOT rescue a nested *color* - `dim(orange(x))` still renders
 * dim-orange, which is mud. Put the color outside the dim instead:
 * `${orange(name)} ${dim('the rest')}`.
 */
export const dim = (s) => `\x1b[2m${String(s).replaceAll('\x1b[0m', '\x1b[0m\x1b[2m')}\x1b[0m`;
export const bold = (s) => `\x1b[1m${s}\x1b[0m`;
export const green = (s) => `\x1b[32m${s}\x1b[0m`;
export const red = (s) => `\x1b[31m${s}\x1b[0m`;
export const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
export const yellow = (s) => `\x1b[38;2;255;190;0m${s}\x1b[0m`;
// Truecolor, not the 256-color index it used to be (`38;5;208`): terminals
// remap palette indices to their own theme, and most themes' "orange" slot is
// a muted brown that went dark next to the truecolor blues and greens around
// it. This is the agent's name in body text, so it has to stay legible.
export const orange = (s) => `\x1b[38;2;255;158;66m${s}\x1b[0m`;
// Brand blue (truecolor) - the logo bars and the primary CTA accent. #62c6ff
export const brand = (s) => `\x1b[38;2;98;198;255m${s}\x1b[0m`;
// Bright white - for body copy we want to read as crisp/non-dimmed.
export const white = (s) => `\x1b[97m${s}\x1b[0m`;
// Muted gray - softer than `dim` but more legible. #a8a8a8
export const muted = (s) => `\x1b[38;2;168;168;168m${s}\x1b[0m`;
// Brighter red for status (the failing-code dot + label). #ff5454
export const brightRed = (s) => `\x1b[38;2;255;84;84m${s}\x1b[0m`;
// Success green for status (the passing-code dot + label). #00cb7b
export const statusGreen = (s) => `\x1b[38;2;0;203;123m${s}\x1b[0m`;
// Vivid green for a single hero CTA - meant to be the brightest thing on its
// screen (the "Press Enter to log in" call to action). #3ef08b
export const brightGreen = (s) => `\x1b[38;2;62;240;139m${s}\x1b[0m`;

export function ask(prompt, { defaultValue = '' } = {}) {
  const endWait = timings.start('prompt: ask', { kind: timings.KINDS.WAIT });
  // Non-interactive (agent / CI / pipe): there's no one to type an answer,
  // so echo the prompt + default and resolve immediately instead of hanging
  // on a readline that never receives input.
  if (!isInteractive()) {
    if (prompt) process.stdout.write(`${prompt}${defaultValue}\n`);
    endWait();
    debug.log('input.ask', { prompt: stripAnsi(prompt), answer: defaultValue, auto: true });
    return Promise.resolve(defaultValue);
  }
  return new Promise((resolve) => {
    // Reset stdin from whatever state the previous UI left it in
    // (multiSelect/singleSelect put it in raw mode with keypress listeners).
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('readable');
    process.stdin.resume();

    // terminal: true lets readline handle arrow keys / cursor movement /
    // backspace / etc. itself. Running directly on stdin (no PassThrough)
    // so the TTY escape-sequence interpretation works.
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Ctrl-C while answering should quit the CLI cleanly.
    rl.once('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      debug.abortExit(130);
    });

    rl.question(prompt, (answer) => {
      rl.close();
      process.stdin.pause();
      endWait();
      debug.log('input.ask', { prompt: stripAnsi(prompt), answer });
      resolve(answer);
    });

    // Prefill the current value if the caller passed one. The
    // string lands in the readline buffer as if the user had typed
    // it - they can edit with backspace / arrow keys, or just
    // press Enter to keep it. Done after `rl.question()` so the
    // prompt has already been written.
    if (defaultValue) rl.write(defaultValue);
  });
}

/**
 * `ask`, plus a line under the input that re-renders on every keystroke.
 *
 * `preview(currentValue)` returns that line - use it to show the consequence
 * of what's being typed (a full example URL built from a base URL, say)
 * rather than making the user assemble it in their head. Falls back to a
 * plain `ask` when there's no TTY to animate.
 *
 * Mechanics: reserve the row below the input up front (so the one scroll,
 * if any, happens before we start saving cursor positions), then on each
 * keypress save the cursor, drop a row, repaint it, and restore. Readline
 * owns its own row and never sees us touch the one below it. We read
 * `rl.line` on a `setImmediate` so readline has already applied the key.
 */
export function askWithPreview(prompt, { defaultValue = '', preview } = {}) {
  const endWait = timings.start('prompt: ask (with preview)', { kind: timings.KINDS.WAIT });
  if (!isInteractive() || !preview || !process.stdout.isTTY) {
    return ask(prompt, { defaultValue });
  }
  return new Promise((resolve) => {
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.removeAllListeners('data');
    process.stdin.removeAllListeners('keypress');
    process.stdin.removeAllListeners('readable');
    process.stdin.resume();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    let done = false;
    const paint = () => {
      if (done) return;
      process.stdout.write('\x1b7');                  // save cursor
      process.stdout.write('\x1b[1B\x1b[G\x1b[2K');   // down a row, col 1, clear
      process.stdout.write(preview(rl.line || ''));
      process.stdout.write('\x1b8');                  // back to the input
    };

    const onKey = () => setImmediate(paint);

    rl.once('SIGINT', () => {
      done = true;
      process.stdin.removeListener('keypress', onKey);
      rl.close();
      process.stdout.write('\n');
      debug.abortExit(130);
    });

    rl.question(prompt, (answer) => {
      done = true;
      process.stdin.removeListener('keypress', onKey);
      rl.close();
      process.stdin.pause();
      // Readline's echoed newline left us sitting on the preview row.
      process.stdout.write('\x1b[2K');
      endWait();
      debug.log('input.ask', { prompt: stripAnsi(prompt), answer });
      resolve(answer);
    });

    if (defaultValue) rl.write(defaultValue);
    // Reserve the preview row before we start saving cursor positions.
    process.stdout.write('\n\x1b[1A');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', onKey);
    paint();
  });
}

// Local copy so debug logging doesn't have to import from ./debug for ANSI
// stripping - keeps the dependency direction one-way.
// eslint-disable-next-line no-control-regex
const ANSI_RE_UI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s) { return (s || '').replace(ANSI_RE_UI, ''); }

export function clearLines(n) {
  for (let i = 0; i < n; i++) {
    process.stdout.write('\x1b[1A\x1b[2K');
  }
}

export function multiSelect(items, { message }) {
  const endWait = timings.start('prompt: multi-select', { kind: timings.KINDS.WAIT });
  // Non-interactive: keep the default (all items selected) and return.
  if (!isInteractive()) {
    const indices = items.map((_, i) => i);
    console.log(`  ${bold(message || '')} ${dim('→ all')}`);
    endWait();
    debug.log('input.multiSelect', {
      message,
      items: items.map((it) => stripAnsi(String(it))),
      selected: indices,
      auto: true,
    });
    return Promise.resolve(indices);
  }
  return new Promise((resolve) => {
    const selected = new Set(items.map((_, i) => i)); // all selected by default
    let cursor = 0;

    const { stdin, stdout } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    function render() {
      clearLines(items.length + 2); // items + header + footer
      stdout.write(`  ${bold(message)}\n`);
      for (let i = 0; i < items.length; i++) {
        const check = selected.has(i) ? green('✓') : dim('○');
        const label = i === cursor ? bold(items[i]) : items[i];
        const pointer = i === cursor ? cyan('❯') : ' ';
        stdout.write(`  ${pointer} ${check} ${label}\n`);
      }
      stdout.write(dim('  ↑/↓ move · space toggle · enter confirm\n'));
    }

    // initial draw (no clear needed first time)
    stdout.write(`  ${bold(message)}\n`);
    for (let i = 0; i < items.length; i++) {
      const check = selected.has(i) ? green('✓') : dim('○');
      const label = i === cursor ? bold(items[i]) : items[i];
      const pointer = i === cursor ? cyan('❯') : ' ';
      stdout.write(`  ${pointer} ${check} ${label}\n`);
    }
    stdout.write(dim('  ↑/↓ move · space toggle · enter confirm\n'));

    stdin.on('data', (key) => {
      if (key === '\x1b[A') { // up
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key === '\x1b[B') { // down
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key === ' ') { // space - toggle
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        render();
      } else if (key === '\r' || key === '\n') { // enter
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        const indices = [...selected].sort();
        endWait();
        debug.log('input.multiSelect', {
          message,
          items: items.map((it) => stripAnsi(String(it))),
          selected: indices,
          selectedItems: indices.map((i) => stripAnsi(String(items[i]))),
        });
        resolve(indices);
      } else if (isAbortKey(key)) { // ctrl-c or esc
        stdin.setRawMode(false);
        debug.abortExit(0);
      }
    });
  });
}

// Background-highlight wrapper. Re-applies the bg after every embedded
// `\x1b[0m` so nested color codes (bold, dim, etc.) don't break the row's
// highlight. Used for the cursor row in singleSelect.
const PICKER_BG = '\x1b[48;5;236m'; // dim dark gray
function pickerHighlight(s) {
  // eslint-disable-next-line no-control-regex
  return PICKER_BG + s.replace(/\x1b\[0m/g, '\x1b[0m' + PICKER_BG) + '\x1b[0m';
}

function termWidth() {
  try { return process.stdout.columns || 80; } catch { return 80; }
}

// Pad a string with trailing spaces so its visible (post-ANSI-strip) length
// reaches `width`. If it's already that wide, return as-is.
function padVisibleTo(s, width) {
  const visible = stripAnsi(s).length;
  if (visible >= width) return s;
  return s + ' '.repeat(width - visible);
}

/**
 * A one-time celebratory banner: a green-bordered box (matching the CLI's
 * existing `╭ ╮ ╰ ╯` box style) wrapped around a single title line. Reserved
 * for the "setup complete" payoff so the box + emoji never appear anywhere
 * else in the flow, and keep their "you finished" punch. `title` may contain
 * ANSI (width is measured post-strip). Returns lines ready to drop straight
 * into a plan `message` block.
 */
export function celebrationBanner(title) {
  const inner = Math.max(Math.min(termWidth() - 6, 60), 32);
  const top = green(`  ╭${'─'.repeat(inner + 2)}╮`);
  const mid = `  ${green('│')} ${padVisibleTo(title, inner)} ${green('│')}`;
  const bot = green(`  ╰${'─'.repeat(inner + 2)}╯`);
  return [top, mid, bot];
}

/**
 * Build the contextual hint shown above the test-setup terminal box.
 * Pure function - decides which of three messages applies based on the
 * run history and returns `{ kind, lines }` where `kind` is one of
 * `'success' | 'failing' | 'default'` and `lines` is the rendered ANSI
 * strings.
 *
 * Success is NOT tied to a 2xx response. We only care that the request
 * reached the Restless SDK: either a log landed on the dashboard (any
 * status, including a 401) or the caller told us the SDK header came back
 * clean (`sdkDetected`). An unauthenticated request that's rejected still
 * proves the wiring, so the user never needs a real API key.
 *
 * Exposed at module level so tests can drive it without spinning up the
 * full TUI; the renderer in `terminalRunScreen` just consumes `lines`.
 */
export function pickContextualHint({
  logs = [],
  failedAttempts = [],
  pendingEntry = null,
  sdkDetected = false,
} = {}) {
  const hadLog = Array.isArray(logs) && logs.length > 0;
  const failedCount =
    (Array.isArray(failedAttempts) ? failedAttempts.length : 0) +
    (pendingEntry && pendingEntry.state === 'failed' ? 1 : 0);

  if (sdkDetected || hadLog) {
    return {
      kind: 'success',
      lines: [
        `  ${green("Nice - the SDK is picking up your requests.")}`,
        `  ${dim('Press ')}${bold('Tab')}${dim(' to continue the setup.')}`,
      ],
    };
  }
  if (failedCount >= 3) {
    return {
      kind: 'failing',
      lines: [
        `  ${yellow("Still not seeing it - check your server is running and RESTLESS_KEY is set.")}`,
        `  ${dim("If you'd rather skip ahead and fix this later, press ")}${bold('Tab')}${dim(' to continue.')}`,
      ],
    };
  }
  return {
    kind: 'default',
    lines: [
      `  Press ${bold('enter')} to send a test request - no API key needed.`,
      `  ${dim("A rejected request (like a ")}${bold('401')}${dim(") still confirms the SDK is working.")}`,
      `  ${dim('Or press ')}${bold('Tab')}${dim(' to skip this step.')}`,
    ],
  };
}

/**
 * Normalize a singleSelect item into `{ label, hint }`. Accepts:
 *   - string                 -> label, no hint
 *   - "label\nhint"          -> label + dim hint
 *   - { label, hint }        -> as-is
 */
export function normalizePickerItem(it) {
  if (it && typeof it === 'object' && 'label' in it) {
    return { label: String(it.label ?? ''), hint: String(it.hint ?? '') };
  }
  const parts = String(it).split('\n');
  return { label: parts[0], hint: parts.slice(1).join(' ').trim() };
}

/**
 * Standard single-select picker. Each item is a primary label plus an
 * optional dim hint line - pass either `{ label, hint }` or a string that
 * may contain a `\n` separating the two. The cursor row gets a background
 * highlight that spans the label and hint together.
 */
export function singleSelect(items, { message, defaultIndex = 0 } = {}) {
  const endWait = timings.start('prompt: single-select', { kind: timings.KINDS.WAIT });
  // Non-interactive: take the default option and announce it so the
  // agent's transcript records which branch was chosen.
  if (!isInteractive()) {
    const idx = Math.min(Math.max(defaultIndex, 0), items.length - 1);
    const chosen = normalizePickerItem(items[idx]);
    console.log(`  ${bold(message || '')} ${dim('→')} ${stripAnsi(chosen.label)}`);
    endWait();
    debug.log('input.singleSelect', {
      message,
      items: items.map((it) => stripAnsi(normalizePickerItem(it).label)),
      selected: idx,
      selectedItem: stripAnsi(chosen.label),
      auto: true,
    });
    return Promise.resolve(idx);
  }
  return new Promise((resolve) => {
    let cursor = defaultIndex;

    const { stdin, stdout } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const normalized = items.map(normalizePickerItem);
    const linesPerItem = (it) => 1 + (it.hint ? 1 : 0);
    const totalRows = () => normalized.reduce((n, it) => n + linesPerItem(it), 0);

    function drawList(initial = false) {
      // +3 = the leading blank, the question, and the blank under it. Keep
      // this in step with the writes below or the redraw eats a real line.
      if (!initial) clearLines(totalRows() + 3);
      stdout.write('\n');
      stdout.write(`  ${bold(message)}\n`);
      // Breathing room between the question and the answers - without it the
      // first option reads as part of the question.
      stdout.write('\n');
      const width = termWidth();
      for (let i = 0; i < normalized.length; i++) {
        const { label, hint } = normalized[i];
        const isCursor = i === cursor;
        const pointer = isCursor ? cyan('❯') : ' ';
        const num = dim(`${i + 1}.`);
        const labelText = isCursor ? bold(label) : label;
        const labelLine = `  ${pointer} ${num} ${labelText}`;
        // Cursor rows get padded to full terminal width so the bg highlight
        // is a uniform band across both label and hint.
        if (isCursor) {
          stdout.write(pickerHighlight(padVisibleTo(labelLine, width)) + '\n');
        } else {
          stdout.write(labelLine + '\n');
        }
        if (hint) {
          const hintLine = `       ${dim(hint)}`;
          if (isCursor) {
            stdout.write(pickerHighlight(padVisibleTo(hintLine, width)) + '\n');
          } else {
            stdout.write(hintLine + '\n');
          }
        }
      }
    }

    drawList(true);

    stdin.on('data', (key) => {
      if (key === '\x1b[A') {
        cursor = (cursor - 1 + normalized.length) % normalized.length;
        drawList();
        return;
      }
      if (key === '\x1b[B') {
        cursor = (cursor + 1) % normalized.length;
        drawList();
        return;
      }
      if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        endWait();
        debug.log('input.singleSelect', {
          message,
          items: normalized.map((it) => stripAnsi(it.label)),
          selected: cursor,
          selectedItem: stripAnsi(normalized[cursor].label),
        });
        resolve(cursor);
        return;
      }
      if (isAbortKey(key)) {
        stdin.setRawMode(false);
        debug.abortExit(0);
      }
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (idx < normalized.length) {
          cursor = idx;
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          drawList();
          endWait();
          debug.log('input.singleSelect', {
            message,
            items: normalized.map((it) => stripAnsi(it.label)),
            selected: cursor,
            selectedItem: stripAnsi(normalized[cursor].label),
          });
          resolve(cursor);
        }
      }
    });
  });
}

/**
 * Picker variant with editable-field items and bottom-anchored actions.
 * Items render as `N. Label  value`; actions render below the items
 * with extra vertical breathing room so Submit doesn't look like just
 * another picker row, and so an `afterthought` action (like Chat) sits
 * visibly apart from the primary one.
 *
 *   item:   { label, value?, hint? }
 *   action: { key, label, hint?, primary?, afterthought? }
 *
 * The cursor flows through items first, then actions. Returns:
 *   { kind: 'item',   index }   for an item activation (Enter on a field)
 *   { kind: 'action', key }     for an action activation (Submit / Chat)
 *
 * Ctrl-C exits. Number keys 1-9 jump directly to an item.
 */
export function actionPicker(items, { message, actions = [], defaultIndex = 0 } = {}) {
  const endWait = timings.start('prompt: action picker', { kind: timings.KINDS.WAIT });
  // Non-interactive: there are no fields to edit, so fire the primary
  // action (Submit) - or the first action if none is marked primary.
  if (!isInteractive()) {
    const act = actions.find((a) => a.primary) || actions[0];
    if (act) {
      endWait();
      debug.log('input.actionPicker', { message, kind: 'action', key: act.key, auto: true });
      return Promise.resolve({ kind: 'action', key: act.key });
    }
    endWait();
    debug.log('input.actionPicker', { message, kind: 'item', index: 0, auto: true });
    return Promise.resolve({ kind: 'item', index: 0 });
  }
  return new Promise((resolve) => {
    let cursor = Math.min(Math.max(defaultIndex, 0), Math.max(items.length + actions.length - 1, 0));

    const { stdin, stdout } = process;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const totalCount = items.length + actions.length;
    const labelWidth = items.length
      ? Math.max(...items.map((it) => String(it.label || '').length))
      : 0;

    function valueDisplay(v) {
      if (v === undefined || v === null || v === '') return dim('-');
      return String(v);
    }

    function itemRows(it, i) {
      const isCursor = i === cursor;
      const pointer = isCursor ? cyan('›') : ' ';
      const num = dim(`${i + 1}.`);
      const label = String(it.label || '');
      const padded = label + ' '.repeat(Math.max(0, labelWidth - label.length));
      const labelStyled = isCursor ? bold(padded) : padded;
      const value = valueDisplay(it.value);
      const rows = [`${pointer} ${num} ${labelStyled}   ${value}`];
      if (it.hint) rows.push(`  ${dim(it.hint)}`);
      return rows;
    }

    function actionRows(act, i) {
      const isCursor = i === cursor;
      let marker;
      let labelText;
      if (act.primary) {
        marker = green('●');
        labelText = bold(green(act.label));
      } else if (act.afterthought) {
        marker = dim('·');
        labelText = isCursor ? bold(dim(act.label)) : dim(act.label);
      } else {
        marker = dim('·');
        labelText = isCursor ? bold(act.label) : act.label;
      }
      // Focus on an action shows as a left cursor before the marker,
      // so the user can tell the cursor moved off the field list.
      const pointer = isCursor ? cyan('›') : ' ';
      const rows = [`${pointer} ${marker} ${labelText}`];
      if (act.hint && !act.afterthought) rows.push(`    ${dim(act.hint)}`);
      return rows;
    }

    function buildLines() {
      const all = ['', `  ${bold(message)}`];

      // Editable fields (if any), separated from the message by one blank.
      if (items.length) {
        all.push('');
        for (let i = 0; i < items.length; i++) {
          for (const r of itemRows(items[i], i)) all.push(r);
        }
      }

      // Actions render as a compact list - one row each, hint indented
      // under it. A single blank sets the block apart from the message /
      // fields above, and another single blank groups the `afterthought`
      // actions (Change port / Skip) below the primary ones. The pointer,
      // the green ● primary marker, and the dim · afterthought marker carry
      // the visual hierarchy - we don't need double gaps to spell it out.
      if (actions.length) {
        all.push('');
        let afterthoughtSeen = false;
        for (let i = 0; i < actions.length; i++) {
          if (actions[i].afterthought && !afterthoughtSeen) {
            all.push('');
            afterthoughtSeen = true;
          }
          for (const r of actionRows(actions[i], items.length + i)) all.push(r);
        }
      }
      return all;
    }

    let drawn = 0;
    function draw(initial = false) {
      if (!initial) clearLines(drawn);
      const lines = buildLines();
      for (const line of lines) stdout.write(line + '\n');
      drawn = lines.length;
    }

    draw(true);

    function activate() {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      if (cursor < items.length) {
        endWait();
        debug.log('input.actionPicker', { message, kind: 'item', index: cursor });
        resolve({ kind: 'item', index: cursor });
      } else {
        const act = actions[cursor - items.length];
        endWait();
        debug.log('input.actionPicker', { message, kind: 'action', key: act.key });
        resolve({ kind: 'action', key: act.key });
      }
    }

    stdin.on('data', (key) => {
      if (key === '\x1b[A') {
        cursor = (cursor - 1 + totalCount) % totalCount;
        draw();
        return;
      }
      if (key === '\x1b[B') {
        cursor = (cursor + 1) % totalCount;
        draw();
        return;
      }
      if (key === '\r' || key === '\n') {
        activate();
        return;
      }
      if (isAbortKey(key)) {
        stdin.setRawMode(false);
        debug.abortExit(0);
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const idx = parseInt(key, 10) - 1;
        if (idx < items.length) {
          cursor = idx;
          activate();
        }
      }
    });
  });
}

/**
 * Type a string into stdout one visible character at a time. ANSI color
 * escapes are written atomically so they don't glitch. Honors non-TTY
 * (just writes the string at once, no animation).
 */
export async function typeOut(text, opts) {
  return timings.measure('anim: type out', () => typeOutImpl(text, opts), {
    kind: timings.KINDS.ANIM,
    chars: typeof text === 'string' ? text.length : 0,
  });
}

async function typeOutImpl(text, { delay = 18 } = {}) {
  if (!process.stdout.isTTY) {
    process.stdout.write(text);
    return;
  }
  // Split on ANSI SGR sequences so we type visible chars but write color
  // codes atomically.
  // eslint-disable-next-line no-control-regex
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\x1b[')) {
      process.stdout.write(part);
    } else {
      for (const ch of part) {
        process.stdout.write(ch);
        if (delay > 0) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
  }
}

export async function typeLine(text, opts) {
  await typeOut(text, opts);
  process.stdout.write('\n');
}

/**
 * Swallow keystrokes during non-interactive animations (the logo reveal and
 * the typed intro copy). Without this, anything the user types while the
 * animation plays is echoed by the terminal and interleaves with the text
 * being written, and the bytes also queue up to skip the next prompt.
 *
 * Raw mode disables the terminal's echo; the data handler then discards
 * whatever was typed (it's noise relative to the animation) while still
 * honoring Ctrl-C so the user can abort. Because raw + flowing stdin
 * delivers each keystroke immediately, nothing stays buffered to leak into
 * the keypress wait that follows.
 *
 * Returns a `restore()` that puts stdin back the way the next reader
 * (`waitForKey` / `ask`) expects it. No-op on a non-TTY stdin (piped input).
 */
export function suppressInput() {
  const { stdin } = process;
  if (!stdin.isTTY) return () => {};
  const onData = (key) => {
    if (isAbortKey(key)) debug.abortExit(0); // Ctrl-C or Esc still aborts.
  };
  try { stdin.setRawMode(true); } catch {}
  stdin.resume();
  stdin.setEncoding('utf8');
  stdin.on('data', onData);
  return () => {
    stdin.removeListener('data', onData);
    try { stdin.setRawMode(false); } catch {}
    stdin.pause();
  };
}

// Logo lines as char-tokens. Each line is an array of [char, colorFn] pairs
// so `printLogo` and `animateLogoIn` can share the same source of truth.
const _logoId = (s) => s;
const _logoMk = (segs) => segs.flatMap(([t, c]) => [...t].map((ch) => [ch, c]));
// Logo colors: thick bars use the brand blue, thin rules a dark #3b3b3b.
const _logoThick = brand;
const _logoThin = (s) => `\x1b[38;2;59;59;59m${s}\x1b[0m`;
// Block char options: `▬` (centered rectangle, current) or `▓` (dithered full
// block - try this for a more textured look).
const LOGO_LINES = [
  _logoMk([['─', _logoThin], [' ', _logoId], ['▬▬▬▬▬▬▬', _logoThick], [' ', _logoId], ['─────', _logoThin]]),
  _logoMk([['────', _logoThin], [' ', _logoId], ['▬▬▬▬▬▬', _logoThick], [' ', _logoId], ['───', _logoThin]]),
  _logoMk([['──', _logoThin], [' ', _logoId], ['▬▬▬▬▬▬', _logoThick], [' ', _logoId], ['─────', _logoThin]]),
  _logoMk([['─', _logoThin], [' ', _logoId], ['▬▬▬', _logoThick], [' ', _logoId], ['──', _logoThin], [' ', _logoId], ['▬▬▬', _logoThick], [' ', _logoId], ['──', _logoThin]]),
];
// Row 2 names the command actually running. It was hardcoded to `init`, which
// is what `update` displayed above its own screens.
// When the CLI is a local, linked build (see `IS_LINKED_INSTALL`), flag it in
// yellow beside the brand name so a dev never mistakes a checkout for the
// published package.
const LOCAL_WARNING = IS_LINKED_INSTALL ? `  ${yellow('⚠ local linked')}` : '';
const LOGO_SUFFIXES = (subtitle) => ['', `    ${bold('Restless')}${LOCAL_WARNING}`, `    ${dim(subtitle)}`, ''];

/** What row 2 says. Set once per command by `setLogoSubtitle`. */
let _logoSubtitle = `npx ${CLI_NAME} init`;

/** Name the running command, so every screen it draws is labelled correctly. */
export function setLogoSubtitle(subtitle) {
  _logoSubtitle = subtitle;
}

function _renderLogoLine(i, charsToShow = Infinity) {
  let s = '  ';
  const line = LOGO_LINES[i];
  const n = Math.min(charsToShow, line.length);
  for (let j = 0; j < n; j++) {
    const [ch, color] = line[j];
    s += color(ch);
  }
  if (n === line.length) s += LOGO_SUFFIXES(_logoSubtitle)[i];
  return s;
}

export const LOGO_HEIGHT = LOGO_LINES.length;
export const LOGO_WIDTH = LOGO_LINES[0].length; // visual cols (lines are equal-width)

/** Return the colored character string for one logo row, no indent / suffix. */
export function renderLogoLine(i) {
  let s = '';
  for (const [ch, color] of LOGO_LINES[i]) s += color(ch);
  return s;
}

/**
 * Does this keypress mean "get me out of here"?
 *
 * Ctrl-C and a bare Esc, treated identically. Every raw-mode prompt in this
 * file checks it, so Esc leaves from wherever you are rather than only from the
 * few screens that thought to offer it.
 *
 * The Esc comparison is EXACT and must stay that way. Arrow keys arrive as
 * `\x1b[A` and friends, so a `startsWith` test here would make Up and Down quit
 * the picker instead of moving in it. Ctrl-C keeps the looser `includes` check
 * it already had, since it can arrive bundled with other bytes.
 */
export function isAbortKey(key) {
  if (typeof key !== 'string') return false;
  const CTRL_C = '\x03';
  const ESC = '\x1b';
  return key.includes(CTRL_C) || key === ESC;
}

/**
 * Print the logo statically, no animation. Use this on screens where the
 * logo should just be present at the top.
 */
export function printLogo() {
  for (let i = 0; i < LOGO_LINES.length; i++) {
    process.stdout.write(_renderLogoLine(i) + '\n');
  }
}

/**
 * Animate the logo in line by line, each line revealing left-to-right.
 * Lines start in quick succession so the reveals overlap.
 */
export async function animateLogoIn(opts) {
  return timings.measure('anim: logo reveal', () => animateLogoInImpl(opts), {
    kind: timings.KINDS.ANIM,
  });
}

async function animateLogoInImpl({ charDelay = 12, lineStagger = 50 } = {}) {
  if (!process.stdout.isTTY) {
    printLogo();
    return;
  }
  // Reserve 4 lines, jump back to top of logo area, save cursor.
  process.stdout.write('\x1b[?25l\n\n\n\n\x1b[4A\x1b7');
  const startTick = LOGO_LINES.map((_, i) => Math.round((i * lineStagger) / charDelay));
  const written = LOGO_LINES.map(() => 0);
  const totalTicks = Math.max(...startTick.map((s, i) => s + LOGO_LINES[i].length));

  for (let tick = 0; tick <= totalTicks; tick++) {
    for (let i = 0; i < LOGO_LINES.length; i++) {
      if (tick < startTick[i]) continue;
      written[i] = Math.min(tick - startTick[i] + 1, LOGO_LINES[i].length);
    }
    process.stdout.write('\x1b8'); // restore cursor to top of logo area
    for (let i = 0; i < LOGO_LINES.length; i++) {
      process.stdout.write('\x1b[2K\r' + _renderLogoLine(i, written[i]));
      if (i < LOGO_LINES.length - 1) process.stdout.write('\n');
    }
    if (tick < totalTicks) await new Promise((r) => setTimeout(r, charDelay));
  }

  // Move cursor below the logo and re-show it.
  process.stdout.write('\x1b8\x1b[4B\r\x1b[?25h');
}

/**
 * Named spinner presets. Try each by changing `style` in the inlineStatus
 * call site. All frames are single-width so they animate in place via \b.
 */
export const SPINNERS = {
  // Subtle rotating arc. Quiet.
  arc:        ['◜', '◝', '◞', '◟'],

  // Rotating half-circle. Strong spin feel.
  halfcircle: ['◐', '◓', '◑', '◒'],

  // Pie chart filling up. Clockwise growth.
  piefill:    ['◴', '◵', '◶', '◷'],

  // Dot growing/shrinking - pulse. Low-key.
  pulse:      ['·', '∙', '•', '●', '•', '∙'],

  // Claude-style rotating sparkle. Busy, magical.
  sparkle:    ['✦', '✧', '✶', '✷', '✸', '✹'],

  // Concentric circles opening and closing. Breathy.
  concentric: ['◌', '○', '◎', '●', '◎', '○'],

  // Classic braille spinner. The default in most CLIs.
  braille:    ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

/**
 * One frame of the "we're working on it" spinner, cyan-tinted. Callers pass a
 * monotonically increasing counter (e.g. the frame arg from
 * `waitForServerOrKey`'s render callback) and get back a single glyph. Uses
 * the same concentric-breathing frames as the plan spinner so the visual
 * language stays consistent.
 */
export function watchSpinner(frame = 0) {
  const frames = SPINNERS.concentric;
  return cyan(frames[frame % frames.length]);
}

/**
 * Same breathing frames as `watchSpinner`, but dimmed - for a demoted
 * "checking…" sub-line where the animation should read as quiet background
 * activity, not the primary "we're working on it" signal. Returns just the
 * glyph (already dim-wrapped); keep any trailing label a separate `dim(...)`
 * so nesting resets don't cancel the dim.
 */
export function dimSpinner(frame = 0) {
  const frames = SPINNERS.concentric;
  return dim(frames[frame % frames.length]);
}

/**
 * A dim pulsing dot - deliberately NOT the concentric breathing spinner.
 * Used for a "still working in the background" line that sits next to a
 * message the user is meant to act on: the concentric glyph reads as "we're
 * busy, wait", which would fight the call to action. Returns just the glyph
 * (already dim-wrapped); keep any label a separate `dim(...)` so nesting
 * resets don't cancel the dim.
 */
export function dimPulse(frame = 0) {
  // A trimmed `SPINNERS.pulse` - the preset's peak frame is `●`, which is
  // also the concentric spinner's peak, so the two animations would collide
  // on their loudest frame. Staying under it keeps this unmistakably the
  // quiet one.
  const frames = ['·', '∙', '•', '∙'];
  return dim(frames[frame % frames.length]);
}

// Green dominant, with warm accents on the off-beats. The color holds for a
// full breathing loop before advancing - so you see a complete green breath,
// then a complete yellow breath, then green, then orange, etc.
const PLAN_SPINNER_COLORS = [green, yellow, green, orange, green, red];

/**
 * One frame of the plan's spinner: the same concentric breathing frames as
 * `watchSpinner`, but running the green/warm color cycle the plan renderer
 * uses. `lib/runner.js` draws its spinner with this, and step messages that
 * need their own inline "we're working on it" glyph use it too, so both read
 * as the same spinner rather than two different ones.
 */
export function planSpinner(frame = 0) {
  const frames = SPINNERS.concentric;
  const color = PLAN_SPINNER_COLORS[Math.floor(frame / frames.length) % PLAN_SPINNER_COLORS.length];
  return color(frames[frame % frames.length]);
}

/**
 * Animate a "loading → resolved status" in place on the current line.
 * The spinner lands in place where the colored ● ends up, and the
 * status code types in after it. No erase-and-replace - caller's
 * surrounding text isn't disturbed.
 *
 *   await inlineStatus({ code: '400 Bad Request', success: false });
 *
 * Valid styles: arc, halfcircle, piefill, pulse, sparkle, concentric, braille.
 */
export async function inlineStatus(opts) {
  return timings.measure('anim: inline status', () => inlineStatusImpl(opts), {
    kind: timings.KINDS.ANIM,
    style: opts?.style || 'arc',
  });
}

async function inlineStatusImpl({ code, success, duration = 1100, style = 'arc' }) {
  // Dot and label share one color so they read as a single unit. Success
  // uses the truecolor green; failure the truecolor red.
  const circle = success ? statusGreen('●') : brightRed('●');
  const colored = success ? statusGreen(bold(code)) : brightRed(bold(code));

  if (!process.stdout.isTTY) {
    // Non-TTY: just emit the final status.
    process.stdout.write(`${circle} ${colored}`);
    return;
  }

  const frames = SPINNERS[style] || SPINNERS.arc;
  let frame = 0;

  // We always keep a trailing space after the active glyph, and the
  // cursor parks one column past the space. That way the terminal's
  // blinking cursor never sits on top of the spinner / dot.
  //
  // Repaint pattern each frame: ANSI cursor-back-2 → write glyph →
  // write space. End state: glyph at column N, space at N+1, cursor
  // at N+2. Using `\x1b[2D` instead of two `\b`s for portability -
  // some terminals collapse repeated backspaces.
  process.stdout.write(dim(frames[0]) + ' ');

  const interval = setInterval(() => {
    frame = (frame + 1) % frames.length;
    process.stdout.write('\x1b[2D' + dim(frames[frame]) + ' ');
  }, 110);

  await new Promise((r) => setTimeout(r, duration));
  clearInterval(interval);

  // Land: spinner → dim filled circle → colored filled circle → text.
  // Each transition just repaints the glyph at column N, leaving the
  // trailing space (and the parked cursor) untouched.
  process.stdout.write('\x1b[2D' + dim('●') + ' ');
  await new Promise((r) => setTimeout(r, 120));
  process.stdout.write('\x1b[2D' + circle + ' ');
  await new Promise((r) => setTimeout(r, 60));
  await typeOut(colored);
}

/**
 * Wait for any keypress. Ctrl-C exits. Returns the pressed key as a string
 * (single char for printable keys, escape sequence for arrows, etc.) so
 * callers can branch on specific shortcuts.
 */
export function waitForKey() {
  const endWait = timings.start('prompt: press a key', { kind: timings.KINDS.WAIT });
  // Non-interactive: nothing will ever press a key. Resolve as if the user
  // hit Enter so "press ENTER to continue" gates fall straight through.
  if (!isInteractive()) {
    endWait();
    debug.log('input.waitForKey', { key: '\\r', auto: true });
    return Promise.resolve('\r');
  }
  return new Promise((resolve) => {
    const { stdin } = process;
    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (key) => {
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      if (isAbortKey(key)) debug.abortExit(0);
      endWait();
      debug.log('input.waitForKey', { key: keyDisplay(key) });
      resolve(key);
    });
  });
}

/**
 * Poll `probe()` on an interval until it reports the server is reachable,
 * OR the user presses a key - whichever comes first. This is the passive
 * "waiting for your server" primitive: the user doesn't run anything, we
 * just watch, and a keypress is their escape hatch (change port / skip).
 *
 * `probe` returns (or resolves to) an object with a `state` field; any
 * state other than `'unreachable'` counts as reachable and ends the wait.
 * `render(attempt, frame)` is called before each probe AND on a fast
 * animation tick in between, so the caller can redraw a "still waiting…"
 * line with a spinner that actually moves. `attempt` counts probes;
 * `frame` counts animation ticks (feed it to `watchSpinner`).
 *
 * Resolves with either:
 *   { type: 'reachable', result }   - probe returned a non-unreachable state
 *   { type: 'key', key }            - the user pressed a key
 */
export function waitForServerOrKey(probe, { intervalMs = 2000, spinnerMs = 180, render } = {}) {
  const endWait = timings.start('prompt: waiting for your server', { kind: timings.KINDS.WAIT });
  return new Promise((resolve) => {
    const { stdin } = process;
    let stopped = false;
    let timer = null;
    let spinTimer = null;
    let attempt = 0;
    let frame = 0;

    function paint() {
      if (render) { try { render(attempt, frame); } catch {} }
    }

    function cleanup() {
      stopped = true;
      // Every exit from this wait routes through cleanup - the keypress
      // path, the server-came-up path, and the ctrl-c path - so closing the
      // span here covers all three. `endWait` is idempotent, so the
      // keypress path closing it first to keep the span outside the
      // `input.*` log is not a double count.
      endWait();
      if (timer) { clearTimeout(timer); timer = null; }
      if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      stdin.removeListener('data', onKey);
    }

    function onKey(key) {
      if (stopped) return;
      if (isAbortKey(key)) { cleanup(); debug.abortExit(0); return; }
      endWait();
      debug.log('input.waitForServerOrKey', { key: keyDisplay(key) });
      cleanup();
      resolve({ type: 'key', key });
    }

    async function tick() {
      if (stopped) return;
      attempt++;
      paint();
      let result;
      try { result = await probe(); } catch { result = { state: 'unreachable' }; }
      if (stopped) return;
      if (result && result.state && result.state !== 'unreachable') {
        cleanup();
        resolve({ type: 'reachable', result });
        return;
      }
      timer = setTimeout(tick, intervalMs);
    }

    // Advance the spinner frame between probes so the "working" glyph
    // animates smoothly instead of only redrawing once every `intervalMs`.
    if (render) {
      spinTimer = setInterval(() => {
        if (stopped) return;
        frame++;
        paint();
      }, spinnerMs);
    }

    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onKey);
    tick();
  });
}

// Render a key for the debug log without dumping raw control bytes.
// Printable chars pass through; everything else becomes a hex escape.
function keyDisplay(k) {
  if (!k) return '';
  if (k.length === 1 && k.charCodeAt(0) >= 32 && k.charCodeAt(0) < 127) return k;
  return [...k].map((c) => {
    const code = c.charCodeAt(0);
    if (code >= 32 && code < 127) return c;
    return '\\x' + code.toString(16).padStart(2, '0');
  }).join('');
}

/**
 * Single-keypress yes/no prompt. Prefer this over `ask()` for any y/n
 * question - it's more reliable (raw-mode stdin, no readline) and more
 * ergonomic (no Enter required).
 *
 *   y / Y   → true
 *   n / N   → false
 *   Enter   → defaultValue
 *   Ctrl-C  → exit(130)
 *
 * Any other key re-prompts silently. `prompt` is written via stdout before
 * the read starts; pass an empty string if the caller already drew the
 * question through the plan updater.
 */
export function askYesNo(prompt = '', { defaultValue = true } = {}) {
  const endWait = timings.start('prompt: yes/no', { kind: timings.KINDS.WAIT });
  // Non-interactive: take the caller's default (the safe path they already
  // chose for an unattended run) rather than blocking on a keypress.
  if (!isInteractive()) {
    if (prompt) process.stdout.write(prompt);
    process.stdout.write(defaultValue ? 'y\n' : 'n\n');
    endWait();
    debug.log('input.askYesNo', { prompt: stripAnsi(prompt), answer: defaultValue, auto: true });
    return Promise.resolve(defaultValue);
  }
  if (prompt) process.stdout.write(prompt);
  return new Promise((resolve) => {
    const { stdin } = process;

    // Belt-and-suspenders cleanup of prior UI state. `waitForKey` / readline
    // both leave stdin in configurations that trip each other up.
    try { stdin.setRawMode(false); } catch {}
    stdin.removeAllListeners('data');
    stdin.removeAllListeners('keypress');
    stdin.removeAllListeners('readable');

    try { stdin.setRawMode(true); } catch {}
    stdin.resume();
    stdin.setEncoding('utf8');

    const onKey = (key) => {
      if (isAbortKey(key)) {
        try { stdin.setRawMode(false); } catch {}
        stdin.pause();
        process.stdout.write('\n');
        debug.abortExit(130);
        return;
      }
      const ch = (key || '').toLowerCase();
      let answer;
      if (ch === 'y') answer = true;
      else if (ch === 'n') answer = false;
      else if (key === '\r' || key === '\n') answer = defaultValue;
      else return; // ignore anything else - wait for a valid key
      stdin.off('data', onKey);
      try { stdin.setRawMode(false); } catch {}
      stdin.pause();
      process.stdout.write(answer ? 'y\n' : 'n\n');
      endWait();
      debug.log('input.askYesNo', { prompt: stripAnsi(prompt), answer });
      resolve(answer);
    };
    stdin.on('data', onKey);
  });
}

export function startSpinner(initialMsg) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let msg = initialMsg;

  // Clamp to one line, always.
  //
  // This redraws with `\x1b[2K\r`, which clears the current line and returns
  // to ITS start. If the message is wider than the terminal it wraps, so `\r`
  // lands at the start of the last visual line only, the earlier ones survive,
  // and every tick adds another - the spinner scrolls the screen instead of
  // spinning, and looks like a hang. Messages here are built from things we
  // don't control the length of (URLs, file paths, AI-written summaries), so
  // truncating is the spinner's job rather than each caller's.
  const fit = (text) => {
    const width = process.stdout.columns || 80;
    // 2 leading spaces + frame + space, and leave the last column free so a
    // terminal that auto-wraps at the boundary doesn't push us onto line two.
    const room = Math.max(width - 6, 10);
    const plain = String(text ?? '').replace(/\x1b\[[0-9;]*m/g, '');
    return plain.length > room ? `${plain.slice(0, room - 1)}…` : plain;
  };

  // Nothing redraws anything when stdout is a pipe or a CI log: the clear-line
  // escape is inert there, so every 80ms tick APPENDS a frame instead of
  // replacing one. A `context` run that spins for minutes buries its own
  // output under thousands of them. Print the message once and stop.
  if (!process.stdout.isTTY) {
    // Written through `process.stdout.write` like every other branch here, not
    // `console.log`: Node's Console captures the stream's write method when it
    // is constructed, so a caller (or a test) that swaps `process.stdout.write`
    // would see the animated output and silently miss this.
    if (msg) process.stdout.write(`  ${dim(fit(msg))}\n`);
    return { update() {}, stop() {} };
  }

  const interval = setInterval(() => {
    process.stdout.write(`\x1b[2K\r  ${dim(frames[i++ % frames.length])} ${dim(fit(msg))}`);
  }, 80);
  return {
    update(newMsg) { msg = newMsg; },
    stop() {
      clearInterval(interval);
      process.stdout.write('\x1b[2K\r');
    },
  };
}

export async function terminalPrompt(defaultCommand) {
  const endWait = timings.start('prompt: edit command', { kind: timings.KINDS.WAIT });
  // Non-interactive: no box to edit - just surface the command we'd run
  // and hand it straight back to the caller.
  if (!isInteractive()) {
    console.log(`  ${dim('$')} ${defaultCommand}`);
    endWait();
    debug.log('input.terminalPrompt', { defaultCommand, command: defaultCommand, auto: true });
    return defaultCommand;
  }
  const { stdin, stdout } = process;
  const termWidth = stdout.columns || 80;
  const boxWidth = Math.max(Math.min(termWidth - 4, 72), 40);
  const cmdSpace = boxWidth - 7;

  const r = '\x1b[31m', y = '\x1b[33m', g = '\x1b[32m', d = '\x1b[2m', rst = '\x1b[0m';

  function renderBox(text, cp) {
    let visible = text;
    let visCursor = cp;
    if (text.length > cmdSpace) {
      const start = Math.max(0, cp - cmdSpace + 5);
      visible = text.substring(start, start + cmdSpace);
      visCursor = cp - start;
    }
    const pad = Math.max(0, cmdSpace - visible.length);

    const dashes = Math.max(boxWidth - 11, 1);
    const top = `  ${d}╭── ${rst}${r}●${rst} ${y}●${rst} ${g}●${rst}${d} ${'─'.repeat(dashes)}╮${rst}`;
    const cmd = `  ${d}│${rst}  ${d}$${rst} ${visible}${' '.repeat(pad)} ${d}│${rst}`;
    const bot = `  ${d}╰${'─'.repeat(boxWidth - 2)}╯${rst}`;
    // The box looks like a terminal, which reads as "output" rather than
    // "waiting on you" - so the call to action is the brightest thing under
    // it, with editing demoted to the aside it actually is.
    const help = `  ${brand(bold('⏎  Press ENTER to run'))}${d}  ·  or edit the command first${rst}`;

    return { top, cmd, bot, help, visCursor };
  }

  let boxDrawn = false;

  function drawBox(text, cp) {
    if (boxDrawn) {
      stdout.write('\x1b[1G\x1b[1A\x1b[J');
    }

    const { top, cmd, bot, help, visCursor } = renderBox(text, cp);
    stdout.write(`${top}\n${cmd}\n${bot}\n${help}`);
    stdout.write(`\x1b[2A\x1b[${8 + visCursor}G`);

    boxDrawn = true;
  }

  // Phase 1: Typing animation
  stdout.write('\n');
  stdout.write('\x1b[?25h');
  drawBox('', 0);

  let skipTyping = false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const skipHandler = (key) => {
    if (isAbortKey(key)) { stdin.setRawMode(false); stdout.write('\x1b[?25h\n'); debug.abortExit(0); return; }
    skipTyping = true;
  };
  stdin.on('data', skipHandler);

  for (let i = 0; i < defaultCommand.length && !skipTyping; i++) {
    await new Promise(r => setTimeout(r, 25));
    drawBox(defaultCommand.substring(0, i + 1), i + 1);
  }

  stdin.removeListener('data', skipHandler);
  drawBox(defaultCommand, defaultCommand.length);

  // Phase 2: Interactive editing
  return new Promise((resolve) => {
    let buffer = defaultCommand;
    let cursor = buffer.length;

    function onKey(key) {
      if (key === '\r' || key === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeAllListeners('data');
        stdout.write('\x1b[2B\x1b[1G\n');
        endWait();
        debug.log('input.terminalPrompt', { defaultCommand, command: buffer });
        resolve(buffer);
      } else if (key === '\x7f' || key === '\b') {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor--;
          drawBox(buffer, cursor);
        }
      } else if (key === '\x1b[D') {
        if (cursor > 0) { cursor--; drawBox(buffer, cursor); }
      } else if (key === '\x1b[C') {
        if (cursor < buffer.length) { cursor++; drawBox(buffer, cursor); }
      } else if (key === '\x01') {
        cursor = 0; drawBox(buffer, cursor);
      } else if (key === '\x05') {
        cursor = buffer.length; drawBox(buffer, cursor);
      } else if (isAbortKey(key)) {
        stdin.setRawMode(false);
        stdout.write('\x1b[?25h\n');
        debug.abortExit(0);
      } else if (key.length > 0 && !key.startsWith('\x1b') && key.charCodeAt(0) >= 32) {
        for (const ch of key) {
          if (ch.charCodeAt(0) >= 32) {
            buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
            cursor++;
          }
        }
        drawBox(buffer, cursor);
      }
    }

    stdin.on('data', onKey);
  });
}

/**
 * The command box, read-only: types a command out so the user can see exactly
 * what's about to happen, then waits for ENTER. No editing - this is a
 * preview of what we'll run, not a prompt.
 *
 * Shares the chrome with `terminalPrompt` deliberately: by the time someone
 * reaches step 3 they've already met this box once, so a command sitting in
 * it reads as "this is the thing that runs" without any explaining.
 */
export async function terminalPreview(command, { cta = 'Press ENTER to run it', note = '' } = {}) {
  const endWait = timings.start('prompt: run command', { kind: timings.KINDS.WAIT });
  if (!isInteractive()) {
    console.log(`  ${dim('$')} ${command}`);
    endWait();
    debug.log('input.terminalPreview', { command, auto: true });
    return;
  }
  const { stdin, stdout } = process;
  const termWidth = stdout.columns || 80;
  const boxWidth = Math.max(Math.min(termWidth - 4, 72), 40);
  const cmdSpace = boxWidth - 7;

  const r = '\x1b[31m', y = '\x1b[33m', g = '\x1b[32m', d = '\x1b[2m', rst = '\x1b[0m';
  let drawn = false;

  // The box is four rows (top / command / bottom / cta) and `draw` leaves the
  // cursor at the end of the last one, so rewinding has to climb all three
  // rows above it before clearing. Rewinding by one only wiped the bottom
  // half, and every keystroke of the typing animation stacked another box.
  const BOX_ROWS = 4;

  function draw(text) {
    if (drawn) stdout.write(`\x1b[1G\x1b[${BOX_ROWS - 1}A\x1b[J`);
    // Too long for the box: keep the tail (host, path - the part that
    // identifies the request) and mark the cut so it doesn't look like the
    // command genuinely starts mid-word.
    const visible = text.length > cmdSpace
      ? `…${text.slice(text.length - (cmdSpace - 1))}`
      : text;
    const pad = Math.max(0, cmdSpace - visible.length);
    const dashes = Math.max(boxWidth - 11, 1);
    stdout.write(`  ${d}╭── ${rst}${r}●${rst} ${y}●${rst} ${g}●${rst}${d} ${'─'.repeat(dashes)}╮${rst}\n`);
    stdout.write(`  ${d}│${rst}  ${d}$${rst} ${visible}${' '.repeat(pad)} ${d}│${rst}\n`);
    stdout.write(`  ${d}╰${'─'.repeat(boxWidth - 2)}╯${rst}\n`);
    stdout.write(`  ${brand(bold(`⏎  ${cta}`))}${note ? `${d}  ·  ${note}${rst}` : ''}`);
    drawn = true;
  }

  stdout.write('\n');
  stdout.write('\x1b[?25l'); // no cursor - there's nothing to type into
  draw('');

  const isEnter = (key) => key === '\r' || key === '\n';

  let skipTyping = false;
  let enterDuringTyping = false;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  const skipHandler = (key) => {
    if (isAbortKey(key)) { stdin.setRawMode(false); stdout.write('\x1b[?25h\n'); debug.abortExit(0); return; }
    // Any key fast-forwards the typing. If it was ENTER, that also counts as
    // the confirmation - otherwise someone who hits it early has to hit it
    // again for no visible reason.
    if (isEnter(key)) enterDuringTyping = true;
    skipTyping = true;
  };
  stdin.on('data', skipHandler);

  for (let i = 0; i < command.length && !skipTyping; i++) {
    await new Promise((res) => setTimeout(res, 18));
    draw(command.slice(0, i + 1));
  }
  stdin.removeListener('data', skipHandler);
  draw(command);

  const finish = (key) => {
    stdin.setRawMode(false);
    stdin.pause();
    stdout.write('\x1b[?25h\n\n');
    endWait();
    debug.log('input.terminalPreview', { command, key });
  };

  if (enterDuringTyping) {
    finish('enter-during-typing');
    return;
  }

  await new Promise((resolve) => {
    const onKey = (key) => {
      if (isAbortKey(key)) { stdin.setRawMode(false); stdout.write('\x1b[?25h\n'); debug.abortExit(0); return; }
      // ENTER only. This used to continue on ANY key, which meant an arrow
      // key - a cursor-up to look at scrollback, say - fired off a real
      // request against the user's server. The footer promises ENTER; that's
      // the only thing that should count.
      if (!isEnter(key)) return;
      stdin.removeListener('data', onKey);
      finish('enter');
      resolve();
    };
    stdin.on('data', onKey);
  });
}

export async function terminalRunScreen(defaultCommand, { onRun, pollConfig, noLogsHint, noLogsHintMs = 8000, isSdkDetected } = {}) {
  const { stdin, stdout } = process;
  const termWidth = stdout.columns || 80;
  const termHeight = stdout.rows || 24;

  const boxWidth = termWidth - 4;
  const topHeight = Math.floor(termHeight / 2);
  const botHeight = termHeight - topHeight;
  const cmdSpace = boxWidth - 7;
  const maxOutputLines = botHeight - 5;

  const d = '\x1b[2m', rst = '\x1b[0m';
  const rc = '\x1b[31m', yc = '\x1b[33m', gc = '\x1b[32m';
  const bc = '\x1b[1m';

  // Log polling state
  let logs = [];
  let logCount = 0;
  let hasSuccessfulRun = false;
  let pollTimer = null;
  let pollSince = new Date().toISOString();

  // "In-flight" placeholder for the most recent run. Surfaced at the
  // top of the log list with a spinner; replaced by the real log when
  // it lands, or annotated with a diagnostic message if we conclude
  // (immediately or after `noLogsHintMs`) that no log will arrive.
  //
  //   { method, url, state: 'pending' | 'failed', hint?: string[],
  //     setAtCount: number, _seq: number }
  let pendingEntry = null;
  // Past attempts that resolved to a "failed" diagnostic (no SDK, no key,
  // etc). Kept newest-first so reruns add to the visible history instead
  // of wiping the previous warning.
  let failedAttempts = [];
  // Monotonically-incremented sequence number stamped on every event
  // (failed attempts + real logs). Lets us interleave the two streams
  // in chronological order so a successful call after a failed one
  // shows up ABOVE the failed row, not below it.
  let eventSeq = 0;
  let hintTimer = null;
  let spinFrame = 0;
  let spinTimer = null;
  // Concentric breathing-circle frames - same set runner.js uses, so
  // the loading icon here matches the one users already see in the plan.
  const SPINNER_FRAMES = ['◌', '○', '◎', '●', '◎', '○'];

  function startSpin() {
    if (spinTimer) return;
    spinTimer = setInterval(() => {
      spinFrame++;
      if (lastDrawArgs && pendingEntry && pendingEntry.state === 'pending') {
        drawScreen(...lastDrawArgs);
      }
    }, 180);
  }
  function stopSpin() {
    if (spinTimer) { clearInterval(spinTimer); spinTimer = null; }
  }
  function setPendingHint(hint) {
    if (!pendingEntry) return;
    const lines = Array.isArray(hint) ? hint : String(hint).split('\n');
    pendingEntry.state = 'failed';
    pendingEntry.hint = lines;
    stopSpin();
    if (lastDrawArgs) drawScreen(...lastDrawArgs);
  }
  function startNoLogsHintTimer() {
    if (!noLogsHint || hintTimer || !pendingEntry || pendingEntry.state !== 'pending') return;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      if (!pendingEntry || pendingEntry.state !== 'pending') return;
      if (logs.length > 0) return;
      const v = typeof noLogsHint === 'function' ? noLogsHint() : noLogsHint;
      if (v) setPendingHint(v);
    }, noLogsHintMs);
  }
  function clearHintTimer() {
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
  }

  async function pollLogs() {
    if (!pollConfig) return;
    try {
      const res = await fetch(pollConfig.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: pollConfig.projectId,
          setupKey: pollConfig.setupKey,
          since: pollSince,
          limit: 20,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.logs && data.logs.length > 0) {
          // Add new logs (avoid duplicates by id)
          const existingIds = new Set(logs.map(l => l.id));
          const newLogs = data.logs.filter(l => !existingIds.has(l.id));
          if (newLogs.length > 0) {
            for (const l of newLogs) l._seq = eventSeq++;
            logs = [...newLogs, ...logs];
            logCount += newLogs.length;
            // A real log just landed for the in-flight request - drop
            // the placeholder so the row doesn't double up.
            if (pendingEntry && logCount > pendingEntry.setAtCount) {
              pendingEntry = null;
              stopSpin();
              clearHintTimer();
            }
          }
        }
      }
    } catch {
      // Network blips are expected during early setup. Swallow - the
      // user will notice if logs never arrive (we surface a hint), and
      // a stderr write would shove the rendered TUI down a row.
    }
  }

  let exited = false;

  function startPolling() {
    if (!pollConfig || pollTimer) return;
    pollTimer = setInterval(async () => {
      if (exited) return;
      await pollLogs();
      if (!exited && lastDrawArgs) drawScreen(...lastDrawArgs);
    }, 1000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function cleanup() {
    exited = true;
    stopPolling();
    stopSpin();
    clearHintTimer();
    try { stdin.setRawMode(false); } catch {}
    // Pause BEFORE removing listeners to avoid 'end' event from flowing mode
    stdin.pause();
    stdin.removeAllListeners('data');
    // Clear the full-screen view so the plan manager can take over cleanly
    stdout.write('\x1b[?25h\x1b[H\x1b[J');
  }

  let lastDrawArgs = null;

  function buildTopHalf(currentCommand) {
    // A landed log (any status) is ground truth that the SDK captured and
    // uploaded the request. When there's no dashboard poll (no projectId),
    // fall back to the response-header diagnostic the caller exposes via
    // `isSdkDetected` - the SDK stamps every response, including a 401.
    const sdkDetected = !pollConfig && typeof isSdkDetected === 'function' && isSdkDetected();
    const hint = pickContextualHint({
      logs,
      failedAttempts,
      pendingEntry,
      sdkDetected,
    }).lines;
    const hintHeight = hint.length + 1; // hint + a blank spacer line above
    const lines = [];
    const maxLogLines = topHeight - 2 - hintHeight; // header + blank + hint block

    if (logs.length === 0 && !pendingEntry) {
      // No run yet - gentle prompt centered in the top half, with the
      // contextual hint pinned to the bottom. Body height = title + blank
      // + label = 3 rows. Total top-half target = topHeight; hint block
      // (spacer + hint lines) takes hintHeight, so the centered body +
      // surrounding pad needs to fill `topHeight - hintHeight` rows.
      const title = "Let's test the setup! Make an API request to see if it's working.";
      const label = 'Waiting for logs...';
      const verticalSlack = topHeight - hintHeight; // budget for body + padding
      const padBefore = Math.max(Math.floor((verticalSlack - 3) / 2), 0);
      const padAfter = Math.max(verticalSlack - padBefore - 3, 0);
      for (let i = 0; i < padBefore; i++) lines.push('');
      lines.push(' '.repeat(Math.max(Math.floor((termWidth - title.length) / 2), 0)) + bc + title + rst);
      lines.push('');
      lines.push(' '.repeat(Math.max(Math.floor((termWidth - label.length) / 2), 0)) + d + label + rst);
      for (let i = 0; i < padAfter; i++) lines.push('');
    } else {
      // Header
      lines.push(`  ${bc}Logs${rst} ${d}(${logCount} received)${rst}`);
      lines.push('');

      // Pending placeholder (in-flight or failed) is always the most
      // recent call, so it renders at the top with its hint.
      if (pendingEntry) {
        if (pendingEntry.state === 'pending') {
          const frame = SPINNER_FRAMES[spinFrame % SPINNER_FRAMES.length];
          lines.push(formatLogRow({
            icon: `${d}${frame}${rst}`,
            status: `${d}···${rst}`,
            method: pendingEntry.method,
            url: pendingEntry.url,
            trail: `${d}in flight…${rst}`,
            dim: true,
          }));
        } else {
          renderFailedRow(lines, pendingEntry, { includeHint: true });
        }
      }

      // Interleave failed attempts and real logs by event sequence so
      // a successful call after a broken one shows up ABOVE the broken
      // row, not below it. Only the most-recent entry (if it's a failed
      // attempt and there's no pending row above) gets the 2-line hint.
      const timeline = [
        ...failedAttempts.map((e) => ({ kind: 'failed', entry: e, seq: e._seq ?? 0 })),
        ...logs.map((e) => ({ kind: 'log', entry: e, seq: e._seq ?? 0 })),
      ].sort((a, b) => b.seq - a.seq);

      const used = lines.length;
      const visible = timeline.slice(0, Math.max(maxLogLines - used + 2, 0));
      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
        if (item.kind === 'failed') {
          // Hint only when this is the most recent thing overall: no
          // pending row above and it's at the top of the timeline.
          const includeHint = !pendingEntry && i === 0;
          renderFailedRow(lines, item.entry, { includeHint });
        } else {
          const log = item.entry;
          const dot = colorForStatus(log.status);
          lines.push(formatLogRow({
            icon: `${dot}●${rst}`,
            status: String(log.status).padStart(3),
            method: log.method,
            url: pathOnly(log.url),
            trail: log.duration != null ? `${d}${Math.round(log.duration)}ms${rst}` : '',
            statusColor: dot,
          }));
        }
      }

      // Pad remaining vertical space (reserve room for the hint block).
      const remaining = topHeight - lines.length - hintHeight;
      for (let i = 0; i < remaining; i++) lines.push('');
    }

    // Contextual hint always sits at the bottom of the top half, with a
    // blank spacer above so it doesn't crowd the log rows.
    lines.push('');
    for (const h of hint) lines.push(h);
    return lines;
  }

  // Render a "failed attempt" row: warning icon + diagnostic hint lines.
  // Used both for the active pending entry and for past attempts that
  // resolved to a diagnostic (so reruns build up a visible history).
  // `includeHint` is false for stale entries that have been superseded
  // by a newer call - we keep the row visible but drop the explainer.
  function renderFailedRow(lines, entry, { includeHint = true } = {}) {
    lines.push(formatLogRow({
      icon: `${yc}⚠${rst}`,
      status: `${d}---${rst}`,
      method: entry.method,
      url: entry.url,
    }));
    if (!includeHint) return;
    const hintList = entry.hint || [];
    for (let i = 0; i < hintList.length; i++) {
      const connector = i === 0 ? `${d}╰─${rst}` : '  ';
      lines.push(`  ${connector}     ${hintList[i]}`);
    }
  }

  // Pick the dot color from a response status code:
  //   2xx → green, 3xx → yellow, 4xx → orange, 5xx → red.
  function colorForStatus(status) {
    if (status >= 500) return rc;
    // Same truecolor orange as `orange()` - the palette index this used to
    // be came out muted on themed terminals.
    if (status >= 400) return '\x1b[38;2;255;158;66m';
    if (status >= 300) return yc;
    if (status >= 200) return gc;
    return d;
  }

  // Strip scheme://host from a URL so the row reads `GET /pets`,
  // matching the design. Falls back to the raw value if it doesn't
  // parse (relative URL, weird input, etc).
  function pathOnly(url) {
    try {
      const u = new URL(url);
      return u.pathname + (u.search || '');
    } catch {
      return url;
    }
  }

  // Layout: `  ●  STAT  METHOD   /url    trail`
  //   - icon: 1 visible char (already wrapped in ANSI color)
  //   - status: 3 chars (status code or '---' for pending/failed)
  //   - method: padded to 6
  //   - url: truncated to fit the row
  //   - trail: optional right-side text (duration, "in flight…")
  function formatLogRow({ icon, status, method, url, trail = '', dim = false, statusColor }) {
    const colorOpen = dim ? d : '';
    const colorClose = dim ? rst : '';
    const statusPart = statusColor ? `${statusColor}${status}${rst}` : `${colorOpen}${status}${colorClose}`;
    const methodPart = `${colorOpen}${method.padEnd(6)}${colorClose}`;
    // Compute available URL width: ~12 chars chrome on the left
    // (icon + spaces + status + method) plus the trail on the right.
    const trailVisible = trail.replace(/\x1b\[[0-9;]*m/g, '');
    const urlMax = Math.max(10, termWidth - 16 - trailVisible.length);
    const urlText = url.length > urlMax ? url.substring(0, urlMax - 1) + '…' : url;
    const urlPart = `${colorOpen}${urlText}${colorClose}`;
    return `  ${icon}  ${statusPart}  ${methodPart} ${urlPart}${trail ? '  ' + trail : ''}`;
  }

  function buildScreen(text, cp, output, phase) {
    const lines = buildTopHalf(text);

    // ── Bottom half: terminal box ──
    const dashes = Math.max(boxWidth - 11, 1);
    lines.push(`  ${d}╭── ${rst}${rc}●${rst} ${yc}●${rst} ${gc}●${rst}${d} ${'─'.repeat(dashes)}╮${rst}`);

    // Command line
    let visible = text;
    let visCursor = cp !== undefined ? cp : text.length;
    if (text.length > cmdSpace) {
      const start = Math.max(0, visCursor - cmdSpace + 5);
      visible = text.substring(start, start + cmdSpace);
      visCursor = (cp !== undefined ? cp : text.length) - start;
    }
    const cmdPad = Math.max(0, cmdSpace - visible.length);
    lines.push(`  ${d}│${rst}  ${d}$${rst} ${visible}${' '.repeat(cmdPad)} ${d}│${rst}`);

    // Output area
    if (output && output.length > 0 && !(output.length === 1 && output[0] === '')) {
      lines.push(`  ${d}│${'─'.repeat(boxWidth - 2)}│${rst}`);
      let outputToShow = output.slice(0, maxOutputLines);
      if (output.length > maxOutputLines) {
        outputToShow = output.slice(0, maxOutputLines - 1);
        outputToShow.push(`${d}… ${output.length - maxOutputLines + 1} more lines${rst}`);
      }
      for (const ol of outputToShow) {
        const clean = ol.replace(/\t/g, '  ');
        const truncated = clean.substring(0, boxWidth - 4);
        const olPad = Math.max(0, boxWidth - 4 - truncated.length);
        lines.push(`  ${d}│${rst} ${truncated}${' '.repeat(olPad)} ${d}│${rst}`);
      }
      const remaining = Math.max(0, maxOutputLines - outputToShow.length);
      for (let i = 0; i < remaining; i++) {
        lines.push(`  ${d}│${rst}${' '.repeat(boxWidth - 2)}${d}│${rst}`);
      }
    } else {
      const emptyCount = maxOutputLines + 1;
      for (let i = 0; i < emptyCount; i++) {
        lines.push(`  ${d}│${rst}${' '.repeat(boxWidth - 2)}${d}│${rst}`);
      }
    }

    lines.push(`  ${d}╰${'─'.repeat(boxWidth - 2)}╯${rst}`);

    if (phase === 'running') {
      lines.push(`  ${d}running...${rst}`);
    }
    // 'edit' and 'confirm-skip' carry their own messaging in the top
    // half (contextual hint / confirmation banner). No extra hint here.

    return { allLines: lines, visCursor };
  }

  function drawScreen(text, cp, output, phase) {
    lastDrawArgs = [text, cp, output, phase];
    const { allLines, visCursor } = buildScreen(text, cp, output, phase);
    stdout.write('\x1b[?25l\x1b[H\x1b[J');
    stdout.write(allLines.join('\n'));

    if (phase === 'edit') {
      const cmdRow = topHeight + 2;
      stdout.write(`\x1b[${cmdRow};${8 + visCursor}H`);
      stdout.write('\x1b[?25h');
    }
  }

  let command = defaultCommand;
  let isFirstRun = true;
  // The most recent run's output, kept around so the next edit-mode draw
  // can show it above the box (instead of wiping it on each redraw).
  let lastOutput = null;

  // Outer loop: each iteration is an edit → run cycle. The user always
  // ends up back in edit mode after a run - cursor stays in the box,
  // they can keep typing or press Enter to fire again. Tab exits.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // ── Typing animation (first run only) ──
    if (isFirstRun) {
      drawScreen('', 0, null, 'edit');

      let skipTyping = false;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      const skipHandler = (key) => {
        if (isAbortKey(key)) { cleanup(); debug.abortExit(0); return; }
        skipTyping = true;
      };
      stdin.on('data', skipHandler);

      for (let i = 0; i < command.length && !skipTyping; i++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        drawScreen(command.substring(0, i + 1), i + 1, null, 'edit');
      }

      stdin.removeListener('data', skipHandler);
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
    }

    // ── Interactive editing ──
    // The cursor stays in the edit box across reruns so the user can
    // tweak the command and press Enter again without an extra "edit"
    // keystroke. Tab leaves the screen entirely (with a confirm-skip
    // dance when polling and no successful run yet).
    drawScreen(command, command.length, lastOutput, 'edit');

    const editAction = await new Promise((resolve) => {
      let buffer = command;
      let cursor = buffer.length;
      let confirmingSkip = false; // Tab pressed once with no successful run

      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');

      function onKey(key) {
        // Confirm-skip: a Tab is pending. Another Tab confirms; anything
        // else (Enter, edits) cancels and goes back to normal edit mode.
        if (confirmingSkip) {
          if (key === '\t') {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeAllListeners('data');
            resolve({ buffer, action: 'continue' });
            return;
          }
          if (isAbortKey(key)) { cleanup(); debug.abortExit(0); return; }
          // Anything else - cancel the confirmation, redraw normal edit.
          confirmingSkip = false;
          drawScreen(buffer, cursor, lastOutput, 'edit');
          return;
        }

        if (key === '\r' || key === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          resolve({ buffer, action: 'run' });
          return;
        }
        if (key === '\t') {
          if (pollConfig && !hasSuccessfulRun) {
            confirmingSkip = true;
            drawScreen(buffer, cursor, [
              '',
              `  ${yc}Are you sure you want to proceed before confirming the SDK picked up a request?${rst}`,
              `  ${d}Press ${rst}${bc}Tab${rst}${d} again to continue anyway, or any other key to keep editing.${rst}`,
            ], 'confirm-skip');
            return;
          }
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeAllListeners('data');
          resolve({ buffer, action: 'continue' });
          return;
        }
        if (key === '\x7f' || key === '\b') {
          if (cursor > 0) {
            buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
            cursor--;
            drawScreen(buffer, cursor, lastOutput, 'edit');
          }
          return;
        }
        if (key === '\x1b[D') {
          if (cursor > 0) { cursor--; drawScreen(buffer, cursor, lastOutput, 'edit'); }
          return;
        }
        if (key === '\x1b[C') {
          if (cursor < buffer.length) { cursor++; drawScreen(buffer, cursor, lastOutput, 'edit'); }
          return;
        }
        if (key === '\x01') {
          cursor = 0; drawScreen(buffer, cursor, lastOutput, 'edit');
          return;
        }
        if (key === '\x05') {
          cursor = buffer.length; drawScreen(buffer, cursor, lastOutput, 'edit');
          return;
        }
        if (isAbortKey(key)) { cleanup(); debug.abortExit(0); return; }
        if (key.length > 0 && !key.startsWith('\x1b') && key.charCodeAt(0) >= 32) {
          for (const ch of key) {
            if (ch.charCodeAt(0) >= 32) {
              buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
              cursor++;
            }
          }
          drawScreen(buffer, cursor, lastOutput, 'edit');
        }
      }

      stdin.on('data', onKey);
    });

    command = editAction.buffer;
    if (editAction.action === 'continue') {
      cleanup();
      return { command, logCount, ...(lastOutput ? { output: lastOutput.join('\n'), success: true } : { output: '', success: true }) };
    }

    // ── Run the command ──
    drawScreen(command, command.length, null, 'running');

    // New run - clear any stale state from the previous attempt. If the
    // previous run ended in a failed diagnostic, archive it so reruns
    // leave a visible trail in the log panel instead of wiping it.
    if (pendingEntry && pendingEntry.state === 'failed') {
      pendingEntry._seq = eventSeq++;
      failedAttempts.unshift(pendingEntry);
    }
    pendingEntry = null;
    stopSpin();
    clearHintTimer();

    let result = { output: '', success: true };
    if (onRun) {
      result = onRun(command);
    }

    // onRun can return a `command` field to rewrite what we display -
    // useful when the run handler had to patch the command (adding a
    // missing required flag, for instance) and wants the user to see
    // exactly what was executed.
    if (typeof result.command === 'string') {
      command = result.command;
    }

    // Stand up the in-flight placeholder as soon as the run finishes,
    // so the user sees their request appear up top with a spinner
    // before any polling round-trip. `pending` from onRun carries the
    // method + url; `immediateHint` is set when onRun already knows
    // logs won't be coming (e.g. SDK didn't run on this request).
    if (result.success && result.pending) {
      pendingEntry = {
        method: result.pending.method || 'GET',
        url: result.pending.url || '',
        state: result.immediateHint ? 'failed' : 'pending',
        hint: result.immediateHint
          ? (Array.isArray(result.immediateHint) ? result.immediateHint : [String(result.immediateHint)])
          : null,
        setAtCount: logCount,
      };
      if (pendingEntry.state === 'pending') startSpin();
    }

    const outputArr = (result.output || '').trim().split('\n');

    // Track successful runs and start polling
    if (result.success) hasSuccessfulRun = true;
    if (result.success && pollConfig) {
      startPolling();
      if (pendingEntry && pendingEntry.state === 'pending') startNoLogsHintTimer();
    }

    // Stash the output so the next edit-mode draw shows it above the box.
    // We don't call drawScreen here; the top of the loop will redraw in
    // 'edit' phase with `lastOutput` so the cursor lands back in the box.
    lastOutput = outputArr;
    isFirstRun = false;
  }
}
