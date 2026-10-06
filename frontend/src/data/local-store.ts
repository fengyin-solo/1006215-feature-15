import { SEED_ROWS } from './seed'
import {
  ARCHIVED_STATUS,
  OVERHAUL_KEY,
  UNIT_KEY,
  BEARING_KEY,
  GENERATION_KEY,
  stampGenerationRows,
} from './overhaul-domain'
import type { ActionResult, EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'hydropower-plant-om:entries'
// 元数据侧车：存放结构版本、故障注入（验收链路重试用）、完工幂等结果，不与业务数据混放。
const META_KEY = 'hydropower-plant-om:meta'
// 数据结构版本：旧版本数据读入时按此版本迁移，避免新旧字段叠加。
const CURRENT_SCHEMA_VERSION = 2

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

type VersionedStore = {
  version: number
  entries: Record<string, EntryRow[]>
}

type MetaStore = {
  version: number
  faults: Record<string, string>
  idempotency: Record<string, IdempotencyRecord>
}

export type IdempotencyRecord = ActionResult & {
  ticketId: number
  savedAt: string
}

const PLACEHOLDER = /样例\d*$/

function isBlankValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 旧版「工期」是单个日期格；按发生时间迁移时拆成起止两格，缺的一端留空，不编造。 */
function splitPeriod(value: unknown): { start: string; end: string } {
  const text = String(value ?? '').trim()
  if (isBlankValue(text) || PLACEHOLDER.test(text)) {
    return { start: '', end: '' }
  }
  return { start: text, end: text }
}

function occurrenceTime(row: EntryRow): string {
  return String(row['实际开工时间'] ?? row['计划开工'] ?? '').trim()
}

/**
 * 旧版检修工作票迁移：
 * - 计划工期/实际工期拆成起止字段，历史票按计划工期回填；
 * - 早期没有验收人的不虚构，留空后由「缺值单独列示」点名，等人工补记；
 * - 已完工票补归档标记；按发生时间先后落库。
 */
function migrateOverhaulRow(row: EntryRow): EntryRow {
  const plan = splitPeriod(row['计划工期'])
  const actual = splitPeriod(row['实际工期'])
  const rawAcceptor = String(row['验收人员'] ?? '').trim()
  const acceptor = rawAcceptor === '' || PLACEHOLDER.test(rawAcceptor) ? '' : rawAcceptor
  const status = String(row.status ?? '')
  const next: EntryRow = {
    ...row,
    status,
    pending: status !== ARCHIVED_STATUS,
    abnormal: false,
    archived: status === ARCHIVED_STATUS,
    检修机组: PLACEHOLDER.test(String(row['检修机组'] ?? ''))
      ? migrateUnitName(row['检修机组'])
      : String(row['检修机组'] ?? ''),
    计划开工: plan.start,
    计划完工: plan.end,
    实际开工时间: actual.start,
    实际完工时间: actual.end,
    验收人员: acceptor,
    // 旧版没有验收结论字段：有合格验收人才视为当时合格，否则挂空，等补记。
    验收结论: status === ARCHIVED_STATUS && acceptor !== '' ? '合格' : '',
    保留意见: '',
  }
  delete next['计划工期']
  delete next['实际工期']
  delete next['检修状态']
  return next
}

/** 「机组检修样例2」这类占位名统一归一到「2号机组」，与机组台账/导轴承关联得上。 */
function migrateUnitName(value: unknown): string {
  const text = String(value ?? '').trim()
  const matched = text.match(/(\d+)\s*$/)
  return matched ? `${Number(matched[1])}号机组` : text
}

const LEGACY_UNIT_CAPACITY: Record<number, number> = { 1: 300, 2: 300, 3: 150 }

function migrateLegacyStore(raw: Record<string, EntryRow[]>): VersionedStore {
  const entries: Record<string, EntryRow[]> = {}
  for (const [key, rows] of Object.entries(raw)) {
    if (key === OVERHAUL_KEY) {
      entries[key] = (rows as EntryRow[]).map(migrateOverhaulRow).sort((a, b) => {
        const ta = occurrenceTime(a)
        const tb = occurrenceTime(b)
        if (ta === tb) {
          return Number(a.id) - Number(b.id)
        }
        return ta === '' ? 1 : tb === '' ? -1 : ta.localeCompare(tb)
      })
      continue
    }
    if (key === BEARING_KEY) {
      entries[key] = (rows as EntryRow[]).map((row) => ({
        ...row,
        所属机组: PLACEHOLDER.test(String(row['所属机组'] ?? ''))
          ? migrateUnitName(row['所属机组'])
          : String(row['所属机组'] ?? ''),
      }))
      continue
    }
    if (key === UNIT_KEY) {
      entries[key] = (rows as EntryRow[]).map((row) => {
        const next = { ...row }
        if (isBlankValue(next['额定容量(MW)'])) {
          next['额定容量(MW)'] = LEGACY_UNIT_CAPACITY[Number(row.id)] ?? 0
        }
        return next
      })
      continue
    }
    entries[key] = rows as EntryRow[]
  }
  return { version: CURRENT_SCHEMA_VERSION, entries }
}

function freshStore(): VersionedStore {
  const store: VersionedStore = { version: CURRENT_SCHEMA_VERSION, entries: clone(SEED_ROWS) }
  // 播种即回写一次，保证首次打开两处入口取值一致。
  store.entries[GENERATION_KEY] = stampGenerationRows(store.entries)
  return store
}

function writeEntries(store: VersionedStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  }
}

