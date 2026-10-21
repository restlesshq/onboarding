import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { findSdkReferences, findOwnerIdPlaceholders, findFilesMatching, listFiles, posixToJsRegex } from '../lib/grep-sdk.js';
import { grepForLoader } from '../lib/env-detect.js';
import { pkgRoot } from '../lib/ai.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grep-sdk-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('findOwnerIdPlaceholders', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('finds files carrying the placeholder or the marker comment', () => {
    write(dir, 'index.js', `owner: {\n  // RESTLESS_OWNER_ID_TODO: no stable id found\n  id: 'NEEDS_CONFIGURATION',\n}\n`);
    write(dir, 'src/other.ts', `const x = 1;\n`);
    expect(findOwnerIdPlaceholders(dir)).toEqual(['index.js']);
  });

  it('returns empty when the placeholder is resolved', () => {
    write(dir, 'index.js', `owner: { id: req.account.id }\n`);
    expect(findOwnerIdPlaceholders(dir)).toEqual([]);
  });

  it('ignores node_modules and non-source files', () => {
    write(dir, 'node_modules/pkg/index.js', `'NEEDS_CONFIGURATION'`);
    write(dir, 'notes.md', `NEEDS_CONFIGURATION`);
    expect(findOwnerIdPlaceholders(dir)).toEqual([]);
  });

  it('prunes excluded dirs at any depth and reports nested hits with native separators', () => {
    write(dir, 'src/api/handlers.ts', `// RESTLESS_OWNER_ID_TODO\n`);
    write(dir, 'packages/web/.next/server/app.js', `'NEEDS_CONFIGURATION'`);
    write(dir, 'packages/web/dist/app.js', `'NEEDS_CONFIGURATION'`);
    expect(findOwnerIdPlaceholders(dir)).toEqual([path.join('src', 'api', 'handlers.ts')]);
  });

  it('does not follow symlinked directories', () => {
    write(dir, 'elsewhere/index.js', `'NEEDS_CONFIGURATION'`);
    fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'linked'), 'dir');
    expect(findOwnerIdPlaceholders(dir)).toEqual([path.join('elsewhere', 'index.js')]);
  });
});

