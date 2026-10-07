export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const nowIso = () => new Date().toISOString()

export function startOfTodayIso(): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.toISOString()
}

/** "3h 12m", "45m", "20s"; negative durations become "0s". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/** "stops in 3h 12m" | "stopping now" | "never stops" */
export function stopsIn(archiveAfter: Date | string | null | undefined, now = Date.now()): string {
  if (!archiveAfter) return 'never stops'
  const t = typeof archiveAfter === 'string' ? Date.parse(archiveAfter) : archiveAfter.getTime()
  if (Number.isNaN(t)) return 'unknown deadline'
  const ms = t - now
  return ms <= 0 ? 'stopping now' : `stops in ${formatDuration(ms)}`
}

export const hoursFromNow = (hours: number, now = Date.now()) => new Date(now + hours * 3_600_000)

export const minutes = (n: number) => n * 60_000
