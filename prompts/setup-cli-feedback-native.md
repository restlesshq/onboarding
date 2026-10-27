## Task: add a `feedback` command to a {{languageLabel}} CLI

The CLI `{{cliName}}` (run as `{{bin}}`) lives in `{{cliDir}}`. It's written in {{languageLabel}}. Add a `feedback` command to it, so its users, and the coding agents driving it, can send a note to the API's maintainers. Notes go to the Restless project `{{project}}`, by a direct HTTPS call described below. There is no package to install.

{{installNote}}

### Rules

- **Never read `.env*` files, or anything inside {{neverRead}}.** Nothing you need is there.
- The command must feel like every other command in this CLI. Copy its patterns: how commands are registered, how flags are parsed, how help is generated, how output and errors are printed, how exit codes are set.
- {{httpClient}}
- Send nothing the user didn't type: no environment variables (other than the one override below), file contents, command history or machine identifiers.
- Don't add a write key, an API key or any other secret. The endpoint needs only the project slug, which is already in the URL.
- Don't intercept the CLI's other HTTP calls or capture request ids automatically.
- The feedback command must never crash the CLI. Catch every network and parsing error and turn it into one of the messages below.

### 1. The API call

```
POST {{endpoint}}
Content-Type: application/json
User-Agent: {{cliName}}/<this CLI's version> restless-cli/{{language}}

{"message": "...", "context": "...", "email": "...", "requestIds": ["..."]}
```

- Keep the URL as a constant in the CLI's source. If the environment variable `RESTLESS_FEEDBACK_URL` is set and non-empty, post to that exact URL instead (it exists for local testing).
- `message` is required. Leave out `context`, `email` and `requestIds` when they're empty. The server keeps the first 4,000 characters of the message, the first 2,000 of the context, and the first 10 request ids.
- The `User-Agent` must START with `{{cliName}}/<version>`: the dashboard labels each note with that first token. It must END with the literal token `restless-cli/{{language}}`, exactly as written, which marks the note as sent by a CLI. {{versionHint}}
- Time the request out after 10 seconds.

Print exactly one line for the outcome, worded for whoever ran the command:

| response | line | exit |
| --- | --- | --- |
| `201` | `Feedback sent to this API's maintainers. Thanks!` | 0 |
| `400` | `The feedback was rejected: <error>` (the JSON body's `error`, if any) | 1 |
| `404` | `This CLI's Restless project wasn't found. Its maintainers need to check the configured project slug.` | 1 |
| `413` | `That is too long to send. Keep the message and context under 32KB together.` | 1 |
| `429` | `Too many notes from this machine. Try again in <n> seconds.` (`n` from the `Retry-After` header, or "a minute") | 1 |
| timeout, DNS failure, refused connection | `Couldn't reach the feedback server. Check your connection and try again.` | 1 |
| any other status | `The feedback server returned <status>. Your note was not saved.` | 1 |

### 2. The command

Name it `feedback`, with this one-line summary in the help: "Tell this API's maintainers what confused you."

Flags, in the CLI's own flag style:

| flag | meaning |
| --- | --- |
| `--message`, `-m` | The note. The value `-` means read it from stdin. |
| `--context` | What the user was doing: the command, the endpoint. |
| `--email` | A reply address. Optional. Reject one that doesn't look like `name@host.tld` before sending. |
| `--request-id` | The `x-request-id` of a call the note is about. Repeatable, collected into `requestIds`. |

If the CLI has a global `--json` convention, honor it: print `{"ok": <bool>, "message": "<the line>"}`.

When `--message` is missing:

- **In an interactive terminal** ({{ttyCheck}}, and `--json` is off): ask "What should this API's maintainers know?" on stderr, then offer an optional email.
- **Otherwise**: exit 2 with an error saying to pass `--message`. Never prompt when stdin isn't a terminal, because a script or an agent would hang waiting for an answer.

Exit `0` on success, `1` when the note wasn't saved, and `2` for usage errors.

### 3. Make it discoverable

Add `feedback` wherever the CLI lists its commands: the help listing, and the README's command list if it has one, with one example: `{{bin}} feedback --message "the --since flag ignores timezones"`.

### 4. Check your work

- {{testHint}}
- Build the CLI and run its existing tests, if it has them, and fix what you broke.
- Leave nothing behind from checking your work: delete any binary, compiled file (`.pyc`, `.class`) or build output you created that the repository doesn't already track or ignore.
- Don't run the new command against the real server: it would send a real note to the maintainers.

Finish with two or three plain sentences: which files you changed, and that `{{bin}} feedback --message "..."` is the command to try.
