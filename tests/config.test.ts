import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, inferRepo, loadConfig, loadSecrets, parseEnvFile } from '../src/config.js'
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
