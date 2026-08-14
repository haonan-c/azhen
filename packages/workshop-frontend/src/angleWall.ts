const angleWallModules = import.meta.glob('../angle-wall/*.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

const entryFields = [
  'angleName',
  'hypothesis',
  'id',
  'industry',
  'openingHook',
  'platform',
  'producedOn',
  'scriptExcerpt',
  'tension',
] as const

/** One reviewed Angle Wall entry that is included in the static Marketing Landing Page. */
export interface AngleWallEntry {
  id: string
  industry: string
  platform: string
  angleName: string
  tension: string
  hypothesis: string
  openingHook: string
  scriptExcerpt: string
  producedOn: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, field: keyof AngleWallEntry): string | null {
  const value = record[field]
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized || null
}

function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function readEntry(path: string, value: unknown): AngleWallEntry {
  if (!isRecord(value)) throw new Error(`Angle Wall entry ${path} must be an object.`)
  const fields = Object.keys(value).toSorted()
  if (fields.length !== entryFields.length || fields.some((field, index) => field !== entryFields[index])) {
    throw new Error(`Angle Wall entry ${path} has an invalid field set.`)
  }

  const entry = {
    id: readString(value, 'id'),
    industry: readString(value, 'industry'),
    platform: readString(value, 'platform'),
    angleName: readString(value, 'angleName'),
    tension: readString(value, 'tension'),
    hypothesis: readString(value, 'hypothesis'),
    openingHook: readString(value, 'openingHook'),
    scriptExcerpt: readString(value, 'scriptExcerpt'),
    producedOn: readString(value, 'producedOn'),
  }
  if (Object.values(entry).some(field => field === null) || !isDate(entry.producedOn ?? '')) {
    throw new Error(`Angle Wall entry ${path} has an invalid value.`)
  }
  const scriptWordCount = entry.scriptExcerpt?.split(/\s+/u).length ?? 0
  if (scriptWordCount < 80 || scriptWordCount > 120) {
    throw new Error(`Angle Wall entry ${path} must have an 80 to 120 word script excerpt.`)
  }
  const fileId = /\/([^/]+)\.json$/.exec(path)?.[1]
  if (entry.id !== fileId) {
    throw new Error(`Angle Wall entry ${path} must use its id as the file name.`)
  }
  return entry as AngleWallEntry
}

const loadedEntries = Object.entries(angleWallModules)
  .map(([path, value]) => readEntry(path, value))
  .toSorted((left, right) => left.id.localeCompare(right.id))
if (new Set(loadedEntries.map(entry => entry.id)).size !== loadedEntries.length) {
  throw new Error('Angle Wall entry ids must be unique.')
}
if (loadedEntries.length !== 0 && loadedEntries.length !== 12) {
  throw new Error('The Angle Wall must contain either zero entries or the complete set of 12 entries.')
}

/** Every reviewed Angle Wall entry, loaded as data during the frontend build. */
export const angleWallEntries: readonly AngleWallEntry[] = loadedEntries
