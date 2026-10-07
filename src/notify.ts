import { type Exec } from './exec.js'
import { localHerdr } from './herdr.js'

export interface Notice {
  title: string
  body: string
  sound?: 'done' | 'request' | 'none'
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

/** macOS notification + Herdr toast (when Herdr is around). Failures are ignored on purpose. */
export async function notify(exec: Exec, n: Notice): Promise<void> {
  const script = `display notification "${esc(n.body.slice(0, 240))}" with title "${esc(n.title.slice(0, 80))}"${
    n.sound && n.sound !== 'none' ? ' sound name "Glass"' : ''
  }`
  await exec.run('osascript', ['-e', script], { timeoutMs: 10_000 }).catch(() => undefined)
  await localHerdr.notify(exec, n.title, n.body, n.sound ?? 'done').catch(() => undefined)
}
