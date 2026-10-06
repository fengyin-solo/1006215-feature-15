import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionPayload,
  ActionResult,
  BearingTodo,
  CapacityInfo,
  EntryRow,
  ModuleMeta,
  OverhaulMigrationResult,
  OverhaulStats,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 检修工作票生命周期：待审批 → 已批准 → 检修中 → 已完工，单向推进，已完工即归档。
const OVERHAUL_KEY = 'overhaul'
const OVERHAUL_FINAL = '已完工'
const ACCEPT_PASS = '合格'
const ACCEPT_RESERVED = '有保留意见'
// 早期已完工票没有验收人的补记口径：记「待补签」并进缺值清单，不虚构人名。
const MISSING_ACCEPTOR = '待补签'

// 存量迁移只跑一次：版本变了才按新版本重跑，重跑也是整批覆盖，不叠加。
const OVERHAUL_MIGRATION_KEY = 'hydropower-plant-om:overhaul-migration'
const OVERHAUL_MIGRATION_VERSION = 'v1'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  if (key === OVERHAUL_KEY) {
    ensureOverhaulMigration()
  }
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  payload: ActionPayload = {},
): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === OVERHAUL_KEY) {
    ensureOverhaulMigration()
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const row = rows[index]
  const current = String(row.status)

  // 同一动作重复提交只生效一次；完工信息允许按最近一次生效的那一版覆盖旧值。
  if (current === target) {
    if (key === OVERHAUL_KEY && action === '办理完工' && hasCompletionPayload(payload)) {
      return overwriteCompletion(meta, rows, index, payload)
    }
    return { ok: false, message: `${meta.entity}已经是「${target}」，重复提交不再生效` }
  }

  // 单向链路：只能从上一步走到下一步，跳级当场退回并指出缺哪一步，终态不回退。
  const chain = checkChain(meta, current, target, action)
  if (!chain.ok) {
    return chain
  }

  if (key === OVERHAUL_KEY && action === '办理完工') {
    return completeOverhaul(meta, rows, index, payload)
  }

  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...row,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  syncStatusField(meta, updated, target)
  return commitRows(meta, key, rows, index, updated, `${meta.entity}已${action}，当前状态「${target}」`)
}

/** 这条记录当前能点哪些动作：只有下一步的动作可用，终态没有动作。 */
export function nextActions(key: string, row: EntryRow): string[] {
  const meta = moduleMeta(key)
  const current = String(row.status)
  return meta.actions.filter((action) => {
    const target = meta.actionTargets[action]
    return meta.statuses[meta.statuses.indexOf(target) - 1] === current
  })
}

function checkChain(meta: ModuleMeta, current: string, target: string, action: string): ActionResult {
  const targetIndex = meta.statuses.indexOf(target)
  const currentIndex = meta.statuses.indexOf(current)
  const predecessor = meta.statuses[targetIndex - 1]
  if (current === predecessor) {
    return { ok: true, message: '' }
  }
  if (currentIndex > targetIndex - 1) {
    if (meta.key === OVERHAUL_KEY && current === OVERHAUL_FINAL) {
      return {
        ok: false,
        message: `已完工的工作票已归档，回不到「${target}」；如需整改请另开工作票`,
      }
    }
    return { ok: false, message: `当前状态「${current}」在「${target}」之后，生命周期不回退` }
  }
  const missingStatus = currentIndex >= 0 ? meta.statuses[currentIndex + 1] : predecessor
  const missingAction = meta.actions.find((item) => meta.actionTargets[item] === missingStatus)
  const missingText = missingAction ? `「${missingAction}」（${missingStatus}）` : `「${missingStatus}」`
  return {
    ok: false,
    message: `跳级操作已退回：当前「${current}」，需先完成${missingText}，才能「${action}」`,
  }
}

