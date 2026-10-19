import { describe, it, expect } from 'vitest';
import {
  parseStatus,
  validatePort,
  normalizeBaseUrl,
  basePathFromServers,
  describeDiagnosis,
  fixActions,
  fixContext,
  portFromCommand,
  portFromPackageJson,
  portFromSource,
  portFromUrl,
  portFromDocker,
  frameworkDefaultPort, pythonFrameworkDefaultPort, portFromPythonSource } from '../lib/test-diagnosis.js';

// eslint-disable-next-line no-control-regex
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
const text = (r) => r.lines.map(strip).join('\n');

describe('parseStatus', () => {
  it('reads the status off a curl -i dump', () => {
    expect(parseStatus('HTTP/1.1 401 Unauthorized\r\nx-restless-id: abc\r\n\r\n{}')).toBe(401);
    expect(parseStatus('HTTP/2 200\r\n\r\nok')).toBe(200);
  });
  it('uses the LAST status line when there are redirects', () => {
    expect(parseStatus('HTTP/1.1 301 Moved\r\n\r\nHTTP/1.1 200 OK\r\n\r\nbody')).toBe(200);
  });
  it('returns null when there is no status line', () => {
    expect(parseStatus('just a body')).toBeNull();
    expect(parseStatus('')).toBeNull();
    expect(parseStatus(null)).toBeNull();
  });
});

describe('validatePort', () => {
  it('accepts a bare port, a :port, and a full url', () => {
    expect(validatePort('3000')).toBe(3000);
    expect(validatePort(':4000')).toBe(4000);
    expect(validatePort('http://localhost:5173')).toBe(5173);
  });
  it('rejects nonsense and out-of-range values', () => {
    expect(validatePort('nope')).toBeNull();
    expect(validatePort('')).toBeNull();
    expect(validatePort(null)).toBeNull();
    expect(validatePort('0')).toBeNull();
    expect(validatePort('999999')).toBeNull();
  });
});

describe('portFromCommand', () => {
  it('reads every common port-flag shape', () => {
    expect(portFromCommand('next dev -p 3002')).toBe('3002');
    expect(portFromCommand('next dev -p3002')).toBe('3002');
    expect(portFromCommand('vite --port 3002')).toBe('3002');
    expect(portFromCommand('vite --port=3002')).toBe('3002');
    expect(portFromCommand('PORT=3002 next dev')).toBe('3002');
    expect(portFromCommand('cross-env PORT=3002 tsx watch src/index.ts')).toBe('3002');
  });
  it('ignores non-port -p flags and returns null when absent', () => {
    // concurrently's -p prefix flag takes a quoted string, not a number.
    expect(portFromCommand('concurrently -p "{name}" "next dev" "npm run api"')).toBeNull();
    expect(portFromCommand('next dev')).toBeNull();
    expect(portFromCommand('')).toBeNull();
    expect(portFromCommand(null)).toBeNull();
  });
});

describe('portFromPackageJson', () => {
  it('prefers the dev script and reads its explicit port', () => {
    expect(portFromPackageJson({ scripts: { dev: 'next dev -p 3002', build: 'next build' } })).toBe('3002');
  });
  it('finds a port in any script when dev has none', () => {
    expect(portFromPackageJson({ scripts: { dev: 'next dev', start: 'next start -p 4000' } })).toBe('4000');
  });
  it('falls back to the npm config.port field', () => {
    expect(portFromPackageJson({ config: { port: 3002 }, scripts: { dev: 'next dev -p $npm_package_config_port' } })).toBe('3002');
  });
  it('returns null when no port is declared', () => {
    expect(portFromPackageJson({ scripts: { dev: 'next dev' } })).toBeNull();
    expect(portFromPackageJson({})).toBeNull();
    expect(portFromPackageJson(null)).toBeNull();
  });
});

describe('portFromSource', () => {
  it('reads the Node fallback idiom (the demo benefits-api case)', () => {
    expect(portFromSource('const PORT = Number(process.env.PORT) || 3002;\napp.listen(PORT);')).toBe('3002');
    expect(portFromSource('const PORT = process.env.PORT ?? 3001;')).toBe('3001');
    expect(portFromSource('fastify.listen({ port: Number(process.env.PORT) || 3001, host: "0.0.0.0" });')).toBe('3001');
  });
  it('reads a literal listen() and a direct assignment', () => {
    expect(portFromSource('app.listen(4000, () => {})')).toBe('4000');
    expect(portFromSource('const PORT = 8080;')).toBe('8080');
    expect(portFromSource('server: { port: 5174 }')).toBe('5174');
  });
  it('returns null when there is no port literal to grab', () => {
    expect(portFromSource('const PORT = process.env.PORT;')).toBeNull();
    expect(portFromSource('app.listen(PORT);')).toBeNull();
    expect(portFromSource('')).toBeNull();
    expect(portFromSource(null)).toBeNull();
  });
});

