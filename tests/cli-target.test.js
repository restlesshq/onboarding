import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CORE_PACKAGE,
  OCLIF_PACKAGE,
  describeCli,
  describeNativeCli,
  detectPackageManager,
  feedbackStatus,
  findCliPackages,
  installArgs,
  packageSpecs,
} from '../lib/cli-target.js';

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-target-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('describeCli', () => {
  it('reads bin names from both bin shapes', () => {
    write('package.json', { name: '@acme/petcli', version: '2.3.0', bin: './bin/run.js' });
    expect(describeCli(root)).toMatchObject({ name: '@acme/petcli', version: '2.3.0', bins: ['petcli'], oclif: false });
    write('package.json', { name: 'x', bin: { pets: 'a.js', petctl: 'b.js' } });
    expect(describeCli(root).bins).toEqual(['pets', 'petctl']);
  });

  it('is null for a package that ships no CLI', () => {
    write('package.json', { name: 'api-server', dependencies: { express: '4' } });
    expect(describeCli(root)).toBeNull();
  });

  it('spots oclif from its runtime or its manifest block', () => {
    write('package.json', { name: 'a', bin: 'run.js', dependencies: { '@oclif/core': '^4' } });
    expect(describeCli(root).oclif).toBe(true);
    write('package.json', { name: 'a', bin: 'run.js', oclif: { bin: 'a' } });
    expect(describeCli(root).oclif).toBe(true);
  });
});

describe('findCliPackages', () => {
  it('takes the directory it was run in when that is a CLI', () => {
    write('package.json', { name: 'mono', private: true });
    write('packages/cli/package.json', { name: 'petcli', bin: 'run.js' });
    const cliDir = path.join(root, 'packages/cli');
    expect(findCliPackages(cliDir, root).map((c) => c.name)).toEqual(['petcli']);
  });

  it('finds every CLI in a monorepo, skipping node_modules', () => {
    write('package.json', { name: 'mono', private: true });
    write('packages/cli/package.json', { name: 'petcli', bin: 'run.js' });
    write('packages/admin/package.json', { name: 'petadmin', bin: 'run.js' });
    write('node_modules/other/package.json', { name: 'other', bin: 'run.js' });
    expect(findCliPackages(root, root).map((c) => c.name)).toEqual(['petadmin', 'petcli']);
  });
});

describe('describeNativeCli', () => {
  it('reads a Go CLI from go.mod, with its cmd/ binaries', () => {
    write('go.mod', 'module github.com/acme/petctl\n\nrequire github.com/spf13/cobra v1.8.0\n');
    expect(describeNativeCli([root])).toMatchObject({ language: 'go', name: 'petctl', bins: ['petctl'], native: true });
    write('cmd/pets/main.go', 'package main\n');
    expect(describeNativeCli([root]).bins).toEqual(['pets']);
  });

  it('reads a Python CLI from pyproject scripts, or from setup.py', () => {
    write('pyproject.toml', '[project]\nname = "petcli"\nversion = "1.4.0"\n\n[project.scripts]\npets = "petcli.main:app"\n');
    expect(describeNativeCli([root])).toMatchObject({ language: 'python', name: 'petcli', version: '1.4.0', bins: ['pets'] });
    fs.rmSync(path.join(root, 'pyproject.toml'));
    write('setup.py', "setup(name='petcli', entry_points={'console_scripts': ['pets=petcli.main:main']})\n");
    expect(describeNativeCli([root])).toMatchObject({ language: 'python', name: 'petcli', bins: ['pets'] });
  });

  it('reads Rust and Ruby CLIs', () => {
    write('Cargo.toml', '[package]\nname = "petcli"\nversion = "0.3.0"\n\n[dependencies]\nclap = "4"\n');
    expect(describeNativeCli([root])).toMatchObject({ language: 'rust', name: 'petcli', version: '0.3.0', bins: ['petcli'] });
    fs.rmSync(path.join(root, 'Cargo.toml'));
    write('pets.gemspec', 'Gem::Specification.new do |s|\n  s.name = "petcli"\n  s.executables = %w[pets]\nend\n');
    expect(describeNativeCli([root])).toMatchObject({ language: 'ruby', name: 'petcli', bins: ['pets'] });
  });

  it('ignores a Go module that is not a CLI', () => {
    write('go.mod', 'module x\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n');
    expect(describeNativeCli([root])).toBeNull();
  });

  it('counts a native CLI as wired once its source names the feedback host', () => {
    write('go.mod', 'module pets\n\nrequire github.com/spf13/cobra v1.8.0\n');
    expect(feedbackStatus(describeNativeCli([root])).state).toBe('none');
    write('cmd/feedback.go', 'const feedbackURL = "https://pets.restlessdocs.com/feedback"\n');
    expect(feedbackStatus(describeNativeCli([root])).state).toBe('wired');
  });
});

