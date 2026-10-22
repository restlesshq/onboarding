import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { buildAgentPlan, repoFacts } from '../lib/agent-plan.js';

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-plan-')));
}

function write(dir, rel, content) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const OAS = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.0.0' },
  paths: {
    '/pets': { get: {}, post: {} },
    '/pets/{id}': { get: {} },
  },
});

describe('repoFacts', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports mapped APIs from .restless/ and skips the scan', () => {
    write(dir, '.restless/openapi.json', OAS);
    write(
      dir,
      '.restless/settings.json',
      JSON.stringify({ apis: [{ name: 'Pets', rootDir: '.', oasFile: '.restless/openapi.json' }] }),
    );
    // A framework dep that the scan WOULD flag - mapped facts should win and
    // leave signals empty rather than paying for the walk.
    write(dir, 'package.json', JSON.stringify({ name: 'pets', dependencies: { express: '^4' } }));

    const { mapped, signals } = repoFacts({ rootDir: dir });
    expect(mapped).toHaveLength(1);
    expect(mapped[0]).toMatchObject({ name: 'Pets', endpoints: 3 });
    expect(signals).toEqual([]);
  });

  it('runs the framework scan when nothing is mapped', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'ship', dependencies: { fastify: '^5' } }));
    write(dir, 'index.js', `const fastify = require('fastify')();\nfastify.get('/v1/health', h);\n`);

    const { mapped, signals } = repoFacts({ rootDir: dir });
    expect(mapped).toEqual([]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ package: '.', name: 'ship', frameworkDeps: ['fastify'] });
  });

  it('honors injected signals without scanning', () => {
    const injected = [{ package: 'api', name: 'x', frameworkDeps: ['express'], oasGenDeps: [], sourceMarkers: [], endpointCount: 0 }];
    const { signals } = repoFacts({ rootDir: dir, signals: injected });
    expect(signals).toBe(injected);
  });
});

describe('buildAgentPlan', () => {
  let dir;
  beforeEach(() => {
    dir = tmp();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('lists scan findings for a fresh repo instead of claiming an empty scan', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'ship', dependencies: { fastify: '^5' } }));
    write(dir, 'index.js', `const fastify = require('fastify')();\nfastify.get('/v1/health', h);\n`);

    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('fastify');
    expect(plan).toContain('(ship)');
    expect(plan).not.toContain('found no framework it recognizes');
  });

  it('surfaces self-generation deps (@fastify/swagger) so step 1.2 has a target', () => {
    write(
      dir,
      'package.json',
      JSON.stringify({ name: 'ship', dependencies: { fastify: '^5', '@fastify/swagger': '^9' } }),
    );
    write(dir, 'index.js', `const fastify = require('fastify')();\nfastify.get('/v1/health', h);\n`);

    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('can generate its own spec via @fastify/swagger');
  });

  it('tells the agent to ask the user when more than one API candidate exists', () => {
    write(dir, 'a/package.json', JSON.stringify({ name: 'a', dependencies: { express: '^4' } }));
    write(dir, 'a/server.js', `app.get('/x', h);\n`);
    write(dir, 'b/package.json', JSON.stringify({ name: 'b', dependencies: { fastify: '^5' } }));
    write(dir, 'b/server.js', `fastify.get('/y', h);\n`);

    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('Ask the user which one to set up');
  });

  it('says honestly when the scan found nothing', () => {
    write(dir, 'README.md', 'not an api');
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('a scan of dependencies and source found no framework it recognizes');
  });

  it('tells the agent to confirm this is the API repo, and to stop if it is not', () => {
    // The customer who ran init in their docs repo got "find the API
    // yourself", and the agent did its best. When we cannot tell what a
    // repo is, the reader can - so it is told what to do with the answer.
    write(dir, 'package.json', JSON.stringify({ name: 'docs', dependencies: {} }));
    write(dir, 'README.md', 'not an api');
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('First confirm this repo holds the server that handles API requests');
    expect(plan).toContain('documentation site');
    expect(plan).toContain('rather than inventing an API');
  });

  it('does not second-guess a repo where the scan found a framework', () => {
    write(dir, 'package.json', JSON.stringify({ name: 'api', dependencies: { express: '^4' } }));
    write(dir, 'index.js', "const app = require('express')(); app.get('/pets', h);\n");
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).not.toContain('First confirm this repo holds the server');
  });

  it('prefers mapped state over the scan on re-runs', () => {
    write(dir, '.restless/openapi.json', OAS);
    write(
      dir,
      '.restless/settings.json',
      JSON.stringify({ apis: [{ name: 'Pets', rootDir: '.', oasFile: '.restless/openapi.json' }] }),
    );
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('Already mapped');
    expect(plan).toContain('**Pets**');
    expect(plan).toContain('3 endpoints');
  });

  it('tells the agent to start the server itself in step 3', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('Start the server yourself');
    expect(plan).not.toContain('Ask the user to start their server');
  });

  it('does not promise the key on stdout', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).not.toContain('"apiKey"');
    expect(plan).toContain('"projectId"');
  });

  it('tells the agent to end its wrap-up with the claim URL', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('LAST line of your wrap-up');
    expect(plan).toContain('Uploads the spec and settings');
  });

  it('makes the claim step non-optional in plain words', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('finish line, not a footnote');
    expect(plan).toContain('Last step: open this link');
    expect(plan.replace(/\s+/g, ' ')).toContain('the one step you cannot do for them');
  });

  it('tells the agent to narrate the plan to the user before starting', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('tell the user the plan');
  });

  it('documents the stale-key verdict in step 3', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('`stale-key`');
  });

  it('makes the NEEDS_CONFIGURATION placeholder a blocking ask-the-user step', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('NEEDS_CONFIGURATION');
    expect(plan).toContain('ask the user which field is the');
    expect(plan).toContain('ownerIdNeedsConfiguration: true');
  });

  it('demands a public servers[0].url and bans local addresses from the spec', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('PUBLIC base URL');
    expect(plan).toContain('localhost, 127.0.0.1');
    expect(plan).toContain('relative mount path');
    expect(plan).toContain('never in the spec');
  });

  it('forbids committing .env and wires the envIgnoredByGit signal', () => {
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'Claude Code' });
    expect(plan).toContain('never stage or commit it');
    expect(plan).toContain('"envIgnoredByGit": false');
    expect(plan).toContain('do not edit `.gitignore` yourself');
    expect(plan).not.toContain('Keep the diff small');
  });

  it('asks an agent we could not identify to name itself on the key command', () => {
    // Only Claude Code and Codex export a marker we recognize, so anything
    // else reaches here unnamed - and the key command is the one that
    // registers the project, so it is the only place the name matters.
    const plan = buildAgentPlan({ rootDir: dir, cli: 'api', agent: 'your agent' });
    expect(plan).toContain('--agent <your-name>');
    expect(plan).toContain('--agent cursor');
    expect(plan).toContain('nothing about the user or this repo');
  });

  it('does not ask an agent that is already named to name itself', () => {
    const plan = buildAgentPlan({
      rootDir: dir,
      cli: 'api',
      agent: 'Claude Code',
      agentSlug: 'claude',
    });
    expect(plan).not.toContain('--agent');
  });
});
