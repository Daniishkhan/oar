import { describe, expect, it } from 'vitest'
import { Jobs } from '../../src/factory/jobs.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise<void>((r) => setImmediate(r))

describe('Jobs', () => {
  it('has() is true while running and clears after', async () => {
    const jobs = new Jobs()
    const d = deferred()
    const p = jobs.run('i1', 'engine', () => d.promise)
    expect(jobs.has('i1')).toBe(true)
    expect(jobs.count('engine')).toBe(1)
    expect(jobs.count('cno')).toBe(0)
    d.resolve()
    await p
    expect(jobs.has('i1')).toBe(false)
    expect(jobs.count('engine')).toBe(0)
  })

  it('a second run for the same issue is a no-op', async () => {
    const jobs = new Jobs()
    const d = deferred()
    let calls = 0
    const p = jobs.run('i1', 'engine', async () => {
      calls++
      await d.promise
    })
    await jobs.run('i1', 'engine', async () => {
      calls++
    })
    d.resolve()
    await p
    expect(calls).toBe(1)
  })

  it('serialises jobs on the same repo', async () => {
    const jobs = new Jobs()
    const order: string[] = []
    const a = deferred()
    const b = deferred()
    const pa = jobs.run('i1', 'engine', async () => {
      order.push('a:start')
      await a.promise
      order.push('a:end')
    })
    const pb = jobs.run('i2', 'engine', async () => {
      order.push('b:start')
      await b.promise
      order.push('b:end')
    })
    await tick()
    expect(order).toEqual(['a:start'])
    expect(jobs.has('i2')).toBe(true)
    a.resolve()
    await tick()
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    b.resolve()
    await Promise.all([pa, pb])
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('lets jobs on different repos interleave', async () => {
    const jobs = new Jobs()
    const order: string[] = []
    const a = deferred()
    const b = deferred()
    const pa = jobs.run('i1', 'engine', async () => {
      order.push('a:start')
      await a.promise
      order.push('a:end')
    })
    const pb = jobs.run('i2', 'cno', async () => {
      order.push('b:start')
      await b.promise
      order.push('b:end')
    })
    await tick()
    expect(order).toEqual(['a:start', 'b:start'])
    b.resolve()
    await pb
    a.resolve()
    await pa
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  it('passes a thrown error to onError and still clears the job', async () => {
    const jobs = new Jobs()
    const errors: Error[] = []
    await jobs.run(
      'i1',
      'engine',
      async () => {
        throw new Error('boom')
      },
      (e) => errors.push(e),
    )
    expect(errors.map((e) => e.message)).toEqual(['boom'])
    expect(jobs.has('i1')).toBe(false)
  })

  it('does not throw without onError and later jobs on the repo still run', async () => {
    const jobs = new Jobs()
    await expect(
      jobs.run('i1', 'engine', async () => {
        throw new Error('boom')
      }),
    ).resolves.toBeUndefined()
    let ran = false
    await jobs.run('i2', 'engine', async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('ageMs uses the injected clock', async () => {
    let t = 1_000
    const jobs = new Jobs(() => t)
    const d = deferred()
    const p = jobs.run('i1', 'engine', () => d.promise)
    t = 4_500
    expect(jobs.ageMs('i1')).toBe(3_500)
    expect(jobs.ageMs('unknown')).toBe(0)
    d.resolve()
    await p
    expect(jobs.ageMs('i1')).toBe(0)
  })

  it('drain waits for running jobs', async () => {
    const jobs = new Jobs()
    const d = deferred()
    let finished = false
    void jobs.run('i1', 'engine', async () => {
      await d.promise
      finished = true
    })
    const drained = jobs.drain().then(() => {
      expect(finished).toBe(true)
    })
    await tick()
    expect(finished).toBe(false)
    d.resolve()
    await drained
  })
})
