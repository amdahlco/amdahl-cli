/**
 * tsup build config for `@amdahl/cli`.
 *
 * One self-contained file, `dist/amdahl.js`, so the packed tarball has zero
 * runtime dependencies: `noExternal` bundles everything into the output. Node
 * built-ins stay external. `.md` files (the bundled skill) load as text. The
 * banner is the shebang that makes the file runnable as the `amdahl` bin, then
 * a real `require`: `yaml` ships CommonJS for Node, and its `require('process')`
 * and `require('buffer')` throw "Dynamic require" in an ESM bundle without it.
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { amdahl: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: false,
  noExternal: [/.*/],
  loader: { '.md': 'text' },
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire } from 'node:module'\nconst require = createRequire(import.meta.url)",
  },
})
