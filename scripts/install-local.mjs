import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--home' || !args[1])) {
  console.error('Usage: node scripts/install-local.mjs [--home DIRECTORY]')
  process.exit(2)
}

const root = fileURLToPath(new URL('../', import.meta.url))
const installHome = args[1] ? resolve(args[1]) : homedir()
const executable = join(root, 'dist', 'oar.mjs')
const bin = join(installHome, '.local', 'bin', 'oar')
const source = join(root, 'skill')
const destinations = [
  join(installHome, '.claude', 'skills', 'oar'),
  join(installHome, '.agents', 'skills', 'oar'),
]

function entry(path) {
  try {
    return lstatSync(path)
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

try {
  if (!existsSync(executable)) throw new Error('Build dist/oar.mjs first with pnpm build')
  const current = entry(bin)
  if (current && !current.isSymbolicLink())
    throw new Error(
      `Refusing to replace ${bin}: it is not a symlink. Move it aside explicitly first.`,
    )
  for (const destination of destinations) {
    const existing = entry(destination)
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new Error(
        `Refusing to replace skill directory ${destination}: it is not a regular directory.`,
      )
  }
  for (const destination of destinations) {
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, force: true, dereference: false })
  }
  mkdirSync(dirname(bin), { recursive: true })
  if (!current || resolve(dirname(bin), readlinkSync(bin)) !== executable) {
    // unlink only a symlink; symlinkSync fails if a regular file appears instead of clobbering it.
    if (current) {
      if (!entry(bin)?.isSymbolicLink())
        throw new Error(`Executable changed during install: ${bin}`)
      unlinkSync(bin)
    }
    symlinkSync(executable, bin)
  }
  console.log(`Linked ${bin} → ${executable}`)
  for (const destination of destinations) console.log(`Installed skill: ${destination}`)
} catch (e) {
  console.error(`Install failed: ${e.message}`)
  process.exitCode = 1
}
