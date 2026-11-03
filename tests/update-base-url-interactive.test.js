import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setGitRoot } from '../lib/pathGuard.js';
import { saveSettings } from '../lib/settings.js';

/**
 * The settings editor is the other way to change a base URL, and it has to
 * carry the change into the spec the same way `--base-url` does. The pickers
 * are scripted: open the Base URL field, type, Submit.
 */
const ui = vi.hoisted(() => ({ picks: [], answers: [] }));
vi.mock('../lib/ui.js', async (orig) => ({
  ...(await orig()),
  clearScreen: () => {},
  printLogo: () => {},
  singleSelect: async () => 0, // "Update Settings"
  actionPicker: async () => ui.picks.shift(),
  ask: async () => ui.answers.shift(),
}));
vi.mock('../lib/cli-token.js', () => ({
  getCliToken: vi.fn(async () => ({ ok: true, token: 'tok' })),
  clearCachedToken: vi.fn(),
  loadCachedToken: vi.fn(() => null),
}));
const { default: runInteractiveUpdate } = await import('../steps/update-interactive.js');

const OLD = 'https://larkspur.onrender.com';
const NEW = 'https://larkspur-tqme.onrender.com';
const MANAGED = '.restless/openapi.json';
const SUBMIT = { kind: 'action', key: 'submit' };
const BASE_URL_FIELD = { kind: 'item', index: 1 };
const NAME_FIELD = { kind: 'item', index: 0 };
let tmp;
let calls;

function setUp({ baseUrl, specUrl = OLD }) {
  fs.mkdirSync(path.join(tmp, '.restless'), { recursive: true });
  fs.writeFileSync(path.join(tmp, MANAGED), JSON.stringify({
    openapi: '3.0.0', info: { title: 'L', version: '1' }, servers: [{ url: specUrl }], paths: { '/pets': { get: {} } },
  }));
  const entry = { id: 'a1', projectId: 'p-1', name: 'Larkspur', rootDir: '.', oasFile: MANAGED, oasSource: { kind: 'agent' }, baseUrl };
  saveSettings(tmp, { version: 1, apis: [entry] });
  return entry;
}
const specUrl = () => JSON.parse(fs.readFileSync(path.join(tmp, MANAGED), 'utf8')).servers[0].url;
const paths = () => calls.map((u) => u.replace(/^https?:\/\/[^/]+/, ''));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-interactive-'));
  setGitRoot(tmp);
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ endpoints: 1 }), text: async () => '' };
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Update Settings > Base URL', () => {
  it('rewrites the generated spec and pushes it before the settings', async () => {
    const entry = setUp({ baseUrl: OLD });
    ui.picks = [BASE_URL_FIELD, SUBMIT];
    ui.answers = [NEW];

    expect(await runInteractiveUpdate({ rootDir: tmp, packageDir: tmp, apiEntry: entry })).toBe(0);

    expect(specUrl()).toBe(NEW);
    expect(paths()).toEqual(['/api/projects/p-1/oas', '/api/projects/p-1/sync']);
  });

  it('pushes the spec when the field is confirmed unchanged', async () => {
    // A spec fixed by hand, or a rewrite whose upload failed, already matches
    // locally. Confirming the field is how someone gets it onto the dashboard.
    const entry = setUp({ baseUrl: NEW, specUrl: NEW });
    ui.picks = [BASE_URL_FIELD, SUBMIT];
    ui.answers = [NEW];

    await runInteractiveUpdate({ rootDir: tmp, packageDir: tmp, apiEntry: entry });

    expect(paths()).toEqual(['/api/projects/p-1/oas', '/api/projects/p-1/sync']);
  });

  it('leaves the spec alone when only another field changed', async () => {
    const entry = setUp({ baseUrl: NEW });
    ui.picks = [NAME_FIELD, SUBMIT];
    ui.answers = ['Larkspur API'];

    await runInteractiveUpdate({ rootDir: tmp, packageDir: tmp, apiEntry: entry });

    expect(specUrl()).toBe(OLD);
    expect(paths()).toEqual(['/api/projects/p-1/sync']);
  });
});
