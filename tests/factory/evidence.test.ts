import { describe, expect, it } from 'vitest'
import { ConfigSchema, DEFAULT_CONFIG } from '../../src/config.js'
import {
  effectiveConfig,
  factoryConfigProblems,
  factoryDeploy,
  factorySetup,
  runEvidence,
} from '../../src/commands/factory.js'
import { FactoryDb } from '../../src/factory/db.js'
import { world } from '../helpers.js'

/** A repo the shipped defaults know nothing about, so the backfill cannot complete it. */
const incomplete = () =>
  ConfigSchema.parse({
    ...DEFAULT_CONFIG,
    repos: {
      other: {
        ...DEFAULT_CONFIG.repos.engine,
        github: 'o/other',
        verifyWorkflow: undefined,
        reviewEnvName: undefined,
      },
    },
    factory: {
      ...DEFAULT_CONFIG.factory,
      linear: { ...DEFAULT_CONFIG.factory.linear, teams: { ENG: 'other' } },
    },
  })

describe('factory rollout configuration', () => {
  it('ships complete defaults, and requires verification and a review environment for a new repo', () => {
    expect(factoryConfigProblems(ConfigSchema.parse(DEFAULT_CONFIG))).toEqual([])
    const errors = factoryConfigProblems(incomplete())
    expect(errors.some((e) => e.includes('verifyWorkflow'))).toBe(true)
    expect(errors.some((e) => e.includes('reviewEnvName'))).toBe(true)
  })

  it('validates the config as deploy would ship it, after the backfill, without storing it', () => {
    const stored = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repos: {
        engine: {
          ...DEFAULT_CONFIG.repos.engine,
          deliveryMode: undefined,
          requiredChecks: [],
          reviewEnvName: 'engine-review',
        },
      },
      factory: {
        ...DEFAULT_CONFIG.factory,
        linear: { ...DEFAULT_CONFIG.factory.linear, teams: { ENG: 'engine' } },
      },
    })
    expect(stored.repos.engine).toMatchObject({ deliveryMode: 'staging', requiredChecks: [] })
    expect(factoryConfigProblems(stored)).toEqual([])
    expect(effectiveConfig(stored).notes).toEqual([
      'engine.requiredChecks = Verify, Integration tests, End-to-end tests, Package and drive the desktop app',
    ])
    expect(stored.repos.engine).toMatchObject({ deliveryMode: 'staging', requiredChecks: [] })
  })

  it('rejects incomplete setup and deployment before any infrastructure mutation', async () => {
    const w = world({ config: incomplete() })
    for (const command of [factorySetup, factoryDeploy])
      await expect(command(w.ctx)).rejects.toThrow('factory configuration is incomplete')
    expect(w.exec.lines()).toEqual([])
    expect(w.boat.sandboxes.size).toBe(0)
    expect(w.boat.commands).toEqual([])
    expect(w.boat.updates).toEqual([])
  })

  it('accepts a fully configured solo workflow and detects unsafe concurrency/model choices', () => {
    const config = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repos: {
        engine: {
          ...DEFAULT_CONFIG.repos.engine,
          deployWorkflow: 'staging.yml',
          verifyWorkflow: 'verify.yml',
          reviewEnvName: 'engine-review',
        },
      },
      factory: {
        ...DEFAULT_CONFIG.factory,
        linear: { ...DEFAULT_CONFIG.factory.linear, teams: { ENG: 'engine' } },
      },
    })
    expect(factoryConfigProblems(config)).toEqual([])
    config.factory.concurrency.engine = 2
    config.repos.engine!.buildRunner = 'codex'
    expect(factoryConfigProblems(config)).toHaveLength(2)
    config.repos.engine!.buildModel = 'builder-model'
    config.factory.review.model = 'reviewer-model'
    expect(factoryConfigProblems(config)).toHaveLength(1)
  })

  it('does not leak stored authentication state through evidence lookup errors', () => {
    const db = new FactoryDb(':memory:')
    db.setCursor('linear.token', 'private-token')
    expect(() => runEvidence(db, 'ENG-1')).toThrow("no factory issue 'ENG-1'")
    db.close()
  })
})
