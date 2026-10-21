import fs from 'fs';
import path from 'path';

/**
 * How to spawn `command` so it works on Windows too.
 *
 * npm, RubyGems, Poetry and friends install their executables on Windows as
 * `.cmd` / `.bat` shims, and Node refuses to spawn those without a shell: the
 * call fails with ENOENT (EINVAL since Node 20.12). Every probe here caught
 * that and read it as "not installed", so a Ruby user with the gem in place
 * halted at "could not verify the install", and `codex` never started.
 *
 * Resolves the command on PATH the way cmd.exe does (PATHEXT, in order). A
 * shim is run through cmd.exe with the line pre-quoted; anything else - a real
 * .exe, or any command on a POSIX host - is returned untouched, so the caller
 * keeps `execFileSync`'s no-shell argument handling.
 *
 * `platform` and `env` are injectable so the Windows branch has tests that run
 * on every CI host.
 */
export function spawnSpec(command, args = [], { platform = process.platform, env = process.env } = {}) {
  const passthrough = { file: command, args, options: {} };
  if (platform !== 'win32') return passthrough;
  const resolved = resolveOnPath(command, env);
  if (!resolved || !/\.(cmd|bat)$/i.test(resolved)) return passthrough;
  const line = [resolved, ...args].map(quoteForCmd).join(' ');
  return {
    file: env.ComSpec || 'cmd.exe',
    // `/d` skips AutoRun, `/s` keeps the outer quotes as one command line.
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  };
}

/** The file cmd.exe would run for a bare command name, or null. */
export function resolveOnPath(command, env = process.env) {
  // An explicit path or extension is the caller's business.
  if (path.extname(command) || /[\\/]/.test(command)) return null;
  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  for (const dir of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {}
    }
  }
  return null;
}

function quoteForCmd(arg) {
  const s = String(arg);
  return s === '' || /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s;
}
