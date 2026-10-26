import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { buildSetupPrompt, installCommandText, isInitCli, parseInitCliArgs } from '../steps/init-cli.js';
import { CORE_PACKAGE, OCLIF_PACKAGE } from '../lib/cli-target.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'restless.js');
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('argument handling', () => {
  it('selects init cli from any init alias', () => {
    expect(isInitCli(['node', 'restless', 'init', 'cli'])).toBe(true);
    expect(isInitCli(['node', 'restless', 'setup', 'cli', '--yes'])).toBe(true);
    expect(isInitCli(['node', 'restless', 'init'])).toBe(false);
    expect(isInitCli(['node', 'restless', 'init', '--dir', 'cli'])).toBe(false);
  });

  it('reads its flags', () => {
    expect(parseInitCliArgs(['node', 'r', 'init', 'cli', '--project', 'pets', '--dir', 'packages/cli', '-y'])).toEqual({
      project: 'pets',
      dir: 'packages/cli',
      selfDrive: false,
      yes: true,
    });
  });

  it('spells the install command per package manager', () => {
    expect(installCommandText('npm', [OCLIF_PACKAGE])).toBe(`npm install ${OCLIF_PACKAGE}`);
    expect(installCommandText('pnpm', [CORE_PACKAGE])).toBe(`pnpm add ${CORE_PACKAGE}`);
  });
});

describe('buildSetupPrompt', () => {
  const cli = (oclif) => ({ name: 'petcli', dir: '/repo/cli', bins: ['pets'], oclif });

  it('fills every placeholder on both paths', () => {
    for (const oclif of [true, false]) {
      const prompt = buildSetupPrompt({ cli: cli(oclif), project: 'pets', installNote: 'INSTALLED' });
      expect(prompt).not.toMatch(/\{\{\w+\}\}/);
      expect(prompt).toContain('pets feedback --message');
      expect(prompt).toContain('INSTALLED');
      expect(prompt).toContain('Never read `.env*` files, or anything inside `node_modules/`');
    }
  });

  it('names the plugin for oclif and the core package otherwise', () => {
    expect(buildSetupPrompt({ cli: cli(true), project: 'pets', installNote: '' })).toContain(`"restless": { "project": "pets" }`);
    const manual = buildSetupPrompt({ cli: cli(false), project: 'pets', installNote: '' });
    expect(manual).toContain(`import { submitFeedback } from '${CORE_PACKAGE}'`);
    expect(manual).toContain("project: 'pets'");
  });
});

describe('the command, end to end', () => {
  let tmp, home, repo, server, siteUrl, projects;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'init-cli-'));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(home, '.restless'), { recursive: true });
    fs.mkdirSync(repo);
    projects = [{ projectId: 'm1', slug: 'pets', name: 'Pets' }];
    server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/auth/cli/projects')) return res.end(JSON.stringify({ projects }));
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const signedIn = () => fs.writeFileSync(
    path.join(home, '.restless', 'account.json'),
    JSON.stringify({ token: 't', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  const writeRepo = (rel, content) => {
    const file = path.join(repo, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };

  // Async spawn: spawnSync would block the stub server this process is running.
  function run(args, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'init', 'cli', ...args], {
        cwd: repo,
        env: {
          ...process.env,
          HOME: home,
          RESTLESS_CONFIG_DIR: path.join(home, '.restless'),
          RESTLESS_DEBUG_DIR: path.join(tmp, 'debug'),
          RESTLESS_SITE_URL: siteUrl,
          RESTLESS_NONINTERACTIVE: '1',
          RESTLESS_AGENT: 'claude',
          DO_NOT_TRACK: '1',
          CI: '',
          ...env,
        },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (status) => resolve({ status, out: plain(out) }));
    });
  }

  it('refuses a Go CLI without signing in or writing anything', async () => {
    writeRepo('go.mod', 'module pets\n\nrequire github.com/spf13/cobra v1.8.0\n');
    const res = await run([]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('only sets up Node CLIs so far');
    expect(res.out).toContain('Go CLI (go.mod)');
    expect(fs.readdirSync(repo)).toEqual(['go.mod']);
  });

  it('says where it looked when there is no CLI at all', async () => {
    writeRepo('package.json', { name: 'api-server' });
    const res = await run([]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('No CLI found here.');
    expect(res.out).toContain('--dir <path>');
  });

  it('asks for --dir when a monorepo has several CLIs and nobody can pick', async () => {
    writeRepo('packages/a/package.json', { name: 'acli', bin: 'r.js' });
    writeRepo('packages/b/package.json', { name: 'bcli', bin: 'r.js' });
    const res = await run([]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('Found 2 CLIs here');
    expect(res.out).toContain('packages/a');
  });

  it('leaves an already wired oclif CLI alone', async () => {
    writeRepo('package.json', {
      name: 'petcli',
      bin: { pets: 'bin/run.js' },
      dependencies: { '@oclif/core': '^4', [OCLIF_PACKAGE]: '^0.1.0' },
      oclif: { plugins: [OCLIF_PACKAGE] },
      restless: { project: 'pets' },
    });
    const res = await run([]);
    expect(res.status).toBe(0);
    expect(res.out).toContain('pets already has a feedback command (project pets)');
  });

  it('hands a coding agent the oclif steps for the chosen project, changing nothing itself', async () => {
    signedIn();
    writeRepo('package.json', { name: 'petcli', bin: { pets: 'bin/run.js' }, dependencies: { '@oclif/core': '^4' } });
    const before = fs.readFileSync(path.join(repo, 'package.json'), 'utf8');
    const res = await run(['--project', 'pets']);
    expect(res.status).toBe(0);
    expect(res.out).toContain('# Add a `feedback` command to petcli, for Claude Code');
    expect(res.out).toContain(`npm install ${OCLIF_PACKAGE}`);
    expect(res.out).toContain('"restless": { "project": "pets" }');
    expect(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).toBe(before);
  });

  it('lists the projects to choose from when an agent cannot pick one', async () => {
    signedIn();
    projects = [
      { projectId: 'm1', slug: 'pets', name: 'Pets' },
      { projectId: 'm2', slug: 'store', name: 'Store' },
    ];
    writeRepo('package.json', { name: 'petcli', bin: 'r.js' });
    const res = await run([]);
    expect(res.status).toBe(1);
    expect(res.out).toContain('• store (Store)');
    expect(res.out).toContain('init cli --project <slug>');
  });
});
