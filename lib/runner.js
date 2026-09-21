import { dim, bold, green, red, cyan, brand, white, planSpinner, renderLogoLine, LOGO_HEIGHT, LOGO_WIDTH } from './ui.js';
import * as debug from './debug.js';
import * as timings from './timings.js';
import * as telemetry from './telemetry.js';
import { isInteractive } from './env.js';

// `blurb` is the one-line gloss shown beside each step on the pre-selection
// screen. It sits on the same row as the label (not under it) so the whole
// plan is four lines: the welcome screen has to fit above the fold, and a
// 15-line plan pushed the question the user is meant to answer off-screen.
const STEPS = [
  {
    label: 'Map your API',
    blurb: 'your spec, or one we generate',
    children: ['Find your API', 'Get the spec', 'Write to .restless/'],
  },
  {
    label: 'Install SDK',
    blurb: 'add the SDK to your server',
    // `owner.id` verification is part of configuring the SDK, not a step of
    // its own: it's an AI pass over the block that was just written, and
    // giving it a top-level row made a five-row step out of four real ones.
    children: ['Install package', 'Generate API key', 'Configure SDK', 'Run final checks'],
  },
  {
    label: 'Test your setup',
    blurb: 'confirm we see a live request',
  },
  {
    label: 'Set up account',
    blurb: 'sign in and claim the project',
    children: ['Upload specs', 'Log in'],
  },
];

function getTermWidth() {
  try { return process.stdout.columns || 80; } catch { return 80; }
}