function readStore(): VersionedStore {
  if (typeof window === 'undefined' || !window.localStorage) {
    return freshStore()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const seeded = freshStore()
    writeEntries(seeded)
    // 元数据侧车只在不存在时初始化，不能把外部（故障注入/幂等）已经写入的内容冲掉。
    if (!window.localStorage.getItem(META_KEY)) {
      writeMeta({ version: CURRENT_SCHEMA_VERSION, faults: {}, idempotency: {} })
    }
    return seeded
  }
  try {
    const parsed = JSON.parse(raw) as Partial<VersionedStore> & Record<string, unknown>
    // 新版结构：{ version, entries: { 模块: 行[] } }；旧版直接是 { 模块: 行[] }，没有 entries 字段。
    const isVersioned =
      parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
    const store = isVersioned
      ? (parsed as unknown as VersionedStore)
      : migrateLegacyStore(parsed as unknown as Record<string, EntryRow[]>)
    // 只补齐后来新增的模块：展开顺序保证存储里的业务记录优先，绝不用示例数据覆盖。
    store.entries = { ...clone(SEED_ROWS), ...store.entries }
    store.entries[GENERATION_KEY] = stampGenerationRows(store.entries)
    store.version = CURRENT_SCHEMA_VERSION
    writeEntries(store)
    return store
  } catch {
    const fallback = freshStore()
    writeEntries(fallback)
    return fallback
  }
}

function readMeta(): MetaStore {
  const fallback: MetaStore = { version: CURRENT_SCHEMA_VERSION, faults: {}, idempotency: {} }
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) {
    writeMeta(fallback)
    return fallback
  }
  try {
    return { ...fallback, ...(JSON.parse(raw) as Partial<MetaStore>) }
  } catch {
    writeMeta(fallback)
    return fallback
  }
}

function writeMeta(meta: MetaStore): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
  }
}

let cache: VersionedStore | null = null
// 办理完工业内的一次性恢复标记：落库后断线时置位，重试据此只做幂等确认，不重复办理。
const pendingRecovery = new Set<number>()

export function markCompletionPending(ticketId: number): void {
  pendingRecovery.add(ticketId)
}

export function consumeCompletionPending(ticketId: number): boolean {
  const exists = pendingRecovery.has(ticketId)
  pendingRecovery.delete(ticketId)
  return exists
}

function store(): VersionedStore {
  if (cache === null) {
    cache = readStore()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return store().entries
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const current = store()
  current.entries = { ...current.entries, [key]: rows }
  writeEntries(current)
}

/**
 * 原子地保存工作票并回写发电计划投影：一次构造、一次落库，
 * 避免两次 saveRows 之间被旧引用整体覆盖（验收断线重试时尤其关键）。
 */
export function saveOverhaulAndProject(rows: EntryRow[]): void {
  const current = store()
  const entries: Record<string, EntryRow[]> = { ...current.entries, [OVERHAUL_KEY]: rows }
  entries[GENERATION_KEY] = stampGenerationRows(entries)
  current.entries = entries
  writeEntries(current)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  // 重置任一模块都重新回写投影，保证发电计划与最新工作票对得上。
  const current = store()
  current.entries[GENERATION_KEY] = stampGenerationRows(current.entries)
  writeEntries(current)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function storageMetaKey(): string {
  return META_KEY
}

export function schemaVersion(): number {
  return CURRENT_SCHEMA_VERSION
}

// ── 故障注入与完工幂等：仅供验收链路与自动校验使用 ──────────────────────────────

export function getFault(name: string): string {
  return readMeta().faults[name] ?? ''
}

export function setFault(name: string, mode: string): void {
  const meta = readMeta()
  if (mode === '') {
    delete meta.faults[name]
  } else {
    meta.faults[name] = mode
  }
  writeMeta(meta)
}

export function getIdempotency(key: string): IdempotencyRecord | undefined {
  return readMeta().idempotency[key]
}

export function saveIdempotency(key: string, record: IdempotencyRecord): void {
  const meta = readMeta()
  meta.idempotency[key] = record
  writeMeta(meta)
}

/** 仅供测试：清掉内存缓存，模拟重新进入页面后从 localStorage 重新装载。 */
export function __resetCache(): void {
  cache = null
  pendingRecovery.clear()
}

/** 仅供测试：无视内存缓存，立即从 localStorage 重新装载一遍。 */
export function __reloadFromStorage(): VersionedStore {
  cache = readStore()
  pendingRecovery.clear()
  return cache
}
