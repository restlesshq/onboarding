import { loadBundledOas } from './oas-bundle.js';

/**
 * Load and parse an OAS document from disk. Accepts YAML or JSON.
 * Returns `null` if the file is missing or unparseable.
 */
export function loadOas(oasPath) {
  // Bundled, so a split spec hashes and counts the way the dashboard will see it.
  return loadBundledOas(oasPath);
}

/**
 * Resolve the security requirement for a given (method, path) operation.
 * Per-operation `security` overrides the global `security`. An empty array
 * (`security: []`) explicitly opts out of auth.
 *
 * Returns the first named scheme from the requirement, or `null` if the
 * operation is unauthenticated / the scheme isn't defined.
 *
 * Shape of the return value:
 *   { type: 'bearer' }
 *   { type: 'apiKey', in: 'header'|'query'|'cookie', name: 'X-Api-Key' }
 *   { type: 'basic' }
 *   null
 */
export function getAuthForOperation(oas, method, urlPath) {
  if (!oas?.paths) return null;

  // Match a path key in the OAS against the concrete URL path. Path params
  // like `/pets/{id}` vs. `/pets/1` need a simple template match.
  const operation = findOperation(oas, method, urlPath);

  const requirement = operation?.security ?? oas.security;
  if (!Array.isArray(requirement) || requirement.length === 0) return null;

  const first = requirement[0];
  if (!first || typeof first !== 'object') return null;
  const schemeName = Object.keys(first)[0];
  if (!schemeName) return null;

  const scheme = oas.components?.securitySchemes?.[schemeName];
  if (!scheme) return null;

  if (scheme.type === 'http') {
    const lower = String(scheme.scheme || '').toLowerCase();
    if (lower === 'bearer') return { type: 'bearer' };
    if (lower === 'basic') return { type: 'basic' };
    return null;
  }
  if (scheme.type === 'apiKey') {
    return { type: 'apiKey', in: scheme.in, name: scheme.name };
  }
  return null;
}

function findOperation(oas, method, urlPath) {
  const m = (method || 'GET').toLowerCase();
  const want = normalizePath(urlPath);
  for (const [key, item] of Object.entries(oas.paths)) {
    if (pathMatches(normalizePath(key), want) && item?.[m]) {
      return item[m];
    }
  }
  return null;
}

function normalizePath(p) {
  if (!p) return '';
  const [pathname] = p.split('?');
  return pathname.replace(/\/+$/, '') || '/';
}

function pathMatches(template, concrete) {
  if (template === concrete) return true;
  const t = template.split('/');
  const c = concrete.split('/');
  if (t.length !== c.length) return false;
  for (let i = 0; i < t.length; i++) {
    if (t[i].startsWith('{') && t[i].endsWith('}')) continue;
    if (t[i] !== c[i]) return false;
  }
  return true;
}

/**
 * Format an auth descriptor as the curl fragment needed to satisfy it.
 * Uses the given placeholder for the secret (default `API_KEY_HERE`).
 * Returns an empty string if the descriptor is null.
 */
export function authToCurlFragment(auth, placeholder = 'API_KEY_HERE') {
  if (!auth) return '';
  if (auth.type === 'bearer') return `-H "Authorization: Bearer ${placeholder}"`;
  if (auth.type === 'basic') return `-H "Authorization: Basic ${placeholder}"`;
  if (auth.type === 'apiKey') {
    if (auth.in === 'header') return `-H "${auth.name}: ${placeholder}"`;
    if (auth.in === 'query') return `--url-query "${auth.name}=${placeholder}"`;
    if (auth.in === 'cookie') return `-H "Cookie: ${auth.name}=${placeholder}"`;
  }
  return '';
}

/**
 * Detect whether a curl command already carries the required auth. The
 * check is deliberately permissive - we only want to avoid double-adding
 * something the LLM already produced in a different-but-valid shape.
 */
export function curlHasAuth(curlCmd, auth) {
  if (!auth) return true;
  if (auth.type === 'bearer' || auth.type === 'basic') {
    return /(-H\s+["']?Authorization:)|(--header\s+["']?Authorization:)/i.test(curlCmd);
  }
  if (auth.type === 'apiKey') {
    const nameEsc = escapeRegex(auth.name);
    if (auth.in === 'header' || auth.in === 'cookie') {
      return new RegExp(nameEsc, 'i').test(curlCmd);
    }
    if (auth.in === 'query') {
      return new RegExp(`[?&]${nameEsc}=`, 'i').test(curlCmd);
    }
  }
  return false;
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse a curl command and return the URL path + method so we can look up
 * the OAS operation it targets. Returns `{ method, path }` or `null`.
 */
export function parseCurl(curlCmd) {
  if (!curlCmd) return null;
  const methodMatch = curlCmd.match(/-X\s+(\w+)/) || curlCmd.match(/--request\s+(\w+)/);
  const method = (methodMatch?.[1] || 'GET').toUpperCase();

  // URL is typically the first bare token that looks like http(s):// or starts
  // with a slash. Skip the leading "curl" and any flags with values.
  const urlMatch = curlCmd.match(/\bhttps?:\/\/[^\s"']+/);
  if (!urlMatch) return null;
  try {
    const u = new URL(urlMatch[0]);
    return { method, path: u.pathname };
  } catch {
    return null;
  }
}
