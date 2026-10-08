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
  it('brings a stored config up to the shipped delivery defaults without touching unknown repos', () => {
    const stored = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repos: {
        engine: {
          ...DEFAULT_CONFIG.repos.engine!,
          baseBranch: 'release',
          requiredChecks: [],
          deliveryMode: undefined,
          deployWorkflow: undefined,
          verifyWorkflow: undefined,
          reviewEnvName: undefined,
        },
        cno: {
          ...DEFAULT_CONFIG.repos.cno!,
          baseBranch: 'main',
          deployWorkflow: undefined,
          verifyWorkflow: undefined,
          reviewEnvName: undefined,
          requiredChecks: [],
          protectedPaths: undefined,
        },
        other: { ...DEFAULT_CONFIG.repos.engine!, baseBranch: 'trunk', requiredChecks: [] },
      },
    })
    expect(backfillRepoDefaults(stored)).toEqual([
      'engine.deployWorkflow = staging.yml',
      'engine.baseBranch release → dev',
      'engine.verifyWorkflow = staging-verify.yml',
      'engine.reviewEnvName = oar-review',
      'engine.requiredChecks = Verify, Integration tests, End-to-end tests, Package and drive the desktop app',
      'cno.deployWorkflow = staging.yml',
      'cno.baseBranch main → dev',
      'cno.verifyWorkflow = staging-verify.yml',
      'cno.reviewEnvName = oar-review',
      'cno.requiredChecks = checks',
      'cno.protectedPaths = .github/, AGENTS.md, CLAUDE.md, .claude/, .codex/, Makefile, setup.cfg, pyproject.toml, .pre-commit-config.yaml, deploy/local/compose.test.yml',
    ])
    expect(stored.repos.cno).toMatchObject({
      baseBranch: 'dev',
      deployWorkflow: 'staging.yml',
      verifyWorkflow: 'staging-verify.yml',
      reviewEnvName: 'oar-review',
      requiredChecks: ['checks'],
      deliveryMode: 'staging',
    })
    expect(stored.repos.engine).toMatchObject({
      baseBranch: 'dev',
      deliveryMode: 'staging',
      deployWorkflow: 'staging.yml',
      verifyWorkflow: 'staging-verify.yml',
      reviewEnvName: 'oar-review',
    })
    expect(stored.repos.other).toMatchObject({ baseBranch: 'trunk', requiredChecks: [] })
    expect(backfillRepoDefaults(stored)).toEqual([])
    expect(backfillRepoDefaults(ConfigSchema.parse(DEFAULT_CONFIG))).toEqual([])
  })
  it('never overwrites explicit workflow, environment or delivery choices', () => {
    const stored = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repos: {
        engine: {
          ...DEFAULT_CONFIG.repos.engine!,
          deliveryMode: 'merge',
          deployWorkflow: 'deploy.yml',
          verifyWorkflow: 'verify.yml',
          reviewEnvName: 'mine',
        },
      },
    })
    expect(backfillRepoDefaults(stored)).toEqual([])
    expect(stored.repos.engine).toMatchObject({
      deliveryMode: 'merge',
      deployWorkflow: 'deploy.yml',
      verifyWorkflow: 'verify.yml',
      reviewEnvName: 'mine',
    })
  })
  it('defaults the review and merge settings', () => {
    const c = ConfigSchema.parse(DEFAULT_CONFIG)
    expect(c.factory.review).toEqual({
      runner: 'codex',
      isolation: 'sandbox',
      timeoutMinutes: 15,
      maxRounds: 3,
      blocking: ['P0', 'P1'],
    })
    expect(c.factory.holdLabel).toBe('hold')
    expect(c.factory.deliveryTimeoutMinutes).toBe(180)
    expect(c.repos.engine).toMatchObject({
      requiredChecks: [
        'Verify',
        'Integration tests',
        'End-to-end tests',
        'Package and drive the desktop app',
      ],
      deliveryMode: 'staging',
      baseBranch: 'dev',
      deployWorkflow: 'staging.yml',
      verifyWorkflow: 'staging-verify.yml',
      reviewEnvName: 'oar-review',
      buildRunner: 'claude',
    })
    expect(c.repos.cno).toMatchObject({
      autoMerge: true,
      mergeMethod: 'squash',
      requiredChecks: ['checks'],
      deliveryMode: 'staging',
    })
  })
})

describe('delivery configuration', () => {
  it('requires distinct deployment and verification workflows', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        repos: {
          engine: {
            ...DEFAULT_CONFIG.repos.engine,
            deployWorkflow: 'staging.yml',
            verifyWorkflow: 'staging.yml',
          },
        },
      }),
    ).toThrow('verifyWorkflow must be separate')
  })
  it('rejects empty required check names and nonpositive delivery timeouts', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        repos: { engine: { ...DEFAULT_CONFIG.repos.engine, requiredChecks: [''] } },
      }),
    ).toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        factory: { ...DEFAULT_CONFIG.factory, deliveryTimeoutMinutes: 0 },
      }),
    ).toThrow()
  })
})
