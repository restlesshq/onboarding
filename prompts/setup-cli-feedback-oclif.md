## Task: add a `feedback` command to an oclif CLI

The CLI `{{cliName}}` (run as `{{bin}}`) lives in `{{cliDir}}`. It's built on oclif. Add the `feedback` command to it by registering the `{{sdkPackage}}` package as an oclif plugin, so its users, and the coding agents driving it, can send a note to the API's maintainers. Notes go to the Restless project `{{project}}`.

{{installNote}}

### Rules

- **Never read `.env*` files, or anything inside `node_modules/`.** Nothing you need is there.
- Only change the files named below. Don't reformat, reorder or "tidy" anything else.
- Don't add a write key, an API key or any other secret. The plugin needs only the project slug.

### 1. Register the plugin

In `{{cliDir}}/package.json`:

- Add `"{{sdkPackage}}"` to the `oclif.plugins` array. If `oclif` has no `plugins` array, create one. Keep every existing entry, in its existing order.
- Add a top-level `restless` block naming the project and the plugin commands this CLI opts into:

  ```json
  "restless": { "project": "{{project}}", "commands": ["feedback"] }
  ```

  If a `restless` block already exists, set its `project` to `{{project}}`, add `"feedback"` to its `commands` list if the list exists and lacks it, and keep every other key and entry. The plugin adds only the commands named in `commands`.

Edit the JSON in place, keeping the file's existing indentation. Make sure it still parses (`node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"`).

### 2. Make it discoverable

If the CLI's README lists its commands, add `feedback` there in the same style, with one example:

```
{{bin}} feedback --message "the --since flag ignores timezones"
```

oclif generates the help text itself, so there is nothing to add for `{{bin}} help`.

### 3. Check your work

- If the CLI has a build step (`build`, `prepack` or `compile` in `package.json` scripts), you don't need to run it. oclif loads plugins from `package.json` at runtime.
- Don't run the new command: it would send a real note to the maintainers.

Finish with two or three plain sentences: which files you changed, and that `{{bin}} feedback --message "..."` is the command to try.