describe('portFromUrl', () => {
  it('reads the port from a localhost URL (the demo README case)', () => {
    expect(portFromUrl('Server listens on `http://localhost:3002`.')).toBe('3002');
    expect(portFromUrl('curl -H "Authorization: Token x" http://localhost:3002/v1/employees')).toBe('3002');
    expect(portFromUrl('visit http://127.0.0.1:4000/ to start')).toBe('4000');
  });
  it('skips well-known DB/service ports and returns the real one', () => {
    expect(portFromUrl('DATABASE_URL=postgres://localhost:5432/app\nAPI at http://localhost:3002')).toBe('3002');
    expect(portFromUrl('redis://localhost:6379')).toBeNull();
  });
  it('returns null when there is no localhost URL', () => {
    expect(portFromUrl('no url here')).toBeNull();
    expect(portFromUrl('https://api.example.com/v1')).toBeNull();
    expect(portFromUrl(null)).toBeNull();
  });
});

describe('portFromDocker', () => {
  it('takes the host port from a compose ports mapping', () => {
    expect(portFromDocker('services:\n  api:\n    ports:\n      - "3002:3000"')).toBe('3002');
    expect(portFromDocker('    ports:\n      - 4000:3000')).toBe('4000');
    expect(portFromDocker('    ports:\n      - "127.0.0.1:3002:3000"')).toBe('3002');
    expect(portFromDocker('    ports:\n      - "8080"')).toBe('8080');
  });
  it('reads a Dockerfile EXPOSE', () => {
    expect(portFromDocker('FROM node:20\nEXPOSE 3002\nCMD ["node","index.js"]')).toBe('3002');
  });
  it('skips a DB port mapping and finds the app port', () => {
    expect(portFromDocker('    ports:\n      - "5432:5432"\n      - "3002:3000"')).toBe('3002');
    expect(portFromDocker('    ports:\n      - "5432:5432"')).toBeNull();
  });
  it('returns null when there is no port', () => {
    expect(portFromDocker('services:\n  api:\n    build: .')).toBeNull();
    expect(portFromDocker(null)).toBeNull();
  });
});

describe('frameworkDefaultPort', () => {
  it('maps frameworks to their conventional default port', () => {
    expect(frameworkDefaultPort({ dependencies: { next: '14.0.0' } })).toBe('3000');
    expect(frameworkDefaultPort({ devDependencies: { vite: '5.0.0' } })).toBe('5173');
    expect(frameworkDefaultPort({ dependencies: { astro: '4.0.0' } })).toBe('4321');
    expect(frameworkDefaultPort({ dependencies: { '@angular/core': '17.0.0' } })).toBe('4200');
    expect(frameworkDefaultPort({ dependencies: { gatsby: '5.0.0' } })).toBe('8000');
  });
  it('resolves a SvelteKit app (kit + vite) as Vite, and Next before Vite', () => {
    expect(frameworkDefaultPort({ devDependencies: { '@sveltejs/kit': '2.0.0', vite: '5.0.0' } })).toBe('5173');
    expect(frameworkDefaultPort({ dependencies: { next: '14.0.0' }, devDependencies: { vite: '5.0.0' } })).toBe('3000');
  });
  it('returns null for an unrecognized (e.g. bare Express) project', () => {
    expect(frameworkDefaultPort({ dependencies: { express: '4.0.0' } })).toBeNull();
    expect(frameworkDefaultPort({})).toBeNull();
    expect(frameworkDefaultPort(null)).toBeNull();
  });
});

describe('normalizeBaseUrl', () => {
  it('turns a bare port or host into a localhost base URL', () => {
    expect(normalizeBaseUrl('3002')).toBe('http://localhost:3002');
    expect(normalizeBaseUrl(':4000')).toBe('http://localhost:4000');
    expect(normalizeBaseUrl('localhost:3002')).toBe('http://localhost:3002');
    expect(normalizeBaseUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
  });
  it('keeps a full URL and its base path, trimming a trailing slash', () => {
    expect(normalizeBaseUrl('http://localhost:3002/api')).toBe('http://localhost:3002/api');
    expect(normalizeBaseUrl('http://localhost:3002/api/')).toBe('http://localhost:3002/api');
    expect(normalizeBaseUrl('https://localhost:3002')).toBe('https://localhost:3002');
  });
  it('returns null for nonsense', () => {
    expect(normalizeBaseUrl('')).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl('not a url')).toBeNull();
  });
});

