## Task: add a `feedback` command to a Node CLI

The CLI `{{cliName}}` (run as `{{bin}}`) lives in `{{cliDir}}`. It doesn't use oclif. Add a `feedback` command to it, built on the `{{sdkPackage}}` package, so its users, and the coding agents driving it, can send a note to the API's maintainers. Notes go to the Restless project `{{project}}`.

{{installNote}}

### Rules

- **Never read `.env*` files, or anything inside `node_modules/`.** Everything you need about `{{sdkPackage}}` is on this page.
- The command must feel like every other command in this CLI. Copy its patterns; don't introduce a new framework, prompt library or output style.
- Send nothing the user didn't type: no environment variables, file contents, command history or machine identifiers.
- Don't add a write key, an API key or any other secret. The package needs only the project slug.
- Don't intercept HTTP calls or capture request ids automatically.

### 1. Read the CLI first

Before changing anything, find:

- **How commands are registered**: where a command name maps to its handler, how flags are parsed, how help text is generated, and how other commands print output, print errors and set exit codes.
- **The module system.** `{{sdkPackage}}` is ESM only. In an ESM CLI, use a static `import`. In a CommonJS CLI, load it with `await import('{{sdkPackage}}')` inside the handler. Don't convert the CLI to ESM.
- **The Node version floor** (`engines` in `package.json`). The package needs Node 18 or later. If the CLI supports older versions, stop and say so rather than raising the floor.

### 2. The API

```js
import { submitFeedback } from '{{sdkPackage}}';

const result = await submitFeedback({
  // Keep the slug as a constant in the CLI's source.
  project: '{{project}}',
  // This CLI's own name and version.
  client: `${name}/${version}`,
  message,
  // Optional: what the user was doing, a reply address, and x-request-id values.
  context,
  email,
  requestIds,
});
// result is { ok: boolean, line: string, status: number }
```

`submitFeedback` never throws. It resolves the endpoint, validates the input, sends the note and returns `line`, a sentence ready to print to whoever ran the command, whether it succeeded or not. `isEmail(value)` is exported too, for validating an email flag before sending.

Read `client`'s name and version the same way the CLI already reports its own version. If it has no such code, read them from its `package.json`. The dashboard labels each note with this value.

### 3. Add the command

Name it `feedback`, with this one-line summary in the help: "Tell this API's maintainers what confused you."

Flags, in the CLI's own flag style:

| flag | meaning |
| --- | --- |
| `--message`, `-m` | The note. The value `-` means read it from stdin. |
| `--context` | What the user was doing: the command, the endpoint. |
| `--email` | A reply address. Optional. |
| `--request-id` | The `x-request-id` of a call the note is about. Repeatable, collected into `requestIds`. |

If the CLI has a global `--json` convention, honor it: print `{ "ok": result.ok, "message": result.line }`.

When `--message` is missing:

- **In an interactive terminal** (`process.stdin.isTTY` is true and `--json` is off): ask "What should this API's maintainers know?" on stderr, then offer an optional email. Use the prompt library the CLI already has, or `node:readline/promises`.
- **Otherwise**: exit 2 with an error saying to pass `--message`. Never prompt when stdin isn't a terminal, because a script or an agent would hang waiting for an answer.

Exit `0` when `result.ok`, `1` when it isn't, and `2` for usage errors.

### 4. Make it discoverable

- Add `feedback` wherever the CLI lists its commands: the help listing, and the README's command list if it has one, with one example: `{{bin}} feedback --message "the --since flag ignores timezones"`.

### 5. Check your work

- If the CLI has tests for its commands, add one for `feedback` in the same style, passing a stub `fetch` (`submitFeedback` accepts a `fetch` option) so the test never sends a real note.
- Run the CLI's existing tests and type check, if it has them, and fix what you broke.
- Don't run the new command against the real server: it would send a real note to the maintainers.

Finish with two or three plain sentences: which files you changed, and that `{{bin}} feedback --message "..."` is the command to try.
