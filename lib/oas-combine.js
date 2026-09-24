import path from 'path';
import { MAX_OAS_BYTES } from './config.js';
import { findOasCandidates } from './find-oas.js';
import { safeWriteFileSync, safeMkdirSync } from './pathGuard.js';
import { bundleSpec } from './oas-bundle.js';

// Combines several specs a developer maintains into the one spec a project has.
// Unlike oas-merge.js (model-written fragments, first wins), nothing here is dropped silently.

const COMPONENT_SECTIONS = [
  'schemas', 'responses', 'parameters', 'examples', 'requestBodies',
  'headers', 'securitySchemes', 'links', 'callbacks', 'pathItems',
];
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const GENERIC_BASENAMES = new Set(['openapi', 'swagger', 'api', 'spec', 'index', 'schema', 'docs']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => JSON.parse(JSON.stringify(v));

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const sameShape = (a, b) => canonical(a) === canonical(b);

const escapePointer = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const unescapePointer = (s) => s.replace(/~1/g, '/').replace(/~0/g, '~');

function walk(node, visit) {
  if (Array.isArray(node)) { node.forEach((v) => walk(v, visit)); return; }
  if (!isObject(node)) return;
  visit(node);
  for (const v of Object.values(node)) walk(v, visit);
}

function resolvePointer(doc, fragment) {
  let node = doc;
  for (const part of fragment.replace(/^\//, '').split('/').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[unescapePointer(part)];
  }
  return node;
}

// One spec as a self-contained OpenAPI 3.x document: a spec split across files
// with `$ref`s is bundled into one input, and Swagger 2.0 is converted.
export async function loadSpecFile(absPath, label = absPath) {
  const bundled = await bundleSpec(absPath, label);
  if (!bundled.ok) return bundled;
  let { spec } = bundled;
  if (typeof spec.openapi !== 'string' && typeof spec.swagger !== 'string') {
    return { ok: false, error: `${label} isn't an OpenAPI or Swagger spec.` };
  }
  if (typeof spec.swagger === 'string') {
    const { default: OASNormalize } = await import('oas-normalize');
    try {
      spec = await new OASNormalize(spec).convert();
    } catch (err) {
      return { ok: false, error: `Couldn't convert ${label} from Swagger to OpenAPI.`, detail: err.message };
    }
  }
  return { ok: true, spec };
}

const pascal = (s) => String(s || '')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => w[0].toUpperCase() + w.slice(1))
  .join('');

function prefixFor(label, spec, index) {
  const base = path.basename(label).replace(/\.(ya?ml|json)$/i, '');
  const fromFile = GENERIC_BASENAMES.has(base.toLowerCase()) ? '' : pascal(base);
  const out = fromFile || pascal(spec?.info?.title) || `Spec${index + 1}`;
  return /^[0-9]/.test(out) ? `Spec${out}` : out;
}

function forEachOperation(doc, fn) {
  for (const group of [doc.paths, doc.webhooks]) {
    if (!isObject(group)) continue;
    for (const item of Object.values(group)) {
      if (!isObject(item)) continue;
      for (const [method, op] of Object.entries(item)) {
        if (HTTP_METHODS.has(method.toLowerCase()) && isObject(op)) fn(op);
      }
    }
  }
}

function rewriteRefs(doc, renames) {
  const renameRef = (ref) => {
    const m = /^#\/components\/([^/]+)\/([^/]+)(\/.*)?$/.exec(ref);
    const to = m && renames[m[1]]?.get(unescapePointer(m[2]));
    return to ? `#/components/${m[1]}/${escapePointer(to)}${m[3] || ''}` : ref;
  };
  walk(doc, (node) => {
    if (typeof node.$ref === 'string') node.$ref = renameRef(node.$ref);
    // Discriminator mappings may name a schema bare as well as by $ref.
    if (isObject(node.discriminator?.mapping)) {
      for (const [k, v] of Object.entries(node.discriminator.mapping)) {
        if (typeof v !== 'string') continue;
        node.discriminator.mapping[k] = v.startsWith('#') ? renameRef(v) : (renames.schemas?.get(v) ?? v);
      }
    }
  });
  for (const section of COMPONENT_SECTIONS) {
    const defs = doc.components?.[section];
    if (!isObject(defs) || !renames[section]?.size) continue;
    doc.components[section] = Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [renames[section].get(name) ?? name, def]),
    );
  }
  // Security requirements name schemes by key, not by $ref.
  const schemes = renames.securitySchemes;
  if (schemes?.size) {
    const renameReqs = (reqs) => (Array.isArray(reqs)
      ? reqs.map((req) => (isObject(req)
        ? Object.fromEntries(Object.entries(req).map(([k, v]) => [schemes.get(k) ?? k, v]))
        : req))
      : reqs);
    if (doc.security) doc.security = renameReqs(doc.security);
    forEachOperation(doc, (op) => { if (op.security) op.security = renameReqs(op.security); });
  }
  return doc;
}

