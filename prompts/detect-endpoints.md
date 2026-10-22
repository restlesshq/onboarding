Discover all APIs in this codebase. You MUST finish within 10 tool calls. Be fast.

The findings below were produced by a deterministic pre-scan that already knows which languages are present. Work with what it found; do not assume the project is any particular language.

**NEVER read .env, .env.local, or any environment/secret files.**

{{findingsSection}}

{{hintSection}}

## Your job

The findings above already include every route our regex could find, every YAML/JSON file whose parsed content has a top-level `openapi` or `swagger` field, and a **Framework signals** block listing, per package, its framework dependencies, the framework calls/types its source actually uses, whether it's OAS-capable, and how many inline routes matched. Treat them as authoritative - you do NOT need to re-run that search. Just synthesize them into the output JSON.

## Step 1 - Confirm the project shape (0–1 tool calls)

Use the **Framework signals** block in the findings to identify each package's framework - it already lists the deps and the source markers (`fastify()`, `express()`, `FastifyInstance`, `fastify.routing()`, etc.). Only read a `package.json` yourself if a package is ambiguous or missing from that block.

Determine the framework **per package, from the code that handles requests - not just the first dependency listed.** A single package often depends on more than one HTTP library. In particular:

- If a package builds a **Fastify** server (imports `fastify` / `@fastify/*`, calls `fastify(...)` / `fastifyModule(...)`, uses `.register(...)`, `.addHook(...)`, or `FastifyInstance`) and a separate Express layer only forwards into it (e.g. `fastify.routing(req, res)`, or an `express.Router()` that delegates), the framework is **Fastify**. The Express piece is a host shim, not the API framework.
- The same logic applies to NestJS (`@nestjs/*`), Koa, and Hono wrapped by an outer host.

The findings' **Framework signals** block is labelled per language when more than one is present. A repo can legitimately hold, say, a Django API and a Next.js frontend; emit one API per real API, not one per repo.

## Step 2 - Grep for routes when findings are empty OR a framework is under-represented (0–2 tool calls)

The pre-scan regex only catches **inline string-literal routes** like `app.get('/x')`. It misses common Fastify/Nest patterns: route modules registered with `fastify.register(routesFn, { prefix })`, `fastify.route({ method, url })`, schema/contract-driven routes, and helper-registered routes where the method binds to a **variable** path (e.g. `getAPIs(instance, '/')` -> `fastify.get(path, ...)` inside the helper). So a package can have a real API and still show **zero endpoints in the findings**.

Explore further if EITHER:
1. findings are empty, OR
2. a package in the **Framework signals** block has a server framework (deps or markers like `fastify()` / `FastifyInstance`) but a low "inline routes matched" count - that mismatch is the signature of a route style our regex doesn't cover. (E.g. a package showing `fastify`, `@fastify/swagger`, `fastify()` markers but only a handful of matched routes almost certainly has many more.)

When you explore, read that package's **server entry** - the file that calls `.register(...)` / attaches the route modules - and enumerate endpoints from there, combining each `{ prefix }` with the paths inside. As a fallback, run Grep with:
```
((app|router|fastify|api|server|instance)\.(get|post|put|delete|patch|all|route)\(|@(Get|Post|Put|Delete|Patch|Controller)\()
```
Glob: `*.{js,ts,mjs,cjs}`. Use `output_mode: "content"`.

For a **Python** package, read the module that builds the app instead. Routes live in decorators (`@app.get("/pets")`, `@router.post(...)`), in a Django URLconf (`urlpatterns` with `path()` / `re_path()`, often only `include()`ing others), or in a Starlette route table. A package with a framework dep and zero matched routes is the signature of a route style the regex does not cover, exactly as it is in JavaScript.

## Step 2b - If there is no API here, say what the repo is instead

A repo can have a `package.json` and some JavaScript and still not be an API: a documentation site (Docusaurus, VitePress, Mintlify, MkDocs, a ReadMe docs sync), a frontend with no server, a client library or SDK, or a CLI. If after Step 2 you have found no server handling HTTP requests, do not invent one from folder names, route-like strings in prose, or a static site's own dev server. Return an empty `apis` array and set `repoKind` to what the repo actually is. A static-site generator that does serve API routes (Next.js `pages/api`, Astro endpoints) is an `api`.

## Step 3 - Group endpoints into APIs

If all endpoints come from a single directory / single package.json, emit one API. In a monorepo with multiple package.json files, emit one API per package that has its own endpoints - use `rootDir` relative to the repo root.

## Step 4 - Output JSON

Output ONLY this JSON block - no explanation before or after:
```json
{
  "repoKind": "api",
  "repoKindReason": "Fastify server in src/server.ts handles the routes below",
  "apis": [
    {
      "name": "Public API",
      "rootDir": ".",
      "framework": "Fastify",
      "language": "javascript",
      "existingOasFile": null,
      "frameworkCanGenerateOas": false,
      "endpoints": ["GET /pets", "POST /pets", "GET /pets/:id"],
      "internalEndpoints": ["GET /health", "GET /admin/users"]
    }
  ]
}
```

`repoKind` is one of `"api"`, `"docs"`, `"frontend"`, `"library"`, `"empty"` or `"unknown"`, and `repoKindReason` is one short sentence naming the evidence. When `apis` is non-empty, `repoKind` is `"api"`. When it is empty, the kind is what the user sees, so be specific: "Docusaurus site, 140 Markdown pages under docs/, no server" beats "no API found".

Set `language` to `"javascript"`, `"typescript"` or `"python"`, matching the package the endpoints actually came from. The findings label each framework signal with its language when more than one is present; otherwise use the file extensions. Getting this wrong sends the installer at the wrong SDK, so prefer the signal over a guess.

For `existingOasFile`: pick the best candidate from the findings list. Prefer shallower paths and OpenAPI 3.x over Swagger 2.0. Set to `null` if none.

## Internal endpoint signals
Paths containing: `/internal/`, `/admin/`, `/_/`, `/debug/`, `/health`, `/metrics`, `/status`. Files named `admin` or `internal`.

## OAS generation support
Set `frameworkCanGenerateOas: true` when the package's entry in the **Framework signals** block is marked OAS-capable (e.g. `OAS-capable via @fastify/swagger`), or if you otherwise see one of these imports in files you already read: `@fastify/swagger`, `@nestjs/swagger`, `swagger-jsdoc`, `tsoa`, `express-openapi`. In Python the equivalents are `fastapi` (which serves `/openapi.json` itself), `apiflask`, `flask-smorest`, `drf-spectacular`, `drf-yasg`, `connexion` and `django-ninja`. Don't search separately.
