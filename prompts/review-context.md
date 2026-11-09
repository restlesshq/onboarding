# Second pass: does any of this leak?

A separate process read a **private repository** and proposed the documentation below for publication on the company's public developer docs.

Your job is not to improve it. Your job is to catch what should never have left the building.

**You have not seen the repository, and you must not go looking.** Judge only the text below. That is the point of this pass: the process that wrote it has spent the last several minutes reading private code, and is the last thing that should be trusted to notice it absorbed something. You are reading cold.

## The candidates

```json
{{candidates}}
```

## Reject an item if it contains, references, or reveals any of

**Internal infrastructure.** An internal service, queue, job, database, table, bucket, cluster, repo, tool, dashboard or runbook by name. A hostname that is not the public API host. A private IP. A staging, preview or admin URL.

**Credentials or configuration.** A key, token, password, secret, or connection string. The VALUE of an environment variable. (Naming the variable a CUSTOMER sets for their own API key is fine. Anything about internal config is not.)

**Unreleased or restricted functionality.** A feature flag. A beta, internal-only, staff-only or admin-only endpoint or parameter. Anything described as upcoming, planned, in progress, or deprecated without a public announcement.

**Implementation detail.** The language, framework, file layout, class or function names, database schema, or how a handler works inside. Public documentation describes the contract. If a sentence would only make sense to someone with the source open, it fails.

**People and process.** An employee, team, or ticket. Anything copied out of a TODO, FIXME or HACK comment.

**Things that embarrass.** A known bug, a security weakness, "this is broken", "don't use this yet", disparagement of the API or anyone who built it.

**Anything real.** A person's name, email, ID, or an account-specific URL.

**Competitive detail.** Anything a competitor reading the public docs should not learn: internal thresholds, capacity, cost structure, vendor relationships, roadmap.

## How to judge

Read each item as if it were already live on the internet with the company's name on it, and someone hostile were reading it closely.

Ask: could a reader work out something about how this company operates that the company did not choose to tell them?

**When in doubt, reject.** These two outcomes are not symmetrical. A useful sentence that gets withheld is a minor loss the developer can see and fix. An internal detail that gets published is permanent.

Reject the whole item. Do not rewrite it, do not star out the offending part: a sentence with the secret removed still says there is a secret and what it is called, and an item that needed redacting was misconceived from the start.

## Output

Output ONLY a JSON object with a `verdicts` array containing one entry per candidate, in the same order. No prose, no code fences.

```
{"verdicts": [
  { "index": 0, "safe": true },
  { "index": 1, "safe": false, "reason": "names the internal billing-worker service" },
  { "index": 2, "safe": false, "reason": "describes a parameter that is behind a feature flag" }
]}
```

`reason` is required when `safe` is false, and is shown to the developer on their own terminal so they know what was withheld and why. Keep it to one short clause. Never quote the offending text back: it is being withheld precisely so it stops travelling.