function rule() {
  return dim('─'.repeat(getTermWidth()));
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

function buildLines(statuses, subStatuses, activeSubs, activeStep, workingLines, spinnerFrame, spinnerPhase, spinnerDetail, spinnerStartTime, errorLines) {
  const lines = [];

  // Logo on the left, one step per row on the right. When a step is active
  // its sub-items "open up" indented underneath, pushing later steps down.
  // The logo column keeps printing line by line for as long as we have logo
  // rows; rows beyond the logo height get padded with spaces.
  let logoRow = 0;
  const logoCol = (n = 1) => {
    const out = [];
    for (let k = 0; k < n; k++) {
      out.push(logoRow < LOGO_HEIGHT ? renderLogoLine(logoRow) : ' '.repeat(LOGO_WIDTH));
      logoRow++;
    }
    return out;
  };

  for (let i = 0; i < STEPS.length; i++) {
    const s = STEPS[i];
    const status = statuses[i];
    let icon;
    let label;
    const numbered = `Step ${i + 1}: ${s.label}`;
    // Done: green tick and green "Step N:", but the title stays white. An
    // all-green row reads as one blob of colour, and by the end every row is
    // done - so the titles are what you're actually scanning.
    if (status === 'done') { icon = green('✓'); label = `${green(`Step ${i + 1}:`)} ${white(s.label)}`; }
    else if (status === 'failed') { icon = red('✗'); label = red(numbered); }
    else if (status === 'active') { icon = brand('❯'); label = bold(brand(numbered)); }
    // Pending steps stay dim so focus sits on the active step and its subs.
    else { icon = dim('○'); label = dim(numbered); }
    const [logo] = logoCol();
    lines.push(`  ${logo}    ${icon} ${label}`);

    // Sub-items "open" under the active step. Once the step finishes, fold
    // them away again so the final frame stays compact - the parent step's
    // green checkmark already implies the subs all succeeded.
    if (i === activeStep && s.children?.length && status !== 'done') {
      for (let j = 0; j < s.children.length; j++) {
        const subStatus = subStatuses[i]?.[j];
        const isActiveSub = activeSubs[i] === j && subStatus !== 'done' && subStatus !== 'failed';
        const subIcon = subStatus === 'done'
          ? green('✓')
          : subStatus === 'failed'
            ? red('✗')
            : isActiveSub
              ? (status === 'failed' ? red('❯') : brand('❯'))
              : white('○');
        const subLabel = subStatus === 'done'
          ? s.children[j]
          : subStatus === 'failed'
            ? red(s.children[j])
            : isActiveSub
              ? (status === 'failed' ? red(s.children[j]) : s.children[j])
              : white(s.children[j]);
        const [subRowLogo] = logoCol();
        lines.push(`  ${subRowLogo}      ${subIcon} ${subLabel}`);
      }
    }
  }

  // Below-the-plan area: always a rule under the steps panel, then the
  // working content (explanation), a blank separator, the running spinner
  // (high-level phase + elapsed), and a dim detail line under it.
  lines.push(rule());
  for (const l of workingLines) {
    lines.push(l);
  }
  if (spinnerPhase || spinnerDetail) {
    if (workingLines.length) lines.push('');
    const glyph = planSpinner(spinnerFrame);
    const elapsed = spinnerStartTime ? ` ${dim(`(${formatElapsed(Date.now() - spinnerStartTime)})`)}` : '';
    if (spinnerPhase) {
      lines.push(`  ${glyph} ${spinnerPhase}${elapsed}`);
    } else {
      lines.push(`  ${glyph} ${spinnerDetail}${elapsed}`);
    }
    if (spinnerPhase && spinnerDetail) {
      lines.push(`    ${dim(spinnerDetail)}`);
    }
  }

  // Error block lives at the bottom of the frame so a stale spinner tick
  // can never wipe it. Set by reportError via plan.setError().
  if (errorLines && errorLines.length) {
    lines.push('');
    for (const l of errorLines) lines.push(l);
  }

  return lines;
}

// Single active plan per process. The shared error reporter reaches into
// this so fatal exits can paint the active step red without having to
// thread the plan through every call site.
let activePlan = null;

export function getActivePlan() {
  return activePlan;
}

export function createPlanManager() {
  const statuses = new Array(STEPS.length).fill(null);
  const subStatuses = STEPS.map(() => ({}));
  const activeSubs = new Array(STEPS.length).fill(-1);
  let activeStep = -1;
  let spinnerFrame = 0;
  let spinnerPhase = '';
  let spinnerDetail = '';
  let spinnerInterval = null;
  let spinnerStartTime = 0;
  let lastMessage = [];
  let headerLines = []; // static lines above the plan (intro, etc.)
  let errorLines = []; // pinned error block from reportError - survives re-renders
  let pinned = false;

  // Non-interactive (agent / CI / pipe): the pinned, full-screen redraw model
  // is actively harmful - every render() clears the scrollback the agent is
  // trying to read, and the 180ms spinner tick spams duplicate frames. In
  // that mode we render nothing live and instead print each meaningful
  // transition (step intros, done messages, spinner phases, errors) as
  // append-only text via `emit()`.
  const interactive = isInteractive();
  let lastEmittedPhase = '';
  function emit(lines) {
    const arr = Array.isArray(lines) ? lines : [lines];
    if (arr.length) console.log(arr.join('\n'));
  }

  function render() {
    // Non-interactive: never take over the screen. Meaningful output is
    // printed append-only from the updaters below.
    if (!interactive) return;
    // Hide cursor, jump to top-left, clear screen, draw everything, show cursor
    // This prevents the flash between clear and redraw
    const header = headerLines.length ? headerLines.join('\n') + '\n' : '';
    const lines = buildLines(statuses, subStatuses, activeSubs, activeStep, lastMessage, spinnerFrame, spinnerPhase, spinnerDetail, spinnerStartTime, errorLines);
    const frame = header + lines.join('\n') + '\n';
    process.stdout.write('\x1b[?25l\x1b[H\x1b[J' + frame + '\x1b[?25h');
  }

  function drawInitial() {
    // Pre-selection view: the same logo-left / steps-right frame the run uses,
    // so pressing enter doesn't relayout the screen - the plan is already
    // where it will live. Two differences: every step is bright (nothing has
    // started, so nothing is "pending yet"), and each carries a dim gloss the
    // running view drops once the labels have to compete with sub-steps.
    const labels = STEPS.map((s, i) => `Step ${i + 1}: ${s.label}`);
    const width = Math.max(...labels.map((l) => l.length));
    // indent + logo + gutter + glyph + label + gap before the gloss.
    const room = getTermWidth() - (2 + LOGO_WIDTH + 4 + 2 + width + 3);
    // All or nothing: dropping only the glosses that don't fit leaves a
    // ragged column that reads as missing text rather than a narrow window.
    const longest = Math.max(...STEPS.map((s) => (s.blurb || '').length));
    const showBlurbs = room >= longest;
    const lines = [];
    for (let i = 0; i < STEPS.length; i++) {
      const logo = i < LOGO_HEIGHT ? renderLogoLine(i) : ' '.repeat(LOGO_WIDTH);
      let row = `  ${logo}    ${white('○')} ${bold(labels[i].padEnd(width))}`;
      if (showBlurbs && STEPS[i].blurb) row += `   ${dim(STEPS[i].blurb)}`;
      lines.push(row);
    }
    // Any logo rows the step list didn't reach still get drawn.
    for (let r = STEPS.length; r < LOGO_HEIGHT; r++) lines.push(`  ${renderLogoLine(r)}`);
    // Same rule the running frame draws under the plan, so this screen and
    // every screen after it split "the plan" from "the current thing" the
    // same way.
    lines.push(rule());
    process.stdout.write(lines.join('\n') + '\n');
  }

  function pin() {
    // Capture everything currently on screen as the header.
    // We'll grab the terminal content by just storing what we want to keep.
    pinned = true;
  }

  function setHeader(lines) {
    headerLines = lines;
  }

  function startTicking() {
    // No animated spinner without a TTY - it would just emit duplicate frames.
    if (!interactive) return;
    if (spinnerInterval) return;
    spinnerInterval = setInterval(() => {
      spinnerFrame++;
      if (pinned) render();
    }, 180);
  }

  function stopTicking() {
    if (spinnerInterval) {
      clearInterval(spinnerInterval);
      spinnerInterval = null;
    }
  }

  /**
   * Accepts either a plain string (treated as the high-level phase) or an
   * object { phase, detail } where:
   *   - phase: high-level human description (first line, not dimmed)
   *   - detail: literal tool call or fine-grained status (second line, dimmed)
   *
   * Pass an empty string / empty object to clear the spinner.
   */
  function setSpinner(info) {
    const flatten = (s) => (s || '').replace(/\s*\n+\s*/g, ' ');
    const wasActive = !!(spinnerPhase || spinnerDetail);
    const prevPhase = spinnerPhase;
    if (typeof info === 'string') {
      spinnerPhase = flatten(info);
      spinnerDetail = '';
    } else if (info && typeof info === 'object') {
      spinnerPhase = flatten(info.phase);
      spinnerDetail = flatten(info.detail);
    } else {
      spinnerPhase = '';
      spinnerDetail = '';
    }
    const isActive = !!(spinnerPhase || spinnerDetail);
    // Restart the clock on a new PHASE, not just when the spinner turns on.
    // Phases are often set back to back without the spinner ever clearing
    // (npm install → registering project), and keeping the original start
    // time made the elapsed mean "time since the spinner first appeared" -
    // so a 0.6s POST displayed as "(28s)", inheriting the install's clock.
    // Detail churns per tool call, so it deliberately doesn't reset.
    if (isActive && (!wasActive || spinnerPhase !== prevPhase)) spinnerStartTime = Date.now();
    if (!isActive) spinnerStartTime = 0;
    if (!interactive) {
      // Print the high-level phase once each time it changes, so the agent
      // gets a progress trail without the per-tick spinner spam.
      if (spinnerPhase && spinnerPhase !== lastEmittedPhase) {
        lastEmittedPhase = spinnerPhase;
        emit(`  ${dim('◦')} ${dim(spinnerPhase)}`);
      }
      return;
    }
    if (isActive) {
      startTicking();
    } else {
      stopTicking();
      if (pinned) render();
    }
  }

  // Per-step start timestamps so step.end events carry a duration.
  const stepStartedAt = new Array(STEPS.length).fill(0);

  // Timing spans mirroring the plan the user is looking at, so the report
  // in `lib/timings-report.js` can attribute an AI turn or a package
  // install to the row it happened under. Steps and sub-items are
  // containers: their *self* time is whatever the step spent outside any
  // instrumented operation, which is how the report knows where
  // instrumentation is still missing.
  //
  // Closers are held here rather than in the updater closure because
  // `makeUpdater` is called more than once for the same step index (see
  // the verifyOwnerId / finalChecks calls in bin/restless.js), so each
  // updater would otherwise track its own private, incomplete idea of
  // which sub-item is open.
  const endStepSpan = new Array(STEPS.length).fill(null);
  const endSubSpan = new Array(STEPS.length).fill(null);
  const openSubIndex = new Array(STEPS.length).fill(-1);

  function closeSubSpan(stepIndex) {
    if (endSubSpan[stepIndex]) {
      endSubSpan[stepIndex]();
      endSubSpan[stepIndex] = null;
    }
    openSubIndex[stepIndex] = -1;
  }

  function closeStepSpan(stepIndex) {
    closeSubSpan(stepIndex);
    if (endStepSpan[stepIndex]) {
      endStepSpan[stepIndex]();
      endStepSpan[stepIndex] = null;
    }
  }

  function makeUpdater(stepIndex) {
    return function update({ status, sub, activeSub, message }) {
      if (status === 'active' && activeStep !== stepIndex) {
        activeStep = stepIndex;
        statuses[stepIndex] = 'active';
        for (let i = 0; i < STEPS.length; i++) {
          if (i !== stepIndex && statuses[i] !== 'done') {
            statuses[i] = 'pending';
          }
        }
        stepStartedAt[stepIndex] = Date.now();
        // Steps run strictly in order, so anything still open on the step
        // we're leaving ended when this one began.
        for (let i = 0; i < STEPS.length; i++) if (i !== stepIndex) closeStepSpan(i);
        endStepSpan[stepIndex] = timings.start(STEPS[stepIndex].label, {
          kind: timings.KINDS.STEP,
          index: stepIndex,
        });
        debug.log('step.start', { index: stepIndex, label: STEPS[stepIndex].label });
        telemetry.recordStep(stepIndex, 'started', 0);
      }

      if (status === 'done') {
        statuses[stepIndex] = 'done';
        activeSubs[stepIndex] = -1;
        stopTicking();
        spinnerPhase = '';
        spinnerDetail = '';
        spinnerStartTime = 0;
        const startedAt = stepStartedAt[stepIndex] || 0;
        closeStepSpan(stepIndex);
        const doneMs = startedAt ? Date.now() - startedAt : null;
        debug.log('step.done', {
          index: stepIndex,
          label: STEPS[stepIndex].label,
          durationMs: doneMs,
        });
        // The step lifecycle already lives here, so telemetry hooks it here
        // too rather than being threaded through every module in `steps/`.
        // It takes the INDEX, not the label: labels are user-facing copy and
        // change with the UI, and `lib/telemetry.js` maps the index onto the
        // dashboard's own step vocabulary.
        telemetry.recordStep(stepIndex, 'done', doneMs);
      }

      if (status === 'failed') {
        statuses[stepIndex] = 'failed';
        // Mark the currently active sub as failed too, if any.
        const sub = activeSubs[stepIndex];
        if (sub >= 0 && subStatuses[stepIndex][sub] !== 'done') {
          subStatuses[stepIndex][sub] = 'failed';
        }
        stopTicking();
        spinnerPhase = '';
        spinnerDetail = '';
        spinnerStartTime = 0;
        const startedAt = stepStartedAt[stepIndex] || 0;
        closeStepSpan(stepIndex);
        const failedMs = startedAt ? Date.now() - startedAt : null;
        debug.log('step.failed', {
          index: stepIndex,
          label: STEPS[stepIndex].label,
          durationMs: failedMs,
        });
        telemetry.recordStep(stepIndex, 'failed', failedMs);
      }

      if (activeSub !== undefined) {
        activeSubs[stepIndex] = activeSub;
        // Re-asserting the same sub-item (several call sites do, to redraw a
        // message) must not restart its clock.
        if (activeSub !== openSubIndex[stepIndex]) {
          closeSubSpan(stepIndex);
          const child = STEPS[stepIndex].children?.[activeSub];
          if (child) {
            openSubIndex[stepIndex] = activeSub;
            endSubSpan[stepIndex] = timings.start(child, {
              kind: timings.KINDS.SUBSTEP,
              step: STEPS[stepIndex].label,
            });
          }
        }
      }

      if (sub) {
        for (const [key, val] of Object.entries(sub)) {
          // Only log transitions into terminal states, and only when
          // the value is actually changing - re-asserting "done" on a
          // sub that's already done would just spam the log.
          if ((val === 'done' || val === 'failed') && subStatuses[stepIndex][key] !== val) {
            const child = STEPS[stepIndex].children?.[key];
            if (child) debug.log(`substep.${val}`, { step: STEPS[stepIndex].label, sub: child });
          }
          subStatuses[stepIndex][key] = val;
        }
      }

      if (message !== undefined) {
        lastMessage = message;
        // Non-interactive: the message block (step intros from startStep,
        // per-step done messages, etc.) is the payload the agent needs.
        // Print it append-only since render() is a no-op here.
        if (!interactive) emit(message);
      }

      if (pinned) render();
    };
  }

  /**
   * Mark whichever step is currently active as failed. Used by the shared
   * error handler (`lib/errors.js`) so every fatal exit paints the step
   * red without every call site having to remember to do it.
   */
  function markActiveFailed() {
    if (activeStep < 0) return;
    closeStepSpan(activeStep);
    const sub = activeSubs[activeStep];
    statuses[activeStep] = 'failed';
    if (sub >= 0 && subStatuses[activeStep][sub] !== 'done') {
      subStatuses[activeStep][sub] = 'failed';
    }
    stopTicking();
    spinnerPhase = '';
    spinnerDetail = '';
    spinnerStartTime = 0;
    if (pinned) render();
  }

  /**
   * Pin an error block at the bottom of the frame. Survives any subsequent
   * re-renders so a late spinner tick or message update can never wipe it.
   * Call once per fatal failure - `reportError` does this automatically.
   */
  function setError(lines) {
    errorLines = Array.isArray(lines) ? lines : [];
    if (!interactive) { emit(errorLines); return; }
    if (pinned) render();
  }

  /**
   * Which step is running right now, or null between steps. Exposed for the
   * shared error handler, which reports the step a failure died in without
   * every raise site having to pass it along - the same reasoning as
   * `markActiveFailed` above.
   */
  function activeStepIndex() {
    return activeStep >= 0 ? activeStep : null;
  }

  const plan = {
    drawInitial, pin, setHeader, makeUpdater, setSpinner,
    markActiveFailed, setError, activeStepIndex,
  };
  activePlan = plan;
  return plan;
}
