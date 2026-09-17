import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { MAX_OAS_BYTES } from './config.js';

/**
 * Deterministic OAS (OpenAPI / Swagger) spec discovery.
 *
 * Walks a directory, parses every YAML/JSON file, and returns the ones
 * whose top-level `openapi` or `swagger` field is a string. Detection is
 * content-based, not filename-based - so `api-spec.yml`, `docs/schema.json`,
 * or anything else gets picked up as long as it actually parses to a spec.
 *
 * JSON files are parsed with `JSON.parse`; YAML with `js-yaml`. Both are
 * full parsers, so whitespace, indentation, and quoting style don't matter.
 */

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.vercel',
  '.turbo',
  '.cache',
  '.svelte-kit',
  '.parcel-cache',
]);

// A spec bigger than the dashboard will take is not one we should offer to
// use: finding it means the user only learns it is too big at claim time,
// which is how a 2.9MB spec got all the way to `login`.
const MAX_FILE_SIZE = MAX_OAS_BYTES;
const MAX_DEPTH = 8;

function walk(dir, out, depth) {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      walk(full, out, depth + 1);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ext === '.yaml' || ext === '.yml' || ext === '.json') {
        out.push(full);
      }
    }
  }
}

function parseDoc(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  if (stat.size > MAX_FILE_SIZE) return null;

  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  try {
    if (filePath.toLowerCase().endsWith('.json')) {
      return JSON.parse(raw);
    }
    return yaml.load(raw);
  } catch {
    return null;
  }
}

/**
 * Find OpenAPI / Swagger specs in a directory.
 *
 * Returns an array of:
 *   { path, absolutePath, type: 'openapi'|'swagger', version }
 *
 * `path` is relative to `rootDir`. The array is sorted with shallower paths
 * first - a repo root `openapi.yaml` outranks `examples/legacy/old.yaml`.
 */
export function findOasCandidates(rootDir) {
  const files = [];
  walk(rootDir, files, 0);

  const candidates = [];
  for (const file of files) {
    const doc = parseDoc(file);
    if (!doc || typeof doc !== 'object') continue;

    // Top-level `openapi: "3.0.0"` → OpenAPI 3.x
    // Top-level `swagger: "2.0"` → Swagger 2.0
    if (typeof doc.openapi === 'string') {
      candidates.push({
        path: path.relative(rootDir, file),
        absolutePath: file,
        type: 'openapi',
        version: doc.openapi,
      });
    } else if (typeof doc.swagger === 'string') {
      candidates.push({
        path: path.relative(rootDir, file),
        absolutePath: file,
        type: 'swagger',
        version: doc.swagger,
      });
    }
  }

  // Shallower first, so a root-level spec ranks above nested examples/fixtures.
  candidates.sort((a, b) => {
    const depthA = a.path.split(path.sep).length;
    const depthB = b.path.split(path.sep).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.path.localeCompare(b.path);
  });

  return candidates;
}
