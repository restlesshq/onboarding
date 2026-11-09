import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bin = fileURLToPath(new URL('../bin/restless.js', import.meta.url));
const screeningId = 'a'.repeat(64);
const token = 'fixture-command-token';
const spec = {
  openapi: '3.0.0', info: { title: 'Pets', version: '1' },
  servers: [{ url: 'https://api.example.com' }],
  paths: { '/pets': { get: { summary: 'private-spec-sentinel', responses: { 200: { description: 'OK' } } } } },
};

async function runUpdate({ cancel, cancelDuringAuth = false, terminalStatus }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screening-command-'));
  const requests = [];
  let child;
  let interrupt;
  const home = path.join(dir, 'home');
  const settingsFile = path.join(dir, '.restless', 'settings.json');
  const tokenFile = path.join(home, '.restless', 'projects', 'p1.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, apis: [{
    id: 'pets', rootDir: '.', projectId: 'p1', name: 'Pets',
    ...(cancelDuringAuth ? { oasFile: 'openapi.json', oasSource: { kind: 'file' } } : {}),
  }] }));
  fs.writeFileSync(path.join(dir, 'openapi.json'), JSON.stringify(spec));
  fs.mkdirSync(path.join(home, '.restless', 'projects'), { recursive: true });
  fs.writeFileSync(tokenFile, JSON.stringify({
    token, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }));
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (bytes) => { body += bytes; });
    req.on('end', () => {
      requests.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (cancelDuringAuth && req.method === 'GET') {
        fs.unlinkSync(tokenFile);
        res.end(JSON.stringify({ hasSpec: false }));
        return;
      }
      if (cancelDuringAuth && req.url.endsWith('/api/auth/cli/start')) {
        interrupt = setTimeout(() => child.kill('SIGINT'), 200);
        return;
      }
      if (terminalStatus && requests.length > 1) {
        res.statusCode = terminalStatus;
        res.end(JSON.stringify({ error: 'fixture-command-token private-spec-sentinel' }));
        return;
      }
      if (req.url.endsWith('/oas') && (cancel || requests.length === 1)) {
        res.statusCode = 202;
        res.end(JSON.stringify({ pending: true, screening_id: screeningId, retry_after_ms: cancel ? 60_000 : 1000 }));
        if (cancel) interrupt = setTimeout(() => child.kill('SIGINT'), 200);
      } else {
        res.end(JSON.stringify({ endpoints: 1 }));
      }
    });
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    child = spawn(process.execPath, [bin, 'update', ...(cancelDuringAuth ? [] : ['--oas', 'openapi.json', '--json'])], {
      cwd: dir,
      env: {
        PATH: process.env.PATH, HOME: home, USERPROFILE: home, DO_NOT_TRACK: '1',
        RESTLESS_SITE_URL: `http://127.0.0.1:${server.address().port}`,
        RESTLESS_DEBUG_DIR: path.join(dir, 'debug'),
        ...(cancelDuringAuth ? { RESTLESS_INTERACTIVE: '1' } : {}),
      },
      stdio: [cancelDuringAuth ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      timeout: 4000,
    });
    let stdout = '';
    let stderr = '';
    let answered = false;
    child.stdout.on('data', (bytes) => {
      stdout += bytes;
      if (cancelDuringAuth && !answered && stdout.includes('Push it to the dashboard?')) {
        answered = true;
        child.stdin.write('\n');
      }
    });
    child.stderr.on('data', (bytes) => { stderr += bytes; });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    return { code, stdout, stderr, requests, settings: JSON.parse(fs.readFileSync(settingsFile, 'utf8')) };
  } finally {
    clearTimeout(interrupt);
    if (child && child.exitCode === null) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('update command screening', () => {
  it('exits on the first Ctrl-C during browser-auth preparation before sync starts', async () => {
    const result = await runUpdate({ cancelDuringAuth: true });
    expect(result.code).toBe(0);
    expect(result.requests).toHaveLength(2);
    expect(result.requests[1].url).toBe('/api/auth/cli/start');
    expect(result.settings.apis[0].oasHash).toBeUndefined();
    expect(result.stdout + result.stderr).not.toMatch(/fixture-command-token|private-spec-sentinel|Spec synced|Settings synced/);
  });

  it('reports success only after a resume is approved and settings sync completes', async () => {
    const result = await runUpdate({ cancel: false });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, specSynced: true, synced: true });
    expect(result.requests).toHaveLength(3);
    expect(result.requests[0].headers['x-restless-knowledge-resume']).toBe('1');
    expect(result.requests[1].body).toEqual({ token, screening_id: screeningId });
    expect(result.requests[2].url).toContain('/sync');
    expect(result.stdout + result.stderr).not.toMatch(/fixture-command-token|private-spec-sentinel/);
  });

  it('returns one safe JSON failure with exit 1 on a terminal resumed error', async () => {
    const result = await runUpdate({ terminalStatus: 503 });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, specSynced: false, synced: false,
      error: 'Spec upload failed (HTTP 503). Publication was not confirmed.',
    });
    expect(result.requests).toHaveLength(2);
    expect(result.settings.apis[0].oasHash).toBeUndefined();
    expect(result.stdout + result.stderr).not.toMatch(/fixture-command-token|private-spec-sentinel/);
  });

  it('returns one safe pending JSON result on real Ctrl-C without fingerprinting or syncing settings', async () => {
    const result = await runUpdate({ cancel: true });
    expect(result.code).toBe(130);
    expect(result.stdout, result.stderr).not.toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false, cancelled: true, pending: true, screening_id: screeningId,
      retry_after_ms: 60_000, specSynced: false, synced: false,
    });
    expect(result.requests).toHaveLength(1);
    expect(result.settings.apis[0].oasHash).toBeUndefined();
    expect(result.stdout + result.stderr).not.toMatch(/fixture-command-token|private-spec-sentinel/);
  });
});
