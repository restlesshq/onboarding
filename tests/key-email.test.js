import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'bin', 'restless.js');

const SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://api.pets.example' }],
  paths: { '/pets': { get: { responses: { 200: { description: 'ok' } } } } },
});

describe('key --email, then login', () => {
  let tmp, home, repo, server, siteUrl, calls, oasStatus, initStatus;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'key-email-'));
    home = path.join(tmp, 'home');
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(repo, '.restless'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    fs.writeFileSync(path.join(repo, '.restless', 'openapi.json'), SPEC);
    fs.writeFileSync(path.join(repo, '.restless', 'settings.json'), JSON.stringify({
      apis: [{ name: 'Pets', rootDir: '.', oasFile: '.restless/openapi.json', language: 'javascript' }],
    }));
    calls = [];
    oasStatus = 201;
    initStatus = 201;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const route = req.url.replace(/^\/api\/projects\/p1\//, '');
        calls.push({ route, body: body && !body.startsWith('\x1f') ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/projects/init') {
          res.statusCode = initStatus;
          return res.end(JSON.stringify({ project_id: 'p1', setup_key: 'sk1' }));
        }
        if (route === 'oas') res.statusCode = oasStatus;
        res.end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    siteUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // Async spawn: spawnSync would block the stub server this process is running.
  function run(args) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, ...args, '--json'], {
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
        },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', (status) => {
        const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
        resolve({ status, json: JSON.parse(json) });
      });
    });
  }

  it('records the email at key time and sends it from login only after the spec and settings', async () => {
    const key = await run(['key', '--email', ' Dev@Example.com ']);
    expect(key.status).toBe(0);
    expect(key.json).toMatchObject({ ok: true, projectId: 'p1', emailSaved: true });
    expect(calls.map((c) => c.route)).toEqual(['/api/projects/init']);

    const login = await run(['login']);
    expect(login.status).toBe(0);
    expect(login.json.emailLinked).toBe(true);
    const routes = calls.map((c) => c.route);
    expect(routes).toEqual(expect.arrayContaining(['oas', 'settings', 'setup-progress']));
    const progress = routes.indexOf('setup-progress');
    expect(progress).toBeGreaterThan(routes.indexOf('oas'));
    expect(progress).toBeGreaterThan(routes.indexOf('settings'));
    expect(calls[progress].body).toEqual({
      setup_key: 'sk1',
      step: 'email',
      status: 'done',
      email: 'dev@example.com',
    });
  });

  it('records nothing at key time for a project that is already claimed', async () => {
    await run(['key']);
    // Age the stored key so `key` asks the server to renew it, which answers 409 once claimed.
    const credsFile = path.join(home, '.restless', 'projects', 'p1.json');
    const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
    fs.writeFileSync(credsFile, JSON.stringify({ ...creds, savedAt: new Date(0).toISOString() }));
    initStatus = 409;

    const key = await run(['key', '--email', 'dev@example.com']);
    expect(key.status).toBe(0);
    expect(key.json.emailSaved).toBe(false);
    expect(JSON.parse(fs.readFileSync(credsFile, 'utf8'))).not.toHaveProperty('setupEmail');
  });

  it('sends nothing for a project that is already claimed', async () => {
    await run(['key', '--email', 'dev@example.com']);
    oasStatus = 409;

    const login = await run(['login']);
    expect(login.json).not.toHaveProperty('emailLinked');
    expect(calls.map((c) => c.route)).not.toContain('setup-progress');
  });

  it('leaves login unchanged when no email was given', async () => {
    const key = await run(['key']);
    expect(key.json).not.toHaveProperty('emailSaved');

    const login = await run(['login']);
    expect(login.json).not.toHaveProperty('emailLinked');
    expect(calls.map((c) => c.route)).not.toContain('setup-progress');
  });

  it.each([
    ['a value that is not an address', ['--email', 'not-an-email']],
    ['no value at all', ['--email']],
  ])('refuses %s before registering anything', async (_label, flag) => {
    const key = await run(['key', ...flag]);
    expect(key.status).toBe(1);
    expect(key.json.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});