describe('basePathFromServers', () => {
  it('extracts a base path from an absolute or relative server url', () => {
    expect(basePathFromServers({ servers: [{ url: 'http://localhost:3000/api' }] })).toBe('/api');
    expect(basePathFromServers({ servers: [{ url: '/api/v1' }] })).toBe('/api/v1');
    expect(basePathFromServers({ servers: [{ url: 'https://api.example.com/v2/' }] })).toBe('/v2');
  });
  it('is empty for a host-only server or a missing servers block', () => {
    expect(basePathFromServers({ servers: [{ url: 'https://whatever.com' }] })).toBe('');
    expect(basePathFromServers({ servers: [{ url: 'http://localhost:3000/' }] })).toBe('');
    expect(basePathFromServers({})).toBe('');
    expect(basePathFromServers(null)).toBe('');
  });
});

describe('describeDiagnosis', () => {
  it('ok is a non-fixable green success', () => {
    const r = describeDiagnosis('ok', { status: 401 });
    expect(r.canFix).toBe(false);
    expect(text(r)).toContain('picking up your requests');
  });

  // The status code is shown per-request in the batch table, so the panel
  // copy no longer explains it ("got a 401 - that's expected" read as noise).
  it('never editorializes about the status code', () => {
    for (const state of ['ok', 'no-sdk', 'stale-key']) {
      expect(text(describeDiagnosis(state, { status: 401 }))).not.toContain('401');
    }
  });

  it('no-sdk and no-key are fixable failures', () => {
    expect(describeDiagnosis('no-sdk', { status: 401 }).canFix).toBe(true);
    expect(describeDiagnosis('no-key').canFix).toBe(true);
    expect(text(describeDiagnosis('no-sdk', {}))).toContain("didn't go through the Restless SDK");
    expect(text(describeDiagnosis('no-key', {}))).toContain('RESTLESS_KEY');
  });

  it('setup-expired blames our own key, points at login, and is not an AI fix', () => {
    const r = describeDiagnosis('setup-expired', { status: 200 });
    expect(r.canFix).toBe(false);
    expect(text(r)).toContain('npx restless login');
    expect(text(r)).not.toContain('RESTLESS_KEY');
    expect(fixActions('setup-expired').map((a) => a.key)).toEqual(['recheck', 'port', 'skip']);
  });

  it('stale-key is a warning that points at .env, not an AI fix', () => {
    const r = describeDiagnosis('stale-key', { status: 200 });
    expect(r.canFix).toBe(false);
    expect(text(r)).toContain('no log reached your dashboard');
    expect(text(r)).toContain('.env');
  });

  // Phase 1: the first few probes are just "connecting" - no amber, no
  // escape-hatch footer (`waiting` tells the caller to hold it back), because
  // a server that's merely slow to boot is not an error.
  it('unreachable starts as a quiet gray connecting line', () => {
    for (const attempt of [1, 2, 3]) {
      const r = describeDiagnosis('unreachable', { localBase: 'http://localhost:3002/api', attempt });
      expect(r.waiting).toBe(true);
      expect(r.lines.length).toBe(1);
      expect(text(r)).toContain('Connecting to your API to test');
      expect(text(r)).not.toContain('Action needed');
      // Nothing amber in the panel while we're still just connecting.
      expect(r.lines.join('') + r.icon).not.toContain('\x1b[33m');
    }
  });

  it('unreachable turns into the amber call to action once probes keep failing', () => {
    const r = describeDiagnosis('unreachable', { localBase: 'http://localhost:3002/api', attempt: 4 });
    expect(r.waiting).toBeFalsy();
    expect(r.canFix).toBe(false);
    // Lead with an imperative that makes clear the user has to act...
    expect(text(r)).toContain('Action needed: start your dev server');
    // ...and tell them to run it in another terminal (the biggest confusion).
    expect(text(r)).toContain('another terminal');
    // ...with a still-polling line under it so they know we haven't given up.
    expect(text(r)).toContain('still looking for your API on localhost:3002');
    expect(r.lines.length).toBe(3);
  });

  it('the still-looking glyph animates and is not the concentric spinner', () => {
    const glyphs = [0, 1, 2, 3].map((frame) => {
      const r = describeDiagnosis('unreachable', { localBase: 'http://localhost:3002', attempt: 9, frame });
      return strip(r.lines[2]).trim()[0];
    });
    expect(new Set(glyphs).size).toBeGreaterThan(1);
    for (const g of glyphs) expect('◌○◎●').not.toContain(g);
  });
});

