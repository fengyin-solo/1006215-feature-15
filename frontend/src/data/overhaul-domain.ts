/**
 * 检修工作票领域规则：状态机、容量快照、缺值检查、导轴承待办都收敛在这里。
 * 检修页面、发电计划、导轴承三处入口只读这一份结论，保证台数与容量处处对得上。
 */
import type { CapacitySnapshot, EntryRow, OverhaulGap } from '@/data/types'

export const OVERHAUL_KEY = 'overhaul'
export const UNIT_KEY = 'unit'
export const GENERATION_KEY = 'generation'
export const BEARING_KEY = 'bearing'

/** 检修工作票生命周期：单向链路，只能逐格推进，终态已完工即归档。 */
export const OVERHAUL_CHAIN = ['待审批', '已批准', '检修中', '已完工'] as const
export const ARCHIVED_STATUS = '已完工'

/** 链路每一跳对应的动作，反过来也用于指出跳级时缺了哪一步。 */
export const CHAIN_ACTIONS: Record<string, string> = {
  待审批: '提交审批',
  已批准: '开工检修',
  检修中: '办理完工',
}

export function isBlank(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

/** 把当前时间格式化为 YYYY-MM-DD HH:mm，落到「实际开工/完工时间」字段。 */
export function formatNow(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  )
}

/** 机组没有独立名称字段，统一由机组编号尾部序号派生「N号机组」作为跨模块关联键。 */
export function unitDisplayName(row: EntryRow): string {
  const code = String(row['机组编号'] ?? '')
  const matched = code.match(/(\d+)\s*$/)
  return matched ? `${Number(matched[1])}号机组` : code
}

export function unitCapacityMw(row: EntryRow): number {
  const raw = row['额定容量(MW)']
  const value = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(value) ? value : 0
}

/** 检修中机组名集合：以工作票为唯一事实源，按机组去重（同机多张票只算一台）。 */
export function maintenanceUnitSet(overhaulRows: EntryRow[]): Set<string> {
  const names = overhaulRows
    .filter((row) => String(row.status) === '检修中')
    .map((row) => String(row['检修机组'] ?? '').trim())
    .filter(Boolean)
  return new Set(names)
}

/**
 * 机组可调容量快照：
 * 检修中机组不计入可调容量；工作票上有、但机组台账查不到的机组仍计入检修台数，容量无法核减时不臆造。
 */
export function buildCapacitySnapshot(entries: Record<string, EntryRow[]>): CapacitySnapshot {
  const units = entries[UNIT_KEY] ?? []
  const maintenance = maintenanceUnitSet(entries[OVERHAUL_KEY] ?? [])
  let totalMw = 0
  let maintenanceMw = 0
  for (const unit of units) {
    const mw = unitCapacityMw(unit)
    totalMw += mw
    if (maintenance.has(unitDisplayName(unit))) {
      maintenanceMw += mw
    }
  }
  return {
    totalUnits: units.length,
    maintenanceUnits: [...maintenance],
    maintenanceCount: maintenance.size,
    totalMw,
    maintenanceMw,
    adjustableMw: totalMw - maintenanceMw,
  }
}

/** 把容量快照回写到每张发电计划上：计划里不能把检修中机组当成可用。 */
export function stampGenerationRows(
  entries: Record<string, EntryRow[]>,
  snapshot?: CapacitySnapshot,
): EntryRow[] {
  const snap = snapshot ?? buildCapacitySnapshot(entries)
  return (entries[GENERATION_KEY] ?? []).map((row) => ({
    ...row,
    检修中机组台数: snap.maintenanceCount,
    '机组可调容量(MW)': snap.adjustableMw,
  }))
}

const REQUIRED_FIELDS: Record<string, string[]> = {
  待审批: ['工作票号', '检修机组', '检修级别', '计划开工', '计划完工', '工作负责人'],
  已批准: ['工作票号', '检修机组', '检修级别', '计划开工', '计划完工', '工作负责人'],
  检修中: ['工作票号', '检修机组', '检修级别', '计划开工', '计划完工', '工作负责人', '实际开工时间'],
  已完工: [
    '工作票号',
    '检修机组',
    '检修级别',
    '计划开工',
    '计划完工',
    '工作负责人',
    '实际开工时间',
    '实际完工时间',
    '验收人员',
    '验收结论',
  ],
}

/** 按当前状态应当具备而实际缺值的字段；缺什么列什么，不替用户编。 */
export function findOverhaulGaps(rows: EntryRow[]): OverhaulGap[] {
  const gaps: OverhaulGap[] = []
  for (const row of rows) {
    const status = String(row.status)
    const required = REQUIRED_FIELDS[status] ?? []
    const missing = required.filter((field) => isBlank(row[field]))
    if (status === '已完工' && String(row['验收结论'] ?? '') === '有保留意见' && isBlank(row['保留意见'])) {
      missing.push('保留意见')
    }
    if (missing.length > 0) {
      gaps.push({
        id: Number(row.id),
        工作票号: String(row['工作票号'] ?? ''),
        检修机组: String(row['检修机组'] ?? ''),
        status,
        missing,
      })
    }
  }
  return gaps
}

export type BearingTodo = {
  bearing: EntryRow
  ticketNo: string
  unit: string
}

/**
 * 导轴承待办清单：检修工作票牵动出来的那份。
 * 机组在检修中（读容量快照同一结论）且该机组导轴承处于「待检修」，就挂进待办。
 */
export function listBearingTodos(entries: Record<string, EntryRow[]>): BearingTodo[] {
  const maintenance = maintenanceUnitSet(entries[OVERHAUL_KEY] ?? [])
  const tickets = (entries[OVERHAUL_KEY] ?? []).filter((row) => String(row.status) === '检修中')
  const ticketOf = (unit: string) =>
    tickets.find((row) => String(row['检修机组'] ?? '').trim() === unit)
  return (entries[BEARING_KEY] ?? [])
    .filter((row) => String(row.status) === '待检修')
    .map((row) => {
      const unit = String(row['所属机组'] ?? '').trim()
      const ticket = ticketOf(unit)
      return { bearing: row, unit, ticketNo: ticket ? String(ticket['工作票号'] ?? '') : '' }
    })
    .filter((item) => maintenance.has(item.unit))
}
