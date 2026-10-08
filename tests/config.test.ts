import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  backfillRepoDefaults,
  ConfigSchema,
  DEFAULT_CONFIG,
  inferRepo,
  loadConfig,
  loadSecrets,
  parseEnvFile,
} from '../src/config.js'
import { FakeExec } from './fakes/exec.js'
import { world } from './helpers.js'

describe('config file', () => {
  it('writes the defaults on first load and reads them back', () => {
    const w = world()
    expect(existsSync(w.ctx.paths.configFile)).toBe(false)
    const c = loadConfig(w.ctx.paths)
    expect(c.repos.engine?.vmPath).toBe('/home/user/nodes-engine')
    expect(JSON.parse(readFileSync(w.ctx.paths.configFile, 'utf8'))).toEqual(DEFAULT_CONFIG)
  })
  it('parses env files and reads the key', () => {
    expect(parseEnvFile('# c\nBOAT_API_KEY="boat_x"\nOTHER=1\n')).toEqual({
      BOAT_API_KEY: 'boat_x',
      OTHER: '1',
    })
    const w = world()
    expect(loadSecrets(w.ctx.paths, {}).BOAT_API_KEY).toBe('boat_testkey_0000000000')
  })
})

describe('inferRepo', () => {
  it('maps the origin url to a configured repo', async () => {
    const exec = new FakeExec().on('git remote get-url origin', {
      stdout: 'git@github.com:Ai-Synapse1/Synapse-Django.git\n',
    })
    expect(await inferRepo(DEFAULT_CONFIG, exec, '/x')).toBe('cno')
    const exec3 = new FakeExec().on('git remote get-url origin', {
      stdout: 'git@github.com:Ai-Synapse1/nodes-cno.git\n',
    })
    expect(await inferRepo(DEFAULT_CONFIG, exec3, '/x')).toBe('cno')
    const exec2 = new FakeExec().on('git remote get-url origin', {
      stdout: 'https://github.com/Ai-Synapse1/nodes-engine\n',
    })
    expect(await inferRepo(DEFAULT_CONFIG, exec2, '/x')).toBe('engine')
  })
  it('explains when nothing matches', async () => {
    const exec = new FakeExec().on('git remote get-url origin', {
      stdout: 'git@github.com:x/other.git\n',
    })
    await expect(inferRepo(DEFAULT_CONFIG, exec, '/x')).rejects.toThrow(/--repo/)
  })
})

describe('backfillRepoDefaults', () => {
  it('moves a stored cno config onto dev with the staging workflow, leaving engine alone', () => {
    const stored = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repos: {
        engine: { ...DEFAULT_CONFIG.repos.engine!, baseBranch: 'release' },
        cno: { ...DEFAULT_CONFIG.repos.cno!, baseBranch: 'main', deployWorkflow: undefined },
        other: { ...DEFAULT_CONFIG.repos.engine!, baseBranch: 'trunk' },
      },
    })
    expect(backfillRepoDefaults(stored)).toEqual([
      'cno.deployWorkflow = staging.yml',
      'cno.baseBranch main → dev',
    ])
    expect(stored.repos.cno).toMatchObject({ baseBranch: 'dev', deployWorkflow: 'staging.yml' })
    expect(stored.repos.engine?.baseBranch).toBe('release')
    expect(stored.repos.other?.baseBranch).toBe('trunk')
    expect(backfillRepoDefaults(stored)).toEqual([])
    expect(backfillRepoDefaults(ConfigSchema.parse(DEFAULT_CONFIG))).toEqual([])
  })
  it('defaults the review and merge settings', () => {
    const c = ConfigSchema.parse(DEFAULT_CONFIG)
    expect(c.factory.review).toEqual({
      runner: 'codex',
      timeoutMinutes: 15,
      maxRounds: 3,
      blocking: ['P0', 'P1'],
    })
    expect(c.factory.holdLabel).toBe('hold')
    expect(c.repos.cno).toMatchObject({ autoMerge: true, mergeMethod: 'squash' })
  })
})
