import path from 'path';
import { spawnSync, execFileSync } from 'child_process';

import { bold, dim, green, red, cyan, yellow, singleSelect, askYesNo, startSpinner } from '../lib/ui.js';
import { runAI, loadPrompt, setProvider } from '../lib/ai.js';
import { CLI_NAME } from '../lib/config.js';
import { flagValue } from '../lib/args.js';
import { findGitRoot } from '../lib/project.js';
import { isInteractive, isAgent, detectAgent, agentLabel } from '../lib/env.js';
import { claudeSignedOut } from '../lib/claude-auth.js';
import { signIn, pickProject, clearAccountToken, reportSignInFailure } from '../lib/context-auth.js';
import {
  CORE_PACKAGE,
  OCLIF_PACKAGE,
  describeCli,
  detectNonNodeCli,
  detectPackageManager,
  feedbackStatus,
  findCliPackages,
  installArgs,
  packageSpecs,
} from '../lib/cli-target.js';
import * as debug from '../lib/debug.js';
import * as telemetry from '../lib/telemetry.js';

/**
 * `restless init cli`: add a `feedback` command to the user's own CLI, so
 * its users can tell the API's maintainers what confused them. oclif CLIs get
 * the plugin; anything else in Node gets the core package wired in by the AI.
 */

const LANGUAGE_NAMES = { go: 'Go', python: 'Python', rust: 'Rust', ruby: 'Ruby' };

/** True when the second word selects this command: `init cli`, `setup cli`, `supercharge cli`. */
export function isInitCli(argv) {
  return ['init', 'setup', 'supercharge'].includes(argv[2]) && argv[3] === 'cli';
}

export function parseInitCliArgs(argv) {
  return {
    project: flagValue(argv, '--project') || '',
    dir: flagValue(argv, '--dir') || '',
    selfDrive: argv.includes('--self-drive'),
    yes: argv.includes('--yes') || argv.includes('-y'),
  };
}

function cliLabel(cli, rootDir) {
  const notes = [path.relative(rootDir, cli.dir), cli.oclif ? 'oclif' : ''].filter(Boolean);
  return notes.length ? `${cli.name} ${dim(`(${notes.join(', ')})`)}` : cli.name;
}

/** The prompt for this CLI, also used verbatim as the coding-agent handoff. */
export function buildSetupPrompt({ cli, project, installNote }) {
  const vars = {
    cliName: cli.name,
    cliDir: cli.dir,
    bin: cli.bins[0],
    project,
    corePackage: CORE_PACKAGE,
    oclifPackage: OCLIF_PACKAGE,
    installNote,
  };
  return loadPrompt(cli.oclif ? 'setup-cli-feedback-oclif' : 'setup-cli-feedback', vars);
}

export function installCommandText(manager, specs) {
  const [cmd, args] = installArgs(manager, specs);
  return [cmd, ...args].join(' ');
}

