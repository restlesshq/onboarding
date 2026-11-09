import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../lib/ai.js', () => ({
  runAI: vi.fn(), loadPrompt: (_name, vars) => JSON.stringify(vars), getProvider: () => ({ name: 'claude' }),
}));
vi.mock('../lib/context-repo.js', () => ({
  describeRepo: () => ({ isGit: false, label: 'Repo' }), hasUncommittedChanges: () => false,
}));
vi.mock('../lib/context-sync.js', () => ({ fetchScope: vi.fn(), pushCandidates: vi.fn() }));
vi.mock('../lib/context-plan.js', () => ({ buildPlan: () => ({
  strategy: 'inventory', specSource: 'none', coverage: {}, unmappedOperations: [],
  batches: [{ label: 'API', files: ['route.js'], operations: [] }],
}) }));
vi.mock('../lib/settings.js', () => ({ loadSettings: () => ({}), findApiEntry: () => null }));
vi.mock('../lib/detect-stack.js', () => ({ detectStack: () => ({}) }));
vi.mock('../lib/ui.js', () => ({
  bold: String, dim: String, cyan: String, green: String, red: String, yellow: String,
  white: String, muted: String, askYesNo: vi.fn(),
  startSpinner: () => ({ stop: vi.fn(), update: vi.fn() }),
}));

import { runAI } from '../lib/ai.js';
import { fetchScope, pushCandidates } from '../lib/context-sync.js';
import contextStep from '../steps/context.js';

const candidate = { title: 'Public guide', content: 'Use a cursor for pagination.' };
const run = () => contextStep({ project: { projectId: 'project' }, cwd: '/tmp/repo', yes: true });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RESTLESS_CONTEXT_EXTRACTION_MODEL', 'claude-haiku-5-5');
  vi.stubEnv('RESTLESS_CONTEXT_REVIEW_MODEL', 'claude-sonnet-5-5');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fetchScope.mockResolvedValue({ ok: true });
  pushCandidates.mockResolvedValue({ ok: true, counts: {} });
  runAI.mockResolvedValueOnce(JSON.stringify([candidate]));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it('requests structured verdicts and uploads only a complete accepted review', async () => {
  runAI.mockResolvedValueOnce(JSON.stringify({ verdicts: [{ index: 0, safe: true }] }));
  expect(await run()).toBe(0);
  expect(runAI.mock.calls[1][2].outputFormat).toMatchObject({ type: 'json_schema' });
  expect(pushCandidates).toHaveBeenCalledWith(expect.objectContaining({
    candidates: [expect.objectContaining(candidate)],
  }));
});

it.each([
  '```json\n{"verdicts":[{"index":0,"safe":true}]}\n```',
  '{"verdicts":[]}',
  '{"verdicts":[{"index":0,"safe":true},{"index":0,"safe":true}]}',
  '{"verdicts":[{"index":1,"safe":true}]}',
  '{"verdicts":[{"index":0,"safe":true,"title":"ignored"}]}',
  '{"verdicts":[{"index":0,"safe":false}]}',
])('withholds every candidate for a noncanonical or incomplete review: %s', async (review) => {
  runAI.mockResolvedValueOnce(review);
  expect(await run()).toBe(1);
  expect(pushCandidates).not.toHaveBeenCalled();
});
