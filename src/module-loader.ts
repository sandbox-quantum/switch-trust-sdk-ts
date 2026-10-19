import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const _require = createRequire(import.meta.url);

export function loadModule(name: string): unknown {
  return _require(name);
}

// Reads a dependency's version from its package.json. The provider SDKs neither
// re-export a VERSION from their main entry nor allow importing
// `<pkg>/package.json` directly (blocked by the `exports` field), so resolve the
// package's entry point and walk up to the owning package.json instead.
export function loadModuleVersion(name: string): string | null {
  let dir: string;
  try {
    dir = dirname(_require.resolve(name));
  } catch {
    return null;
  }
  let prev = '';
  while (dir !== prev) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      // Guard on the name so a nested dist/package.json (which often omits both
      // name and version) doesn't short-circuit the walk to the real manifest.
      if (pkg.name === name && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // No readable package.json here — keep walking up.
    }
    prev = dir;
    dir = dirname(dir);
  }
  return null;
}