/** A snapshot of `git status --porcelain` lines, or null if git fails. `changedFiles` diffs two. */
function gitStatus(rootDir) {
  try {
    return new Set(
      execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: rootDir, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}

function changedFiles(before, after) {
  if (!before || !after) return [];
  return [...after].filter((line) => !before.has(line)).map((line) => line.slice(3));
}

function fail(code, headline, details = []) {
  telemetry.recordError(code);
  console.log('');
  console.log(red(`  ✗ ${headline}`));
  for (const line of details) console.log(dim(`    ${line}`));
  console.log('');
  return 1;
}

async function chooseCli(argv, cwd) {
  const args = parseInitCliArgs(argv);
  const startDir = args.dir ? path.resolve(cwd, args.dir) : cwd;
  const rootDir = findGitRoot(startDir) || startDir;
  const clis = findCliPackages(startDir, rootDir);

  if (clis.length === 0) {
    const other = detectNonNodeCli([startDir, rootDir]);
    if (other) {
      return {
        exit: fail('unsupported-stack', `${CLI_NAME} init cli only sets up Node CLIs so far.`, [
          `This looks like a ${LANGUAGE_NAMES[other.language] || other.language} CLI (${other.evidence}).`,
          'Support for other languages is coming. Nothing was changed.',
        ]),
      };
    }
    return {
      exit: fail('unsupported-stack', 'No CLI found here.', [
        `Looked for a package.json with a "bin" entry under ${startDir}.`,
        `Run this from your CLI's directory, or pass --dir <path>.`,
      ]),
    };
  }

  if (clis.length === 1) return { cli: clis[0], rootDir };

  if (!isInteractive()) {
    return {
      exit: fail('unknown', `Found ${clis.length} CLIs here. Say which one with --dir <path>:`,
        clis.map((c) => `${path.relative(rootDir, c.dir)}  (${c.name})`)),
    };
  }
  const idx = await singleSelect(
    clis.map((c) => ({ label: c.name, hint: dim(path.relative(rootDir, c.dir) + (c.oclif ? ', oclif' : '')) })),
    { message: 'Which CLI should get the feedback command?', defaultIndex: 0 },
  );
  return { cli: clis[idx], rootDir };
}

async function chooseProject(argv, cli, status) {
  const args = parseInitCliArgs(argv);
  // An agent runs on the user's own machine, so they can still open the printed link; only CI can't.
  const signInOpts = { interactive: isInteractive(), linkOnly: isAgent() && !process.env.CI };
  const preferredId = args.project || status.project;
  const pick = (token) => pickProject({
    token,
    preferredId,
    requirePreferred: !!args.project,
    interactive: isInteractive(),
    message: `Which project should ${cli.name}'s feedback go to?`,
  });

  const session = await signIn(signInOpts);
  if (!session.ok) {
    reportSignInFailure(session, { retry: 'init cli' });
    telemetry.recordError('account-claim-failed');
    return null;
  }
  let picked = await pick(session.token);
  if (!picked.ok && picked.expired && session.cached) {
    clearAccountToken();
    const fresh = await signIn(signInOpts);
    if (!fresh.ok) {
      reportSignInFailure(fresh, { retry: 'init cli' });
      telemetry.recordError('account-claim-failed');
      return null;
    }
    picked = await pick(fresh.token);
  }

  if (!picked.ok) {
    console.log('');
    console.log(red(`  ✗ ${picked.error}`));
    if (picked.projects?.length) {
      console.log('');
      console.log(dim('  Projects on your account:'));
      for (const p of picked.projects) console.log(`    ${dim('•')} ${p.slug || p.projectId} ${dim(`(${p.name || p.slug})`)}`);
      console.log('');
      console.log(dim(`  Re-run with ${cyan(`npx ${CLI_NAME} init cli --project <slug>`)}${'\x1b[2m'}.`));
    }
    console.log('');
    telemetry.recordError('unknown');
    return null;
  }
  if (!picked.project.slug) {
    fail('unknown', `Project ${picked.project.projectId} has no slug yet.`, ['Open it in the dashboard once, then re-run this.']);
    return null;
  }
  return picked.project;
}

/** Await `promise`, showing a spinner only if it is still running after a moment. */
async function settleWithSpinner(promise, message) {
  const quick = await Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), 150))]);
  if (quick) return promise;
  const spinner = startSpinner(message);
  try {
    return await promise;
  } finally {
    spinner.stop();
  }
}

async function chooseProvider({ hasClaude, hasCodex, hasCodexAuth }) {
  if (hasClaude() && !(await claudeSignedOut())) return { id: 'claude', label: 'Claude Code' };
  if (hasCodex() && hasCodexAuth()) return { id: 'codex', label: 'Codex' };
  return null;
}

/**
 * Run the command. `deps` carries the AI-tool probes that live in the
 * entry point, so they are not duplicated here. Resolves to an exit code.
 */