function completeOverhaul(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  payload: ActionPayload,
): ActionResult {
  const row = rows[index]
  const parsed = parseCompletionPayload(payload)
  if (!parsed.ok) {
    return parsed
  }
  const { acceptor, conclusion, reserved, finishedAt } = parsed
  if (conclusion === ACCEPT_PASS) {
    const finished = finishedAt || today()
    const updated: EntryRow = {
      ...row,
      status: OVERHAUL_FINAL,
      pending: false,
      abnormal: false,
      验收人员: acceptor,
      验收结论: ACCEPT_PASS,
      保留项: '',
      实际完工时间: finished,
      实际工期: isBlank(row['实际工期']) ? String(row['计划工期'] ?? '') : row['实际工期'],
      检修状态: OVERHAUL_FINAL,
    }
    return commitRows(
      meta,
      OVERHAUL_KEY,
      rows,
      index,
      updated,
      `验收合格，工作票已完工归档，机组允许复役（完工时间 ${finished}）`,
    )
  }
  // 结论有保留意见：退回检修中并说明保留项，机组暂不复役。
  if (!reserved) {
    return { ok: false, message: `验收结论为「${ACCEPT_RESERVED}」时，必须说明保留项` }
  }
  const updated: EntryRow = {
    ...row,
    status: '检修中',
    pending: true,
    abnormal: true,
    验收人员: acceptor,
    验收结论: ACCEPT_RESERVED,
    保留项: reserved,
    检修状态: '检修中',
  }
  return commitRows(
    meta,
    OVERHAUL_KEY,
    rows,
    index,
    updated,
    `验收有保留意见，已退回检修中，保留项：${reserved}`,
  )
}

/** 已完工票再次提交完工：按最近一次生效的那一版覆盖旧值，不叠加。 */
function overwriteCompletion(
  meta: ModuleMeta,
  rows: EntryRow[],
  index: number,
  payload: ActionPayload,
): ActionResult {
  const row = rows[index]
  const parsed = parseCompletionPayload(payload)
  if (!parsed.ok) {
    return parsed
  }
  if (parsed.conclusion !== ACCEPT_PASS) {
    return {
      ok: false,
      message: '已完工的工作票已归档，不能按保留意见退回检修中；如需整改请另开工作票',
    }
  }
  const updated: EntryRow = {
    ...row,
    验收人员: parsed.acceptor,
    验收结论: ACCEPT_PASS,
    保留项: '',
    实际完工时间: parsed.finishedAt || String(row['实际完工时间'] ?? '') || today(),
    实际工期: isBlank(row['实际工期']) ? String(row['计划工期'] ?? '') : row['实际工期'],
  }
  return commitRows(
    meta,
    OVERHAUL_KEY,
    rows,
    index,
    updated,
    '完工信息已按最近一次提交覆盖，重复提交不叠加',
  )
}

function parseCompletionPayload(
  payload: ActionPayload,
):
  | { ok: true; acceptor: string; conclusion: string; reserved: string; finishedAt: string }
  | { ok: false; message: string } {
  const acceptor = String(payload['验收人员'] ?? '').trim()
  const conclusion = String(payload['验收结论'] ?? '').trim()
  const reserved = String(payload['保留项'] ?? '').trim()
  const finishedAt = String(payload['实际完工时间'] ?? '').trim()
  if (!acceptor || !conclusion) {
    return { ok: false, message: '办理完工必须带上验收人员与验收结论' }
  }
  if (conclusion !== ACCEPT_PASS && conclusion !== ACCEPT_RESERVED) {
    return { ok: false, message: `验收结论只能是「${ACCEPT_PASS}」或「${ACCEPT_RESERVED}」` }
  }
  return { ok: true, acceptor, conclusion, reserved, finishedAt }
}

function hasCompletionPayload(payload: ActionPayload): boolean {
  return (
    String(payload['验收人员'] ?? '').trim() !== '' || String(payload['验收结论'] ?? '').trim() !== ''
  )
}

function commitRows(
  meta: ModuleMeta,
  key: string,
  rows: EntryRow[],
  index: number,
  updated: EntryRow,
  message: string,
): ActionResult {
  const next = [...rows]
  next[index] = updated
  try {
    saveRows(key, next)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `${meta.entity}保存失败：${reason}` }
  }
  return { ok: true, message }
}

function syncStatusField(meta: ModuleMeta, row: EntryRow, status: string): void {
  const field = meta.fields[meta.fields.length - 1]
  if (field && field.endsWith('状态')) {
    row[field] = status
  }
}

// ---------------------------------------------------------------------------
// 检修工作票：存量迁移与跨模块口径
// ---------------------------------------------------------------------------

function ensureOverhaulMigration(): void {
  if (
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(OVERHAUL_MIGRATION_KEY) === OVERHAUL_MIGRATION_VERSION
  ) {
    return
  }
  migrateOverhaul()
}

