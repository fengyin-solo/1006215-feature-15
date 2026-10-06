/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

/** 动作随附的表单数据：办理完工时的验收人员、验收结论、保留项、实际完工时间等。 */
export type ActionPayload = Record<string, string>

/** 检修工作票各状态计数，检修页与发电计划页共用这一份口径。 */
export type OverhaulStats = {
  total: number
  pendingApproval: number
  approved: number
  repairing: number
  completed: number
}

/** 发电计划侧的机组可调容量：检修中机组不计入可调。 */
export type CapacityInfo = {
  totalUnits: number
  repairingUnits: number
  availableUnits: number
}

/** 导轴承页的检修联动待办：跟着检修中工作票走。 */
export type BearingTodo = {
  ticketId: number
  ticketNo: string
  unit: string
  leader: string
  plan: string
}

export type OverhaulMigrationResult = {
  applied: boolean
  migrated: number
  missing: EntryRow[]
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
