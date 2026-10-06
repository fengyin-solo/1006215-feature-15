import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

// 写库只允许这一条路：失败自动重试一次，再失败就把原因抛给调用方，
// 内存缓存保持原样，避免页面上两处读到的数对不上。
function persist(payload: Record<string, EntryRow[]>): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  const text = JSON.stringify(payload)
  try {
    window.localStorage.setItem(STORAGE_KEY, text)
  } catch {
    try {
      window.localStorage.setItem(STORAGE_KEY, text)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`本地存储写入失败（已自动重试一次）：${reason}`)
    }
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  persist(next)
  cache = next
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
