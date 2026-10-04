/**
 * tsup build config for `@amdahl/cli`.
 *
 * One self-contained file, `dist/amdahl.js`, so the packed tarball has zero
 * runtime dependencies: `noExternal` bundles everything into the output. Node
 * built-ins stay external. `.md` files (the bundled skill) load as text. The
 * banner is the shebang that makes the file runnable as the `amdahl` bin.
 */
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { amdahl: 'src/bin.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  dts: false,
  noExternal: [/.*/],
  loader: { '.md': 'text' },
  banner: { js: '#!/usr/bin/env node' },
})
