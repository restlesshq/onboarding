# Telemetry

`npx restless` sends anonymous usage data so we can see which commands people
run, how often setup works, and where it goes wrong. It is on by default and
takes one command to turn off.

Nothing it sends can identify you, your machine, or your code.

## Turning it off

```sh
npx restless telemetry disable
```

That writes your choice to `~/.restless/config.json` and it sticks for every
future run. To turn it back on, `npx restless telemetry enable`.

For a single run, or for a CI image where you would rather not store a config
file, set either of these instead:

```sh
RESTLESS_TELEMETRY_DISABLED=1   # ours
DO_NOT_TRACK=1                  # the cross-tool convention; we honor it
```

To see where you stand and which of those rules is winning:

```sh
npx restless telemetry status
```

## Seeing exactly what would be sent

```sh
RESTLESS_TELEMETRY_DEBUG=1 npx restless init
```

Prints the payload to stderr, prefixed `[telemetry]`, and sends **nothing**.
This is the honest answer to "what do you actually collect" — it is the same
payload the CLI would have sent, not a description of it.

## What it collects

One request per run, at the end of the run. Roughly a kilobyte.

| | |
| --- | --- |
| Which command | `init`, `update`, `context`… Anything we don't recognize is reported as `unknown`. |
| Which flags | Flag *names* only, from a fixed list, and only the ones that change what the CLI does. |
| How it ended | `ok`, `error` or `interrupted`, plus the exit code and an error *code* if there was one. |
| How long it took | Total, and a breakdown by category: AI, package installs, network, scanning, waiting on you, animation. |
| How far setup got | For `init`: whether each of the three middle steps — mapping your API, installing the SDK, testing — started, finished, or failed, and how long each took. |
| About your project | Language, framework, and how the spec was obtained — each from a fixed list, anything else reported as `other`. |
| About the machine | CLI version, OS, Node version, whether `CI` is set, and whether a human or a coding agent ran the command. |
| Two random IDs | One per machine, one per run. Both randomly generated — see below. |

## What it never collects

This list is enforced by the code, not by policy. Everything that leaves is
checked against a fixed list of permitted values first, so an unrecognized
value is reported as `other` rather than passed through.

- environment variables, names or values
- **file paths** — including your working directory, repo name, and git remotes
- file contents, your OpenAPI spec, or any fragment of either
- AI prompts, AI responses, or anything a model wrote
- error messages, stack traces, or HTTP response bodies
- your hostname or username
- your `RESTLESS_KEY`, setup keys, CLI tokens, or request IDs
- project IDs or account IDs

The two IDs are randomly generated UUIDs. The per-machine one is stored in
`~/.restless/config.json` and is **not** derived from your hostname, username,
MAC address, or working directory — so it counts machines without being able to
name one. Delete that file and you become a new machine.

Telemetry is not linked to your Restless account. There is no project ID in the
payload and the endpoint is unauthenticated, so this data cannot be joined back
to you even by us.

## How this relates to `--debug`

Different thing. `npx restless <command> --debug` uploads a full diagnostic log
of one run, on purpose, when you are asking us for help with it. That log is
detailed — it contains file paths and the contents of what the AI did — which is
exactly why it is opt-in, one run at a time, and never sent unless you pass the
flag.

Telemetry is the opposite trade: always on, but only ever counts and categories.

## Where it goes

`POST https://app.restless.ai/api/telemetry`, once, with a 1.5-second timeout.
If it fails, times out, or you are offline, the CLI ignores it silently and
carries on — telemetry is never allowed to slow down, block, or break a run.
