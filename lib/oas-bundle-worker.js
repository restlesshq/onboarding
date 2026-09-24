// Run by `bundleSpecSync` as a child process: bundles one spec and prints the
// result as JSON, so synchronous callers can use the async bundler.
import { bundleSpec } from './oas-bundle.js';

const [absPath, label] = process.argv.slice(2);
const res = await bundleSpec(absPath, label || absPath).catch((err) => ({
  ok: false,
  error: `Couldn't resolve the $refs in ${label || absPath}.`,
  detail: err.message,
}));
process.stdout.write(JSON.stringify(res));
process.exitCode = res.ok ? 0 : 1;