describe('fixActions', () => {
  it('leads with the AI fix on fixable states', () => {
    const acts = fixActions('no-sdk', { aiTool: 'Claude Code' });
    expect(acts[0].key).toBe('fix');
    expect(acts[0].primary).toBe(true);
    expect(acts.map((a) => a.key)).toEqual(['fix', 'recheck', 'port', 'skip']);
  });
  it('omits the fix action when nothing is fixable', () => {
    const acts = fixActions('ok');
    expect(acts.map((a) => a.key)).not.toContain('fix');
    expect(acts[0].key).toBe('recheck');
  });
});

describe('fixContext', () => {
  it('no-key evidence is about the missing key, not the missing header', () => {
    const c = fixContext('no-key', { localBase: 'http://localhost:3000' });
    expect(c.evidence).toContain('missing-key');
    expect(c.evidence).toContain('RESTLESS_KEY');
    expect(c.guidance).toContain('.env');
  });
  it('no-sdk evidence is about the missing SDK header', () => {
    const c = fixContext('no-sdk', { localBase: 'http://localhost:3000' });
    // Both names, in the order they actually happen: a bare probe gets
    // x-request-id back, so naming only x-restless-id misdirects the fixer.
    expect(c.evidence).toContain('x-request-id');
    expect(c.evidence).toContain('x-restless-id');
    expect(c.evidence).toContain('not actually intercepting');
  });
});

describe('fixContext stale-key', () => {
  it('names the reconcile command and forbids code edits', () => {
    const c = fixContext('stale-key', { localBase: 'http://localhost:3001', cli: 'api-beta' });
    expect(c.evidence).toContain('no log arrived');
    expect(c.guidance).toContain('npx api-beta key');
    expect(c.guidance).toContain("don't edit the wiring");
  });

  it('defaults the CLI name to restless', () => {
    const c = fixContext('stale-key', { localBase: 'http://localhost:3001' });
    expect(c.guidance).toContain('npx restless key');
  });
});

describe('Python port heuristics', () => {
  it('knows each framework\'s conventional default', () => {
    // 3000 is a Node convention. Guessing it for Django sends `npx restless
    // verify` at a closed port and reads as "the SDK isn't working".
    expect(pythonFrameworkDefaultPort(['django'])).toBe('8000');
    expect(pythonFrameworkDefaultPort(['flask'])).toBe('5000');
    expect(pythonFrameworkDefaultPort(['fastapi', 'uvicorn'])).toBe('8000');
    expect(pythonFrameworkDefaultPort(['bottle'])).toBe('8080');
    expect(pythonFrameworkDefaultPort(['pyramid'])).toBe('6543');
    expect(pythonFrameworkDefaultPort(['tornado'])).toBe('8888');
  });

  it('falls back to the detected framework name when deps are unreadable', () => {
    expect(pythonFrameworkDefaultPort([], 'Flask')).toBe('5000');
    expect(pythonFrameworkDefaultPort([], 'FastAPI')).toBe('8000');
    expect(pythonFrameworkDefaultPort([], 'unknown')).toBeNull();
  });

  it('reads an explicit port out of Python source and process config', () => {
    expect(portFromPythonSource('app.run(port=5001)')).toBe('5001');
    expect(portFromPythonSource('app.run(host="0.0.0.0", port=8080)')).toBe('8080');
    expect(portFromPythonSource('uvicorn.run(app, port=9000)')).toBe('9000');
    expect(portFromPythonSource('python manage.py runserver 0.0.0.0:8001')).toBe('8001');
    expect(portFromPythonSource('web: gunicorn --bind 0.0.0.0:8002 app:app')).toBe('8002');
    expect(portFromPythonSource('uvicorn app:app --port 8003')).toBe('8003');
  });

  it('returns null rather than guessing when nothing is declared', () => {
    expect(portFromPythonSource('def handler(): pass')).toBeNull();
    expect(portFromPythonSource('')).toBeNull();
  });
});
