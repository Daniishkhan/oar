import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OarError } from './errors.js'

/**
 * Files shipped next to the code (setup/, vm/, templates/, skills/). Both `src/` and `dist/` sit one
 * level below the repo root, and Node resolves the real path of the bundled entry, so `..` works for
 * `tsx src/cli.ts` and for the ~/.local/bin/oar symlink alike.
 */
export const assetsRoot = (): string => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..')
  if (existsSync(join(root, 'setup'))) return root
  throw new OarError(
    'config',
    `cannot find oar assets next to ${here}`,
    'run oar from its checkout or via pnpm install:local',
  )
}

export const assetPath = (...parts: string[]) => join(assetsRoot(), ...parts)
export const readAsset = (...parts: string[]) => readFileSync(assetPath(...parts), 'utf8')