// Repeats until stable: renaming `Error` changes every schema that refs it,
// so those have to be compared again and may need renaming too.
function planRenames(base, incoming, prefix) {
  const renames = {};
  const taken = (section, name) => base.components?.[section]?.[name] !== undefined
    || incoming.components?.[section]?.[name] !== undefined
    || [...(renames[section]?.values() || [])].includes(name);
  for (;;) {
    const rewritten = rewriteRefs(clone(incoming), renames);
    let changed = false;
    for (const section of COMPONENT_SECTIONS) {
      const theirs = incoming.components?.[section];
      if (!isObject(theirs)) continue;
      for (const name of Object.keys(theirs)) {
        if (renames[section]?.has(name)) continue;
        const ours = base.components?.[section]?.[name];
        if (ours === undefined || sameShape(ours, rewritten.components[section][name])) continue;
        const wanted = `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
        let to = wanted;
        for (let n = 2; taken(section, to); n++) to = `${wanted}${n}`;
        (renames[section] ??= new Map()).set(name, to);
        changed = true;
      }
    }
    if (!changed) return renames;
  }
}

function paramKey(param, doc) {
  const resolved = typeof param?.$ref === 'string' && param.$ref.startsWith('#')
    ? resolvePointer(doc, param.$ref.slice(1))
    : param;
  return resolved?.name && resolved?.in ? `${resolved.in}:${resolved.name}` : canonical(param);
}

// Two path items can only share a path once their path-level `parameters`
// live on their own operations.
function pushDownParameters(item, doc) {
  if (!Array.isArray(item.parameters)) return;
  for (const [method, op] of Object.entries(item)) {
    if (!HTTP_METHODS.has(method.toLowerCase()) || !isObject(op)) continue;
    const own = new Set((op.parameters || []).map((p) => paramKey(p, doc)));
    op.parameters = [...item.parameters.filter((p) => !own.has(paramKey(p, doc))), ...(op.parameters || [])];
  }
  delete item.parameters;
}

const minorVersion = (v) => String(v).split('.').slice(0, 2).join('.');
const serverUrls = (spec) => (Array.isArray(spec.servers)
  ? spec.servers.map((s) => String(s?.url || '').replace(/\/+$/, '')).filter(Boolean).sort()
  : []);

// `inputs` is `[{ label, spec }]` of parsed OpenAPI 3.x; the first supplies `info`.
// Returns `{ ok, spec, renamed }`, or `{ ok: false, error, detail }` on a real conflict.
export function combineSpecs(inputs) {
  if (!Array.isArray(inputs) || inputs.length < 2) {
    return { ok: false, error: 'Combining needs at least two specs.' };
  }
  const [first, ...rest] = inputs;

  const version = minorVersion(first.spec.openapi);
  const offVersion = rest.find((i) => minorVersion(i.spec.openapi) !== version);
  if (offVersion) {
    return {
      ok: false,
      error: `${first.label} is OpenAPI ${version} and ${offVersion.label} is OpenAPI ${minorVersion(offVersion.spec.openapi)}, so they can't be combined.`,
    };
  }

  // Every surface reads the root `servers` (MCP strips the rest), so differing servers means separate APIs.
  const withServers = inputs.filter((i) => serverUrls(i.spec).length);
  const offServers = withServers.find((i) => canonical(serverUrls(i.spec)) !== canonical(serverUrls(withServers[0].spec)));
  if (offServers) {
    return {
      ok: false,
      error: `${withServers[0].label} and ${offServers.label} point at different servers, which makes them separate APIs.`,
      detail: `${serverUrls(withServers[0].spec).join(', ')} vs ${serverUrls(offServers.spec).join(', ')}. Set each one up as its own API instead.`,
    };
  }

  const prefixes = new Set();
  const prepared = inputs.map((input, i) => {
    const wanted = prefixFor(input.label, input.spec, i);
    let prefix = wanted;
    for (let n = 2; prefixes.has(prefix); n++) prefix = `${wanted}${n}`;
    prefixes.add(prefix);
    return { ...input, spec: clone(input.spec), prefix };
  });

  const out = prepared[0].spec;
  out.paths = isObject(out.paths) ? out.paths : {};
  out.components = isObject(out.components) ? out.components : {};
  // Operations by input, collected before merging, since `out` is also input 0's own doc.
  const owner = new Map();
  forEachOperation(out, (op) => owner.set(op, prepared[0]));
  const renamed = [];
  const conflicts = [];

  for (const input of prepared.slice(1)) {
    const renames = planRenames(out, input.spec, input.prefix);
    for (const [section, map] of Object.entries(renames)) {
      for (const [from, to] of map) renamed.push({ file: input.label, section, from, to });
    }
    const spec = rewriteRefs(input.spec, renames);
    forEachOperation(spec, (op) => owner.set(op, input));

    for (const section of COMPONENT_SECTIONS) {
      if (!isObject(spec.components?.[section])) continue;
      out.components[section] ??= {};
      for (const [name, def] of Object.entries(spec.components[section])) {
        out.components[section][name] ??= def;
      }
    }

    for (const group of ['paths', 'webhooks']) {
      if (!isObject(spec[group])) continue;
      out[group] ??= {};
      for (const [key, item] of Object.entries(spec[group])) {
        if (!isObject(item)) continue;
        const existing = out[group][key];
        if (!existing) { out[group][key] = item; continue; }
        if (!sameShape(existing.parameters, item.parameters)) {
          pushDownParameters(existing, out);
          pushDownParameters(item, spec);
        }
        for (const [field, value] of Object.entries(item)) {
          if (!HTTP_METHODS.has(field.toLowerCase())) { existing[field] ??= value; continue; }
          if (existing[field] === undefined) { existing[field] = value; continue; }
          conflicts.push(`${field.toUpperCase()} ${key} is in both ${owner.get(existing[field]).label} and ${input.label}`);
        }
      }
    }

    if (Array.isArray(spec.tags)) {
      out.tags = Array.isArray(out.tags) ? out.tags : [];
      const names = new Set(out.tags.map((t) => t?.name));
      for (const tag of spec.tags) if (tag?.name && !names.has(tag.name)) { out.tags.push(tag); names.add(tag.name); }
    }
  }

  if (conflicts.length) {
    return {
      ok: false,
      error: conflicts.length === 1
        ? `${conflicts[0]}, so we can't tell which one is right.`
        : `${conflicts.length} endpoints are defined in more than one spec, so we can't tell which is right.`,
      detail: conflicts.slice(0, 5).join('\n') + (conflicts.length > 5 ? `\n...and ${conflicts.length - 5} more` : ''),
    };
  }

  // A root `security` only holds when every input agrees; otherwise each input's moves onto its operations.
  if (new Set(prepared.map((i) => canonical(i.spec.security))).size > 1) {
    for (const [op, input] of owner) {
      if (Array.isArray(input.spec.security)) op.security ??= clone(input.spec.security);
    }
    delete out.security;
  }
  if (withServers.length && !out.servers) out.servers = withServers[0].spec.servers;
  if (!Object.keys(out.components).length) delete out.components;

  return { ok: true, spec: out, renamed };
}

// Writes only `destFile`: the combined copy is ours to overwrite, while every
// input stays the developer's and is only ever read.
export async function combineSpecFiles({ rootDir, paths, destFile }) {
  const inputs = [];
  for (const rel of paths) {
    const res = await loadSpecFile(path.resolve(rootDir, rel), rel);
    if (!res.ok) return res;
    inputs.push({ label: rel, spec: res.spec });
  }
  const res = combineSpecs(inputs);
  if (!res.ok) return res;

  const body = `${JSON.stringify(res.spec, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_OAS_BYTES) {
    const mb = (n) => `${(n / 1024 / 1024).toFixed(1)}MB`;
    return { ok: false, error: `Combined, these specs come to ${mb(bytes)}, over the ${mb(MAX_OAS_BYTES)} Restless accepts.` };
  }
  const abs = path.resolve(rootDir, destFile);
  safeMkdirSync(path.dirname(abs), { recursive: true });
  safeWriteFileSync(abs, body);
  let operations = 0;
  forEachOperation(res.spec, () => { operations++; });
  return { ok: true, oasFile: destFile, paths, operations, renamed: res.renamed };
}

// Specs under an API's directory, repo-relative. Our own `.restless/` copies are
// excluded, or a combined spec would be offered as an input to itself.
export function combinableSpecs({ rootDir, apiRootDir = '.' }) {
  return findOasCandidates(path.resolve(rootDir, apiRootDir))
    .map((c) => path.relative(rootDir, c.absolutePath))
    .filter((rel) => !rel.split(path.sep).includes('.restless'));
}

// One line, because the picker's redraw math counts exactly one row per hint.
export function summarizeSpecList(paths, max = 3) {
  if (paths.length <= max) return paths.join(', ');
  return `${paths.slice(0, max).join(', ')} and ${paths.length - max} more`;
}

export function describeRenames(renamed) {
  return renamed.map((r) => `Renamed ${r.from} in ${r.file} to ${r.to}, since another spec defines ${r.from} differently.`);
}
