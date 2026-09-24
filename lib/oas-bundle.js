import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// A spec split across files with `$ref`s must reach the dashboard as ONE document,
// since the server never resolves a ref to a file on the developer's machine.

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oas-bundle-worker.js');

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function walk(node, visit) {
  if (Array.isArray(node)) { node.forEach((v) => walk(v, visit)); return; }
  if (!isObject(node)) return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
}

export function externalRefs(spec) {
  const out = [];
  walk(spec, (node) => {
    if (typeof node.$ref === 'string' && !node.$ref.startsWith('#')) out.push(node.$ref);
  });
  return out;
}

function resolvePointer(doc, fragment) {
  let node = doc;
  for (const part of fragment.replace(/^\//, '').split('/').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return node;
}

// The bundler leaves a fragment's pointer back into the ROOT file as a file ref
// (`../openapi.yaml#/components/...`), so those become internal refs.
export function repairRootRefs(spec, absPath) {
  const rootName = path.basename(absPath);
  walk(spec, (node) => {
    if (typeof node.$ref !== 'string' || node.$ref.startsWith('#')) return;
    const [file, fragment] = node.$ref.split('#');
    if (fragment === undefined || path.basename(file) !== rootName) return;
    if (resolvePointer(spec, fragment) !== undefined) node.$ref = `#${fragment}`;
  });
}

// In-process: `@readme/openapi-parser` is async-only. A path, not a parsed object,
// so relative refs resolve against the file (oas-normalize's bundle uses the cwd).
export async function bundleSpec(absPath, label = absPath) {
  const { bundle } = await import('@readme/openapi-parser');
  let spec;
  try {
    spec = await bundle(absPath, { resolve: { http: { timeout: 10000 } } });
  } catch (err) {
    return { ok: false, error: `Couldn't resolve the $refs in ${label}.`, detail: err.message };
  }
  if (!isObject(spec)) return { ok: false, error: `${label} isn't an OpenAPI spec.` };
  repairRootRefs(spec, absPath);
  const unresolved = externalRefs(spec);
  if (unresolved.length) {
    return { ok: false, error: `${label} has a $ref we couldn't resolve: ${unresolved[0]}` };
  }
  return { ok: true, spec };
}

// The same, for the synchronous readers (hashing, endpoint counts). Only ever
// reached for a spec with external refs, so a single-file spec never pays for it.
export function bundleSpecSync(absPath, label = absPath) {
  let out;
  try {
    out = execFileSync(process.execPath, [WORKER, absPath, label], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    out = err.stdout;
  }
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: `Couldn't resolve the $refs in ${label}.` };
  }
}

function parseFile(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  return { raw, doc: absPath.endsWith('.json') ? JSON.parse(raw) : yaml.load(raw) };
}

// What the dashboard should receive for this file. A spec without external refs
// is sent byte for byte as before; one with them is sent bundled, as JSON.
export function readSpecForUpload(absPath, label = absPath) {
  let raw, doc;
  try {
    ({ raw, doc } = parseFile(absPath));
  } catch (err) {
    if (raw === undefined) return { ok: false, error: `Couldn't read ${label}: ${err.message}` };
    // Unparseable here is the server's to report, exactly as it was before.
    return { ok: true, raw, format: absPath.endsWith('.json') ? 'json' : 'yaml', bundled: false };
  }
  if (!externalRefs(doc).length) {
    return { ok: true, raw, format: absPath.endsWith('.json') ? 'json' : 'yaml', bundled: false };
  }
  const res = bundleSpecSync(absPath, label);
  if (!res.ok) return res;
  return { ok: true, raw: JSON.stringify(res.spec), format: 'json', bundled: true };
}

// A parsed spec with every external ref bundled in. Falls back to the file as
// written when the refs don't resolve, which is how every reader behaved before.
export function loadBundledOas(absPath) {
  let doc;
  try {
    ({ doc } = parseFile(absPath));
  } catch {
    return null;
  }
  if (!isObject(doc) || !externalRefs(doc).length) return doc;
  const res = bundleSpecSync(absPath);
  return res.ok ? res.spec : doc;
}
