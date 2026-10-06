/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | undefined
  /** 终态归档标记：检修工作票完工后为 true，归档后不能再流转。 */
  archived?: boolean
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

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 办理完工时必须随表单提交的验收信息。 */
export type OverhaulCompletion = {
  验收人员: string
  验收结论: '合格' | '有保留意见'
  保留意见?: string
  /** 实际完工时间，缺省由服务端按当前时间落库；重复办理时以新值覆盖旧值。 */
  实际完工时间?: string
}

/** 工作票按当前状态应当具备而缺失的字段，单独列示、不虚构补值。 */
export type OverhaulGap = {
  id: number
  工作票号: string
  检修机组: string
  status: string
  missing: string[]
}

/** 机组检修状态回写给发电计划等入口的统一快照：所有入口只读这一份结论。 */
export type CapacitySnapshot = {
  totalUnits: number
  maintenanceUnits: string[]
  maintenanceCount: number
  totalMw: number
  maintenanceMw: number
  adjustableMw: number
}
