import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import * as telemetry from '../lib/telemetry.js';

/**
 * `schemas/telemetry.schema.json` is the wire contract the dashboard's
 * ingest route is written against, so it has to be the same set of values
 * the CLI can actually emit - in BOTH directions. An enum widened in one
 * place only is how a server quietly starts filing real values under
 * `other`, and how a client starts sending something nobody validates.
 *
 * Same discipline as `tests/settings-schema.test.js`, which keeps
 * `settings.schema.json` honest about `.restless/settings.json`.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas/telemetry.schema.json'), 'utf8'));
const props = schema.properties;

/** Schema enums carry the fallback value (`unknown`/`other`/null) that the code adds on the way out. */
const schemaEnum = (name) => new Set(props[name].enum.filter((v) => v !== null));

describe('the schema and the allowlists agree', () => {
  it('commands', () => {
    expect(schemaEnum('command')).toEqual(new Set([...telemetry.COMMANDS, 'unknown']));
  });

  it('flags', () => {
    expect(new Set(props.flags.items.enum)).toEqual(telemetry.FLAGS);
  });

  it('outcomes', () => {
    expect(new Set(props.outcome.enum)).toEqual(telemetry.OUTCOMES);
  });

  it('error codes', () => {
    expect(schemaEnum('errorCode')).toEqual(telemetry.ERROR_CODES);
  });

  it('steps and their statuses', () => {
    const step = props.steps.items.properties;
    expect(new Set(step.step.enum)).toEqual(telemetry.STEPS);
    expect(new Set(step.status.enum)).toEqual(telemetry.STEP_STATUSES);
    // The error's step reuses the same three, so a funnel query and an error
    // query bucket by the same names.
    expect(schemaEnum('errorStep')).toEqual(telemetry.STEPS);
  });

  it('timing kinds', () => {
    expect(new Set(Object.keys(props.byKind.properties))).toEqual(telemetry.TIMING_KINDS);
  });

  it('languages, frameworks, and spec sources', () => {
    expect(new Set(props.language.enum)).toEqual(new Set([...telemetry.LANGUAGES, 'other']));
    expect(new Set(props.framework.enum)).toEqual(new Set([...telemetry.FRAMEWORKS, 'other']));
    expect(new Set(props.oasSourceKind.enum)).toEqual(new Set([...telemetry.OAS_SOURCE_KINDS, 'other']));
  });

  it('schema version', () => {
    expect(props.schemaVersion.const).toBe(telemetry.SCHEMA_VERSION);
  });
});

describe('the schema describes a real payload', () => {
  it('declares every key the code emits, and nothing it does not', () => {
    telemetry.reset();
    process.env.RESTLESS_TELEMETRY_FORCE = '1';
    telemetry.init({ argv: ['node', 'restless', 'init'] });
    telemetry.recordDetect({ language: 'python', framework: 'flask', oasSourceKind: 'ai' });
    telemetry.recordStep(0, 'done', 100);
    const payload = telemetry.buildPayload({ exitCode: 0, outcome: 'ok' });
    delete process.env.RESTLESS_TELEMETRY_FORCE;

    // `additionalProperties: false` means an undeclared key would be rejected
    // by any validator the server puts in front of this.
    expect(schema.additionalProperties).toBe(false);
    for (const key of Object.keys(payload)) {
      expect(Object.keys(props)).toContain(key);
    }
    for (const key of schema.required) {
      expect(payload).toHaveProperty(key);
    }
  });

  it('bounds the step array at three, matching the step vocabulary', () => {
    expect(props.steps.maxItems).toBe(telemetry.STEPS.size);
    expect(telemetry.STEP_BY_INDEX.length).toBe(telemetry.STEPS.size);
  });

  it('omits the two SETUP_STEPS values that are measured better elsewhere', () => {
    // A guard against someone "completing" the enum later without reading
    // why it is a subset. See the comment on STEPS in lib/telemetry.js.
    expect(telemetry.STEPS.has('welcome')).toBe(false);
    expect(telemetry.STEPS.has('account')).toBe(false);
  });
});
