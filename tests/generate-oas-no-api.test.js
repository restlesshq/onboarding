import { describe, it, expect } from 'vitest';
import { noApiFoundMessage } from '../steps/generate-oas.js';

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('noApiFoundMessage', () => {
  it('keeps the old question when the model could not say what the repo is', () => {
    for (const repoKind of ['unknown', 'api', 'empty', undefined, 42]) {
      const { lines, question } = noApiFoundMessage({ repoKind });
      expect(lines).toEqual([]);
      expect(question).toBe("We couldn't find any APIs. Can you point us at one?");
    }
  });

  it('names a docs site as the wrong repo, with the reason and where to run instead', () => {
    const { lines, question } = noApiFoundMessage({
      repoKind: 'docs',
      repoKindReason: 'Docusaurus site, 140 Markdown pages under docs/, no server',
      cliName: 'api',
    });
    const body = strip(lines.join('\n'));
    expect(body).toContain('This looks like a documentation site, not the server that serves your API.');
    expect(body).toContain('Docusaurus site, 140 Markdown pages under docs/, no server');
    expect(body).toContain('run npx api init from there instead');
    expect(question).toBe('Is the API somewhere in this repo after all?');
  });

  it('covers a frontend and a library the same way', () => {
    expect(strip(noApiFoundMessage({ repoKind: 'frontend' }).lines[0])).toContain('a frontend with no server');
    expect(strip(noApiFoundMessage({ repoKind: 'library' }).lines[0])).toContain('a library or SDK');
  });

  it('omits the reason line when the model gave none', () => {
    const { lines } = noApiFoundMessage({ repoKind: 'docs' });
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('');
  });
});
