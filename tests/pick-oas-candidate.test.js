import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ui.js', async (importOriginal) => ({
  ...(await importOriginal()),
  singleSelect: vi.fn(),
  multiSelect: vi.fn(),
}));

const { singleSelect, multiSelect } = await import('../lib/ui.js');
const { pickOasCandidate } = await import('../steps/generate-oas.js');

const candidates = [
  { path: 'a.yaml', absPath: '/r/a.yaml', title: 'A' },
  { path: 'b.yaml', absPath: '/r/b.yaml', title: '' },
  { path: 'c.yaml', absPath: '/r/c.yaml', title: '' },
];

describe('pickOasCandidate', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    singleSelect.mockReset();
    multiSelect.mockReset();
  });

  it('still defaults to a single spec, with combining listed last', async () => {
    singleSelect.mockResolvedValue(0);
    expect(await pickOasCandidate(candidates)).toBe(candidates[0]);
    const [items, opts] = singleSelect.mock.calls[0];
    expect(opts.defaultIndex).toBe(0);
    expect(items).toHaveLength(4);
    expect(items[3].label).toBe('Combine all 3 into one spec');
  });

  it('combines the specs left ticked', async () => {
    singleSelect.mockResolvedValue(3);
    multiSelect.mockResolvedValue([0, 2]);
    expect(await pickOasCandidate(candidates)).toEqual({ combine: true, paths: ['a.yaml', 'c.yaml'] });
  });

  it('goes back to the list when fewer than two are left ticked', async () => {
    singleSelect.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    multiSelect.mockResolvedValue([0]);
    expect(await pickOasCandidate(candidates)).toBe(candidates[1]);
    expect(singleSelect).toHaveBeenCalledTimes(2);
  });
});