/** 存量工作票按发生时间迁移落库；缺验收人的历史票补记「待补签」并单独列示。 */
export function migrateOverhaul(): OverhaulMigrationResult {
  if (
    typeof window !== 'undefined' &&
    window.localStorage &&
    window.localStorage.getItem(OVERHAUL_MIGRATION_KEY) === OVERHAUL_MIGRATION_VERSION
  ) {
    return { applied: false, migrated: 0, missing: overhaulMissing() }
  }
  const rows = listRows(OVERHAUL_KEY)
  const ordered = [...rows].sort((a, b) => occurredAt(a).localeCompare(occurredAt(b)))
  const migratedById = new Map<number, EntryRow>()
  for (const row of ordered) {
    migratedById.set(Number(row.id), migrateOverhaulRow(row))
  }
  const next = rows.map((row) => migratedById.get(Number(row.id)) ?? row)
  saveRows(OVERHAUL_KEY, next)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(OVERHAUL_MIGRATION_KEY, OVERHAUL_MIGRATION_VERSION)
  }
  return { applied: true, migrated: next.length, missing: overhaulMissing() }
}

function migrateOverhaulRow(row: EntryRow): EntryRow {
  const next: EntryRow = {
    ...row,
    验收结论: row['验收结论'] ?? '',
    实际完工时间: row['实际完工时间'] ?? '',
    保留项: row['保留项'] ?? '',
  }
  if (String(next.status) === OVERHAUL_FINAL) {
    // 历史工作票按计划工期回填
    if (isBlank(next['实际工期'])) {
      next['实际工期'] = String(next['计划工期'] ?? '')
    }
    if (isBlank(next['实际完工时间'])) {
      next['实际完工时间'] = planEnd(next['计划工期']) || today()
    }
    if (isBlank(next['验收结论'])) {
      next['验收结论'] = `${ACCEPT_PASS}（历史补记）`
    }
    if (isBlank(next['验收人员'])) {
      next['验收人员'] = MISSING_ACCEPTOR
    }
    next.pending = false
    next.abnormal = false
  }
  next['检修状态'] = String(next.status)
  return next
}

/** 已完工但验收人员仍缺（待补签）的工作票：缺值单独列示。 */
export function overhaulMissing(): EntryRow[] {
  return listRows(OVERHAUL_KEY).filter(
    (row) => String(row.status) === OVERHAUL_FINAL && isMissingAcceptor(row['验收人员']),
  )
}

function isMissingAcceptor(value: unknown): boolean {
  const text = String(value ?? '').trim()
  return text === '' || text === MISSING_ACCEPTOR
}

/** 检修中机组台数的唯一口径：检修页、发电计划页、导轴承页都读这一份。 */
export function overhaulStats(): OverhaulStats {
  ensureOverhaulMigration()
  const rows = listRows(OVERHAUL_KEY)
  const count = (status: string) => rows.filter((row) => String(row.status) === status).length
  return {
    total: rows.length,
    pendingApproval: count('待审批'),
    approved: count('已批准'),
    repairing: count('检修中'),
    completed: count(OVERHAUL_FINAL),
  }
}

/** 发电计划的机组可调容量：检修中机组不算可用，只读不回写。 */
export function generationCapacity(): CapacityInfo {
  const repairingUnits = overhaulStats().repairing
  const totalUnits = listRows('unit').length
  return {
    totalUnits,
    repairingUnits,
    availableUnits: Math.max(0, totalUnits - repairingUnits),
  }
}

/** 导轴承页的检修联动待办：检修中的工作票一台一条，台数跟着变。 */
export function bearingTodos(): { count: number; items: BearingTodo[] } {
  ensureOverhaulMigration()
  const items = listRows(OVERHAUL_KEY)
    .filter((row) => String(row.status) === '检修中')
    .map((row) => ({
      ticketId: Number(row.id),
      ticketNo: String(row['工作票号'] ?? row.id),
      unit: String(row['检修机组'] ?? ''),
      leader: String(row['工作负责人'] ?? ''),
      plan: String(row['计划工期'] ?? ''),
    }))
  return { count: items.length, items }
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

function planEnd(plan: unknown): string {
  const text = String(plan ?? '').trim()
  if (text.includes('~')) {
    return text.split('~')[1].trim()
  }
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : ''
}

function occurredAt(row: EntryRow): string {
  const finished = String(row['实际完工时间'] ?? '').trim()
  if (finished) {
    return finished
  }
  const planned = planEnd(row['计划工期'])
  if (planned) {
    return planned
  }
  return `~${String(Number(row.id)).padStart(8, '0')}`
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  if (key === OVERHAUL_KEY && typeof window !== 'undefined' && window.localStorage) {
    // 回到初始数据后让迁移重跑一次，口径与首次播种一致
    window.localStorage.removeItem(OVERHAUL_MIGRATION_KEY)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  if (key === OVERHAUL_KEY) {
    ensureOverhaulMigration()
  }
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