export async function runInitCli({ argv = process.argv, cwd = process.cwd(), deps }) {
  const args = parseInitCliArgs(argv);
  const chosen = await chooseCli(argv, cwd);
  if (chosen.exit !== undefined) return chosen.exit;
  const { cli, rootDir } = chosen;

  telemetry.recordDetect({ language: 'javascript', framework: cli.oclif ? 'oclif' : undefined });
  const status = feedbackStatus(cli);
  debug.log('init-cli.target', { oclif: cli.oclif, state: status.state, bins: cli.bins });

  console.log('');
  console.log(`  ${bold('Add a feedback command to')} ${cliLabel(cli, rootDir)}`);
  if (status.state === 'wired') {
    console.log('');
    console.log(green(`  ✓ ${cli.bins[0]} already has a feedback command${status.project ? ` (project ${status.project})` : ''}.`));
    console.log(dim(`    Try it: ${cli.bins[0]} feedback --message "..."`));
    console.log('');
    return 0;
  }

  // The Claude probe takes seconds, so it runs while the person signs in and picks, as `init` does.
  const handOff = isAgent() && !args.selfDrive;
  const providerProbe = handOff ? null : chooseProvider(deps);
  const project = await chooseProject(argv, cli, status);
  if (!project) return 1;

  const manager = detectPackageManager(cli.dir, rootDir);
  let specs;
  try {
    specs = packageSpecs(cli.oclif);
  } catch (err) {
    return fail('sdk-install-failed', err.message);
  }
  const installText = installCommandText(manager, specs);

  // ── Driven by a coding agent: hand over the steps, as `init` does ──────
  if (handOff) {
    const installNote = `### 0. Install the package\n\nIn \`${cli.dir}\`, run:\n\n\`\`\`sh\n${installText}\n\`\`\``;
    console.log('');
    console.log(`# Add a \`feedback\` command to ${cli.name}, for ${agentLabel(detectAgent())}`);
    console.log('');
    console.log(`Do these steps yourself, in the open, so the user sees every change. Project: \`${project.slug}\`.`);
    console.log('');
    console.log(buildSetupPrompt({ cli, project: project.slug, installNote }));
    debug.log('init-cli.agent-handoff', { oclif: cli.oclif });
    return 0;
  }

  const provider = await settleWithSpinner(providerProbe, 'Checking for Claude Code or Codex');
  if (!provider) {
    return fail('agent-unavailable', 'This needs Claude Code or Codex, signed in.', [
      'Install one: npm install -g @anthropic-ai/claude-code (then run claude and /login),',
      'or npm install -g @openai/codex (then codex login).',
      `Then re-run npx ${CLI_NAME} init cli.`,
    ]);
  }
  setProvider(provider.id);

  console.log('');
  console.log(`  ${dim('Project')} ${cyan(project.name || project.slug)}${project.name && project.name !== project.slug ? dim(` (${project.slug})`) : ''}`);
  console.log(`  ${dim('Will:')}`);
  console.log(`    ${dim('·')} run ${cyan(installText)}`);
  console.log(cli.oclif
    ? `    ${dim('·')} have ${provider.label} register the plugin in package.json`
    : `    ${dim('·')} have ${provider.label} add a feedback command that matches your CLI's others`);
  console.log(`    ${dim('·')} leave the changes uncommitted for you to review`);
  console.log('');
  if (!args.yes && !(await askYesNo(`  Continue? ${dim('(Y/n)')} `, { defaultValue: true }))) {
    console.log(dim('  Nothing was changed.'));
    console.log('');
    return 0;
  }

  const before = gitStatus(rootDir);
  const [cmd, cmdArgs] = installArgs(manager, specs);
  const installSpinner = startSpinner(`Installing ${cli.oclif ? OCLIF_PACKAGE : CORE_PACKAGE}`);
  const installed = spawnSync(cmd, cmdArgs, { cwd: cli.dir, encoding: 'utf8', shell: process.platform === 'win32' });
  installSpinner.stop();
  if (installed.status !== 0) {
    const tail = `${installed.stderr || ''}${installed.error ? installed.error.message : ''}`.trim().split('\n').slice(-6);
    return fail('sdk-install-failed', `${installText} failed.`, tail);
  }
  console.log(green(`  ✓ Installed ${cli.oclif ? OCLIF_PACKAGE : CORE_PACKAGE}`));

  const prompt = buildSetupPrompt({
    cli,
    project: project.slug,
    installNote: `\`${installText}\` has already been run in \`${cli.dir}\`. Don't install anything else.`,
  });
  let summary = '';
  try {
    summary = (await runAI(prompt, cli.dir, { label: 'setup-cli-feedback', maxTurns: 40 })) || '';
  } catch (err) {
    debug.log('init-cli.ai-error', { message: err?.message });
    return fail('sdk-wiring-failed', `${provider.label} couldn't finish adding the command.`, [
      'The package is installed; re-run this to try the wiring again.',
    ]);
  }

  const after = describeCli(cli.dir) || cli;
  const result = feedbackStatus(after);
  const changed = changedFiles(before, gitStatus(rootDir));
  console.log('');
  if (result.state === 'wired') {
    console.log(green(`  ✓ ${cli.bins[0]} has a feedback command.`));
  } else {
    telemetry.recordError('sdk-wiring-failed');
    console.log(yellow(`  ! ${provider.label} finished, but the command doesn't look fully wired up yet.`));
    const last = summary.trim().split('\n').filter(Boolean).slice(-3);
    for (const line of last) console.log(dim(`    ${line}`));
  }
  if (changed.length) {
    console.log('');
    console.log(dim('  Changed:'));
    for (const f of changed) console.log(`    ${dim('·')} ${f}`);
  }
  console.log('');
  console.log(`  ${dim('Try it:')} ${cyan(`${cli.bins[0]} feedback --message "testing the feedback command"`)}`);
  console.log(dim(`  Notes land in your dashboard under API Feedback.`));
  console.log('');
  return result.state === 'wired' ? 0 : 1;
}
