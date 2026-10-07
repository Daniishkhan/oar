// Bundles src/cli.ts into one executable ESM file. `pnpm install:local` links it to ~/.local/bin/oar.
import { chmod } from 'node:fs/promises'
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  outfile: 'dist/oar.mjs',
  packages: 'bundle',
  sourcemap: 'inline',
  logLevel: 'info',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
})
await chmod('dist/oar.mjs', 0o755)