describe('detectPackageManager', () => {
  it('prefers the packageManager field, then the nearest lockfile', () => {
    write('pnpm-lock.yaml', '');
    write('cli/package.json', { name: 'c', bin: 'r.js' });
    expect(detectPackageManager(path.join(root, 'cli'), root)).toBe('pnpm');
    write('cli/package.json', { name: 'c', bin: 'r.js', packageManager: 'yarn@4.1.0' });
    expect(detectPackageManager(path.join(root, 'cli'), root)).toBe('yarn');
  });

  it('defaults to npm', () => {
    write('package.json', { name: 'c', bin: 'r.js' });
    expect(detectPackageManager(root, root)).toBe('npm');
  });
});

describe('install specs', () => {
  it('installs one package per path by default', () => {
    expect(packageSpecs(true, {})).toEqual([OCLIF_PACKAGE]);
    expect(packageSpecs(false, {})).toEqual([CORE_PACKAGE]);
    expect(installArgs('npm', ['a'])).toEqual(['npm', ['install', 'a']]);
    expect(installArgs('pnpm', ['a'])).toEqual(['pnpm', ['add', 'a']]);
  });

  it('maps both packages to local tarballs when pointed at a pack directory', () => {
    write('packs/restlessai-cli-feedback-0.1.0.tgz', '');
    write('packs/restlessai-oclif-plugin-feedback-0.1.0.tgz', '');
    const specs = packageSpecs(true, { RESTLESS_FEEDBACK_TARBALLS: path.join(root, 'packs') });
    expect(specs.map((s) => path.basename(s))).toEqual([
      'restlessai-oclif-plugin-feedback-0.1.0.tgz',
      'restlessai-cli-feedback-0.1.0.tgz',
    ]);
  });
});

describe('feedbackStatus', () => {
  const oclifCli = (extra) => {
    write('package.json', { name: 'petcli', bin: 'run.js', dependencies: { '@oclif/core': '^4' }, oclif: { plugins: [] }, ...extra });
    return describeCli(root);
  };

  it('oclif: wired only with the dependency, the plugin entry and a project', () => {
    expect(feedbackStatus(oclifCli()).state).toBe('none');
    expect(
      feedbackStatus(oclifCli({
        dependencies: { '@oclif/core': '^4', [OCLIF_PACKAGE]: '^0.1.0' },
        oclif: { plugins: [OCLIF_PACKAGE] },
        restless: { project: 'pets' },
      })),
    ).toEqual({ state: 'wired', project: 'pets' });
    expect(
      feedbackStatus(oclifCli({ dependencies: { '@oclif/core': '^4', [OCLIF_PACKAGE]: '^0.1.0' } })).state,
    ).toBe('partial');
  });

  it('manual: wired when the core is a dependency and the source calls it', () => {
    write('package.json', { name: 'petcli', bin: 'run.js', dependencies: { [CORE_PACKAGE]: '^0.1.0' } });
    expect(feedbackStatus(describeCli(root)).state).toBe('partial');
    write('src/commands/feedback.js', "const r = await submitFeedback({ project: 'pets' });\n");
    expect(feedbackStatus(describeCli(root)).state).toBe('wired');
  });
});
