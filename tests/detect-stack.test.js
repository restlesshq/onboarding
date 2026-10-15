import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { detectStack, noCodeMessage, unsupportedStackMessage, stackCheckDisabled } from '../lib/detect-stack.js';
import { describeLanguage, describeLanguages, SUPPORTED_LANGUAGES } from '../lib/sdk-writers/index.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'detect-stack-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function pkg(deps = {}, extra = {}) {
  return JSON.stringify({ name: 'x', dependencies: deps, ...extra });
}

describe('detectStack', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('blocks a repo with no Node server', () => {
    it('routes a pure Python project to the Python scanner', () => {
      // Was a hard block before the Python writer landed. Now it is a
      // supported language, so the same detection routes instead of exiting.
      write(dir, 'requirements.txt', 'fastapi==0.110\nuvicorn\n');
      write(dir, 'main.py', 'app = FastAPI()\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.languages).toEqual(['Python']);
      expect(stack.setupLanguages).toEqual(['python']);
    });

    it('routes a Django backend with a React frontend to Python', () => {
      // The old guard in prompts/detect-endpoints.md required "no package.json
      // exists", so this shape sailed straight past it and the LLM would label
      // the frontend as the API.
      write(dir, 'backend/requirements.txt', 'django\n');
      write(dir, 'backend/manage.py', '#!/usr/bin/env python\n');
      write(dir, 'frontend/package.json', pkg({ react: '^18', 'react-dom': '^18', vite: '^5' }));
      write(dir, 'frontend/src/App.jsx', 'export default function App() { return null; }\n');
      const stack = detectStack(dir);
      // A React+Vite frontend declares no Node SERVER dep, so there is no
      // Node API here to compete with the Django one.
      expect(stack.supported).toBe(true);
      expect(stack.setupLanguages).toEqual(['python']);
      expect(stack.foreign[0].files.sort()).toEqual([
        path.join('backend', 'manage.py'),
        path.join('backend', 'requirements.txt'),
      ]);
    });

    it('flags PHP, Rust, Java and .NET projects', () => {
      const cases = [
        ['composer.json', '{"require":{"laravel/framework":"^11"}}', 'PHP'],
        ['Cargo.toml', '[package]\nname = "api"\n', 'Rust'],
        ['pom.xml', '<project></project>', 'Java'],
        ['Api.csproj', '<Project></Project>', '.NET'],
        ['mix.exs', 'defmodule Api.MixProject do\nend\n', 'Elixir'],
      ];
      for (const [file, content, language] of cases) {
        const d = tmp();
        try {
          write(d, file, content);
          const stack = detectStack(d);
          expect(stack.supported, `${file} should be unsupported`).toBe(false);
          expect(stack.languages).toEqual([language]);
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    });

    it('orders mixed foreign stacks by how much evidence each has', () => {
      write(dir, 'services/py/requirements.txt', 'flask\n');
      write(dir, 'services/py/pyproject.toml', '[project]\nname="svc"\n');
      write(dir, 'services/py/setup.py', 'setup()\n');
      write(dir, 'services/go/go.mod', 'module x\n');
      const stack = detectStack(dir);
      // Both are supported now, so both get scanned and the picker offers
      // whichever APIs each turns up.
      expect(stack.supported).toBe(true);
      expect(stack.languages).toEqual(['Python', 'Go']);
      expect(stack.setupLanguages).toEqual(['python', 'go']);
    });
  });

  describe('never blocks a repo that might be Node', () => {
    it('allows a Node API that happens to carry a requirements.txt', () => {
      // Plenty of Node repos keep Python around for scripts or docs tooling.
      write(dir, 'package.json', pkg({ express: '^4' }));
      write(dir, 'src/server.js', "const app = express();\napp.get('/pets', h);\n");
      write(dir, 'scripts/requirements.txt', 'requests\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toContain('express');
    });

    it('allows a framework outside the labelling list (polka, h3, Elysia)', () => {
      for (const dep of ['polka', 'h3', 'elysia', 'graphql-yoga', '@trpc/server', '@sveltejs/kit']) {
        const d = tmp();
        try {
          write(d, 'package.json', pkg({ [dep]: '^1' }));
          write(d, 'composer.json', '{}');
          const stack = detectStack(d);
          expect(stack.supported, `${dep} should count as Node`).toBe(true);
        } finally {
          fs.rmSync(d, { recursive: true, force: true });
        }
      }
    });

    it('allows a bare node:http server with no framework dependency at all', () => {
      // No recognizable dep and no matched route - only the source marker
      // stands between this repo and a wrong "we do not support Go" exit.
      write(dir, 'package.json', pkg({}));
      write(dir, 'composer.json', '{}');
      write(dir, 'server.mjs', "import { createServer } from 'node:http';\ncreateServer(handler).listen(3000);\n");
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toContain('Node server code');
    });

    it('allows a repo whose only Node evidence is a matched route', () => {
      write(dir, 'package.json', pkg({}));
      write(dir, 'pyproject.toml', '[project]\nname="tooling"\n');
      write(dir, 'src/routes.ts', "router.get('/health', h);\nrouter.post('/pets', h);\n");
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.nodeEvidence.join(' ')).toMatch(/route/);
    });

    it('stays out of the way when there is no foreign manifest', () => {
      // An empty or unrecognizable repo keeps the old behaviour (the picker's
      // hint loop), which is correct for a Node repo we simply failed to read.
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.foreign).toEqual([]);
    });

    it('ignores foreign manifests inside vendored dependency trees', () => {
      // A checked-in virtualenv or bundled gems must not make a Node repo Python.
      write(dir, 'package.json', pkg({}));
      write(dir, 'index.js', 'console.log(1);\n');
      write(dir, '.venv/lib/python3.12/site-packages/thing/pyproject.toml', '[project]\n');
      write(dir, 'vendor/bundle/ruby/3.3/gems/rack/Gemfile', 'source "x"\n');
      write(dir, 'node_modules/some-dep/requirements.txt', 'x\n');
      const stack = detectStack(dir);
      expect(stack.foreign).toEqual([]);
      expect(stack.supported).toBe(true);
    });

    it('counts a Next.js app as Node', () => {
      write(dir, 'package.json', pkg({ next: '^15', react: '^19' }));
      write(dir, 'app/api/pets/route.ts', 'export async function GET() {}\n');
      write(dir, 'requirements.txt', 'jupyter\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
    });

    it('counts a server dep declared only in devDependencies', () => {
      write(dir, 'package.json', JSON.stringify({ name: 'x', devDependencies: { fastify: '^4' } }));
      write(dir, 'go.mod', 'module x\n');
      expect(detectStack(dir).supported).toBe(true);
    });
  });
});

describe('describeLanguages', () => {
  it('reads as prose for one, two and three languages', () => {
    expect(describeLanguages(['Python'])).toBe('Python');
    expect(describeLanguages(['Python', 'Go'])).toBe('Python and Go');
    expect(describeLanguages(['Python', 'Go', 'Rust'])).toBe('Python, Go and Rust');
    expect(describeLanguages([])).toBe('another language');
  });
});

describe('unsupportedStackMessage', () => {
  it('names the language, cites the files, and documents the escape hatch', () => {
    const stack = {
      supported: false,
      nodeEvidence: [],
      foreign: [{ language: 'Ruby', files: ['backend/Gemfile', 'backend/config.ru'] }],
      languages: ['Ruby'],
    };
    // cliName is deliberately not the default here: the bin is `restless`, but
    // ReadMe's api package dispatches to us as `api`, so the escape hatch has to
    // quote back whatever name the user actually typed.
    const { headline, details } = unsupportedStackMessage(stack, { rootDir: '/repo', cliName: 'api' });
    expect(headline).toContain('Ruby');
    const body = details.join('\n');
    expect(body).toContain('backend/Gemfile');
    expect(body).toContain('/repo');
    expect(body).toContain('RESTLESS_SKIP_STACK_CHECK=1 npx api init');
  });

  it('names every unsupported language rather than guessing one', () => {
    const stack = {
      supported: false,
      nodeEvidence: [],
      foreign: [
        { language: 'Ruby', files: ['a/Gemfile'] },
        { language: 'Go', files: ['b/go.mod'] },
      ],
      languages: ['Ruby', 'Go'],
    };
    const { headline } = unsupportedStackMessage(stack, { rootDir: '/repo' });
    expect(headline).toContain('Ruby and Go');
  });

  // Regression: this copy was written out by hand and still read "JavaScript,
  // TypeScript and Python" after Ruby and Go shipped, so a Rails user was told
  // we could not set up the language we had just added support for.
  it('names every language the registry can actually wire', () => {
    const { details } = unsupportedStackMessage(
      { supported: false, nodeEvidence: [], foreign: [{ language: 'Rust', files: ['Cargo.toml'] }], languages: ['Rust'] },
      { rootDir: '/repo' },
    );
    const body = details.join('\n');
    for (const language of SUPPORTED_LANGUAGES) {
      expect(body).toContain(describeLanguage(language));
    }
  });

  it('truncates a long evidence list', () => {
    const files = Array.from({ length: 9 }, (_, i) => `svc${i}/go.mod`);
    const { details } = unsupportedStackMessage(
      { supported: false, nodeEvidence: [], foreign: [{ language: 'Go', files }], languages: ['Go'] },
      { rootDir: '/repo' },
    );
    expect(details[0]).toContain('…');
  });
});

describe('noCodeMessage', () => {
  it('names the directory, tells the agent what to ask, and documents the escape hatch', () => {
    const { headline, details } = noCodeMessage({ rootDir: 'C:\\Users\\x\\proj', cliName: 'api' });
    expect(headline).toContain('C:\\Users\\x\\proj');
    const body = details.join('\n');
    expect(body).toContain('Ask the user where the API lives');
    expect(body).toContain('RESTLESS_SKIP_STACK_CHECK=1 npx api init');
  });
});

describe('stackCheckDisabled', () => {
  const original = process.env.RESTLESS_SKIP_STACK_CHECK;
  afterEach(() => {
    if (original === undefined) delete process.env.RESTLESS_SKIP_STACK_CHECK;
    else process.env.RESTLESS_SKIP_STACK_CHECK = original;
  });

  it('is off by default and honors the documented value', () => {
    delete process.env.RESTLESS_SKIP_STACK_CHECK;
    expect(stackCheckDisabled()).toBe(false);
    process.env.RESTLESS_SKIP_STACK_CHECK = '1';
    expect(stackCheckDisabled()).toBe(true);
    process.env.RESTLESS_SKIP_STACK_CHECK = 'true';
    expect(stackCheckDisabled()).toBe(false);
  });
});

describe('routing (setupLanguages)', () => {
  let dir;
  beforeEach(() => { dir = tmp(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('routes on source extension when a Python project has no manifest', () => {
    // Regression: test-apis/python carries no requirements.txt because its
    // fixtures load the SDK by relative path, so the "no foreign manifest"
    // default sent it to the JavaScript scanner and it reported zero
    // endpoints. Plenty of real services keep dependencies somewhere the walk
    // cannot see, too.
    write(dir, 'main.py', 'app = FastAPI()\n@app.get("/pets")\ndef pets(): ...\n');
    const stack = detectStack(dir);
    expect(stack.setupLanguages).toContain('python');
  });

  it('scans a polyglot monorepo as both, rather than picking a winner', () => {
    // A Django API behind a Next.js frontend is two real APIs. Choosing one
    // here would decide for the user that the other does not exist.
    write(dir, 'web/package.json', pkg({ next: '^15' }));
    write(dir, 'web/app/api/x/route.ts', 'export async function GET() {}\n');
    write(dir, 'api/requirements.txt', 'django\n');
    write(dir, 'api/urls.py', 'urlpatterns = [path("pets/", v)]\n');
    const stack = detectStack(dir);
    expect(stack.setupLanguages).toEqual(['javascript', 'python']);
  });

  it('does not route to a language with no writer yet', () => {
    write(dir, 'composer.json', '{"require":{"laravel/framework":"^11"}}');
    write(dir, 'index.php', '<?php\n');
    const stack = detectStack(dir);
    expect(stack.setupLanguages).toEqual([]);
    expect(stack.supported).toBe(false);
  });

  it('leaves a plain Node repo on the JavaScript scanner alone', () => {
    write(dir, 'package.json', pkg({ express: '^4' }));
    write(dir, 'server.js', "app.get('/x', h);\n");
    expect(detectStack(dir).setupLanguages).toEqual(['javascript']);
  });

  // Regression: a Cursor run on Windows in a folder with no code got the full
  // agent playbook, because "javascript" is the default verdict and an empty
  // folder lands on it the same as a Node repo.
  describe('foundCode', () => {
    it('is false for an empty directory, which is still supported', () => {
      const stack = detectStack(dir);
      expect(stack.supported).toBe(true);
      expect(stack.setupLanguages).toEqual(['javascript']);
      expect(stack.foundCode).toBe(false);
    });

    it('is false when the only files are not code', () => {
      write(dir, 'README.md', '# hi\n');
      write(dir, 'docs/spec.yaml', 'openapi: 3.1.0\n');
      expect(detectStack(dir).foundCode).toBe(false);
    });

    it('ignores code inside skipped directories', () => {
      write(dir, 'node_modules/express/index.js', 'module.exports = {};\n');
      expect(detectStack(dir).foundCode).toBe(false);
    });

    it('is true for a bare package.json', () => {
      write(dir, 'package.json', pkg());
      expect(detectStack(dir).foundCode).toBe(true);
    });

    it('is true for JavaScript source with no manifest', () => {
      write(dir, 'server.js', "require('http').createServer(h).listen(3000);\n");
      expect(detectStack(dir).foundCode).toBe(true);
    });

    it('is true for Python source with no manifest', () => {
      write(dir, 'main.py', 'print(1)\n');
      expect(detectStack(dir).foundCode).toBe(true);
    });

    it('is true for an unsupported stack, which the caller reports separately', () => {
      write(dir, 'Cargo.toml', '[package]\n');
      const stack = detectStack(dir);
      expect(stack.supported).toBe(false);
      expect(stack.foundCode).toBe(true);
    });
  });

  describe('extensions', () => {
    it('lists the commonest extensions first, with extensionless files named', () => {
      write(dir, 'a.md', '');
      write(dir, 'b.md', '');
      write(dir, 'c.yaml', '');
      write(dir, 'LICENSE', '');
      expect(detectStack(dir).extensions).toEqual({ '.md': 2, '(none)': 1, '.yaml': 1 });
    });

    it('caps the list so a large repo does not bloat the log', () => {
      for (let i = 0; i < 12; i++) write(dir, `f.ext${i}`, '');
      expect(Object.keys(detectStack(dir).extensions)).toHaveLength(8);
    });
  });
});