describe('findFilesMatching', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is pure Node: no grep binary needed', () => {
    // The old implementation shelled out to grep, which Windows lacks, and
    // reported "no matches" when the shell-out failed. Run with an empty PATH
    // so a grep binary cannot be found, and the search must still work.
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      write(dir, 'server.js', `import sdk from '@restlessai/sdk';\n`);
      expect(findSdkReferences(dir)).toEqual(['server.js']);
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it('understands the POSIX bracket classes the writers use', () => {
    write(dir, 'app.py', `from restless import Restless\n`);
    write(dir, 'views.py', `import\trestless\n`);
    write(dir, 'prose.py', `# the restless_var is unrelated\n`);
    expect(findFilesMatching('(from|import)[[:space:]]+restless', dir, ['*.py']))
      .toEqual(['app.py', 'views.py']);
  });

  it('matches the Ruby pattern with its embedded quotes', () => {
    write(dir, 'config.ru', `require "restless"\n`);
    write(dir, 'app.rb', `client = Restless::Client.new\n`);
    write(dir, 'other.rb', `puts "restless"\n`);
    const pattern = `(require[[:space:]]+["']restless["']|Restless\\.new|Restless::Client)`;
    expect(findFilesMatching(pattern, dir, ['*.rb', '*.ru'])).toEqual(['app.rb', 'config.ru']);
  });

  it('only looks at files whose basename matches a glob', () => {
    write(dir, 'main.go', `import "github.com/restlesshq/go"\n`);
    write(dir, 'notes.go.txt', `github.com/restlesshq/go\n`);
    write(dir, 'go.mod', `github.com/restlesshq/go\n`);
    expect(findFilesMatching('github\\.com/restlesshq/go', dir, ['*.go'])).toEqual(['main.go']);
  });

  it('returns empty for a directory that does not exist', () => {
    expect(findFilesMatching('x', path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('listFiles', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('lists files by basename glob, pruning the vendored and build trees', () => {
    write(dir, 'package.json', '{}');
    write(dir, 'apps/api/package.json', '{}');
    write(dir, 'node_modules/dep/package.json', '{}');
    write(dir, 'apps/web/.next/package.json', '{}');
    write(dir, 'apps/web/dist/package.json', '{}');
    expect(listFiles(dir, ['package.json'])).toEqual([
      path.join('apps', 'api', 'package.json'),
      'package.json',
    ]);
  });

  it('matches dotfile prefixes and mid-name wildcards', () => {
    write(dir, '.env', 'A=1');
    write(dir, '.env.local', 'A=1');
    write(dir, 'api/.env.production', 'A=1');
    write(dir, 'environment.js', '');
    write(dir, 'docker-compose.dev.yml', '');
    write(dir, 'compose.yml', '');
    expect(listFiles(dir, ['.env*'])).toEqual(['.env', '.env.local', path.join('api', '.env.production')]);
    expect(listFiles(dir, ['docker-compose*.yml', 'compose.yml'])).toEqual(['compose.yml', 'docker-compose.dev.yml']);
  });

  it('honours maxDepth like find and limit like head', () => {
    write(dir, 'a.js', '');
    write(dir, 'one/b.js', '');
    write(dir, 'one/two/c.js', '');
    write(dir, 'one/two/three/d.js', '');
    expect(listFiles(dir, ['*.js'], { maxDepth: 3 })).toEqual([
      'a.js',
      path.join('one', 'b.js'),
      path.join('one', 'two', 'c.js'),
    ]);
    expect(listFiles(dir, ['*.js'], { limit: 2 })).toHaveLength(2);
  });

  it('returns empty for a directory that does not exist', () => {
    expect(listFiles(path.join(dir, 'missing'), ['*.js'])).toEqual([]);
  });
});

describe('posixToJsRegex', () => {
  it('translates bracket classes and leaves the rest of the ERE alone', () => {
    const re = posixToJsRegex('(from|import)[[:space:]]+restless[[:digit:]]?');
    expect(re.test('from   restless')).toBe(true);
    expect(re.test('import\trestless2')).toBe(true);
    expect(re.test('fromrestless')).toBe(false);
    expect(re.multiline).toBe(true);
  });
});

describe('grepForLoader', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('reports the first source file that loads the env', () => {
    write(dir, 'src/settings.py', `from dotenv import load_dotenv\nload_dotenv()\n`);
    write(dir, '.venv/lib/site-packages/dotenv/main.py', `def load_dotenv(): pass\n`);
    expect(grepForLoader(dir, {
      pattern: 'load_dotenv|from dotenv import',
      globs: ['*.py'],
      ignore: ['site-packages', '/.venv/'],
      describe: (file) => `dotenv loaded in ${file}`,
    })).toEqual({ mode: 'dotenv', evidence: `dotenv loaded in ${path.join('src', 'settings.py')}` });
  });

  it('returns null when nothing outside the ignored trees matches', () => {
    write(dir, 'node_modules/dotenv/lib/main.js', `require('dotenv/config')\n`);
    // A top-level venv: the `/.venv/` fragment has to match it even though
    // the relative path has no leading slash.
    write(dir, '.venv/dotenv/main.py', `from dotenv import load_dotenv\n`);
    expect(grepForLoader(dir, {
      pattern: 'from dotenv import',
      globs: ['*.py'],
      ignore: ['site-packages', '/.venv/'],
      describe: (file) => file,
    })).toBeNull();
    expect(grepForLoader(dir, {
      pattern: 'dotenv/config',
      globs: ['*.js'],
      describe: (file) => file,
    })).toBeNull();
  });
});

describe('pkgRoot', () => {
  it('is a real filesystem path to the package root, not a file-URL pathname', () => {
    // `new URL(import.meta.url).pathname` gave `/C:/...` on Windows, which
    // `path.resolve` doubled into a path that does not exist. The portable
    // conversion has to land on the directory that holds the prompts.
    expect(path.isAbsolute(pkgRoot)).toBe(true);
    expect(pkgRoot).not.toMatch(/%20|^\/[A-Za-z]:/);
    expect(fs.existsSync(path.join(pkgRoot, 'prompts', 'generate-oas.md'))).toBe(true);
  });
});

describe('findSdkReferences', () => {
  it('lists source files referencing the SDK', () => {
    const dir = tmp();
    write(dir, 'server.js', `const sdk = require('@restlessai/sdk')(process.env.RESTLESS_KEY);\n`);
    write(dir, 'node_modules/@restlessai/sdk/index.js', `// @restlessai/sdk`);
    expect(findSdkReferences(dir)).toEqual(['server.js']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
