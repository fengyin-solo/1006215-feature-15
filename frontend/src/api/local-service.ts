import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  consumeCompletionPending,
  getFault,
  getIdempotency,
  listRows,
  markCompletionPending,
  resetRows,
  saveIdempotency,
  saveOverhaulAndProject,
  saveRows,
  setFault,
  __resetCache as resetStoreCache,
  __reloadFromStorage as reloadStoreFromStorage,
} from '@/data/local-store'
import {
  ARCHIVED_STATUS,
  CHAIN_ACTIONS,
  GENERATION_KEY,
  OVERHAUL_CHAIN,
  OVERHAUL_KEY,
  buildCapacitySnapshot,
  findOverhaulGaps,
  formatNow,
  isBlank,
  listBearingTodos,
  maintenanceUnitSet,
  stampGenerationRows,
} from '@/data/overhaul-domain'
import type {
  ActionResult,
  CapacitySnapshot,
  EntryRow,
  ModuleMeta,
  OverhaulCompletion,
  OverhaulGap,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 办理完工验收链路上的故障注入名：超时/断线演练用，生产页面不触发。
const FAULT_COMPLETION = 'complete-overhaul'

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
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 检修工作票保存后，发电计划投影在同一次落库里回写，两处始终同源。 */
function persistOverhaul(rows: EntryRow[], index: number, updated: EntryRow): void {
  const next = [...rows]
  next[index] = updated
  saveOverhaulAndProject(next)
}

function findTicket(id: number): { rows: EntryRow[]; index: number; row: EntryRow } | ActionResult {
  const rows = listRows(OVERHAUL_KEY)
  const index = rows.findIndex((item) => Number(item.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的检修工作票` }
  }
  return { rows, index, row: rows[index] }
}

/**
 * 检修工作票沿 待审批→已批准→检修中→已完工 单向推进：
 * 只能逐格走，跳级当场退回并指出缺哪一步；已完工归档，任何动作都回不到检修中。
 * 「办理完工」必须带验收信息，不走这个通用入口。
 */
function advanceOverhaul(id: number, action: string): ActionResult {
  const meta = moduleMeta(OVERHAUL_KEY)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `检修工作票没有登记「${action}」这个动作` }
  }
  const found = findTicket(id)
  if ('ok' in found) {
    return found
  }
  const { rows, index, row } = found
  const ticketNo = String(row['工作票号'] ?? id)
  const current = String(row.status)

  if (row.archived || current === ARCHIVED_STATUS) {
    return {
      ok: false,
      message: `工作票 ${ticketNo} 已完工并归档，不能再执行「${action}」：归档票回不到检修中`,
    }
  }
  if (action === '办理完工') {
    return { ok: false, message: '办理完工必须登记验收人员与验收结论，请在完工验收弹窗里提交' }
  }
  if (current === target) {
    return { ok: false, message: `工作票 ${ticketNo} 已经是「${target}」，不用重复操作` }
  }
  const currentIndex = OVERHAUL_CHAIN.indexOf(current as (typeof OVERHAUL_CHAIN)[number])
  const targetIndex = OVERHAUL_CHAIN.indexOf(target as (typeof OVERHAUL_CHAIN)[number])
  if (currentIndex < 0 || targetIndex < 0) {
    return { ok: false, message: `工作票状态「${current}」不在生命周期链路内，禁止流转` }
  }
  if (targetIndex < currentIndex) {
    return { ok: false, message: `工作票 ${ticketNo} 当前在「${current}」，生命周期是单向链路，不能倒回「${target}」` }
  }
  if (targetIndex > currentIndex + 1) {
    const missing: string[] = []
    for (let i = currentIndex; i < targetIndex; i += 1) {
      missing.push(`「${OVERHAUL_CHAIN[i]} → ${OVERHAUL_CHAIN[i + 1]}」需先${CHAIN_ACTIONS[OVERHAUL_CHAIN[i]]}`)
    }
    return {
      ok: false,
      message: `跳级被退回：工作票 ${ticketNo} 还在「${current}」，不能直接${action}。缺的步骤：${missing.join('，')}`,
    }
  }

  const updated: EntryRow = { ...row, status: target, pending: target !== ARCHIVED_STATUS, abnormal: false }
  if (action === '开工检修' && isBlank(updated['实际开工时间'])) {
    updated['实际开工时间'] = formatNow()
  }
  persistOverhaul(rows, index, updated)
  return { ok: true, message: `工作票 ${ticketNo} 已${action}，当前状态「${target}」` }
}

function validateCompletion(id: number, input: OverhaulCompletion): ActionResult | null {
  const acceptor = String(input.验收人员 ?? '').trim()
  const conclusion = String(input.验收结论 ?? '').trim()
  const reserved = String(input.保留意见 ?? '').trim()
  if (!acceptor) {
    return { ok: false, message: '办理完工必须登记验收人员' }
  }
  if (conclusion !== '合格' && conclusion !== '有保留意见') {
    return { ok: false, message: '办理完工必须给出验收结论：合格 / 有保留意见' }
  }
  if (conclusion === '有保留意见' && !reserved) {
    return { ok: false, message: '验收结论为「有保留意见」时必须写明保留项，否则不能退回检修中' }
  }
  const found = findTicket(id)
  if ('ok' in found) {
    return found
  }
  return null
}

function sameAcceptance(row: EntryRow, acceptor: string, conclusion: string, reserved: string): boolean {
  return (
    String(row['验收人员'] ?? '') === acceptor &&
    String(row['验收结论'] ?? '') === conclusion &&
    (conclusion === '合格' || String(row['保留意见'] ?? '') === reserved) &&
    !isBlank(row['验收登记时间'])
  )
}

/**
 * 办理完工（带验收）。
 * - 合格：归档到已完工，机组可以复役；
 * - 有保留意见：退回检修中，记录保留项，机组不可复役；
 * - 超时/断线自动重试一次，已落库的重试只做幂等恢复，不叠加；
 * - 同一张票重复完工只生效一次，重新验收时以最近一次生效的验收记录覆盖旧版。
 */
export function completeOverhaul(
  id: number,
  input: OverhaulCompletion,
  idempotencyKey = '',
): ActionResult {
  if (idempotencyKey) {
    const cached = getIdempotency(idempotencyKey)
    if (cached && cached.ticketId === id) {
      return { ...cached, message: `${cached.message}（检测到重复提交，完工只生效一次，直接返回首次结果）` }
    }
  }

  const invalid = validateCompletion(id, input)
  if (invalid) {
    return invalid
  }

  const acceptor = String(input.验收人员).trim()
  const conclusion = input.验收结论
  const reserved = String(input.保留意见 ?? '').trim()
  const finishAt = String(input.实际完工时间 ?? '').trim() || formatNow()

  let result: ActionResult = { ok: false, message: '办理完工未执行' }
  for (const attemptNo of [1, 2]) {
    const rows = listRows(OVERHAUL_KEY)
    const index = rows.findIndex((item) => Number(item.id) === id)
    if (index < 0) {
      result = { ok: false, message: `没有找到编号为 ${id} 的检修工作票` }
      break
    }
    const row = rows[index]
    const ticketNo = String(row['工作票号'] ?? id)
    const current = String(row.status)

    // 重试恢复：上一次其实已经落库，只是响应丢了。
    if (row.archived || current === ARCHIVED_STATUS) {
      result = {
        ok: true,
        message: `工作票 ${ticketNo} 已完工归档（实际完工时间 ${row['实际完工时间']}）：首次提交已生效，重试未重复办理，机组可复役`,
      }
      break
    }
    if (current !== '检修中') {
      result = {
        ok: false,
        message: `跳级被退回：工作票 ${ticketNo} 当前是「${current}」，只有检修中才能办理完工，需先${CHAIN_ACTIONS[current] ?? '推进到检修中'}`,
      }
      break
    }
    if (sameAcceptance(row, acceptor, conclusion, reserved)) {
      result =
        conclusion === '合格'
          ? { ok: true, message: `工作票 ${ticketNo} 验收合格已归档：首次提交已生效，重试未重复办理，机组可复役` }
          : { ok: true, message: `工作票 ${ticketNo} 的保留意见已登记（保留项：${reserved}），已在检修中：首次提交已生效，重试未叠加` }
      break
    }

    const fault = getFault(FAULT_COMPLETION)
    // 重试恢复（落库后断线）：上一次其实已经写完，标记在案，第二次只做幂等确认。
    if (attemptNo === 2 && consumeCompletionPending(id)) {
      setFault(FAULT_COMPLETION, '')
      // 以实际落库的那版为准回读，避免确认结论时用到内存旧值。
      const savedRows = listRows(OVERHAUL_KEY)
      const savedIndex = savedRows.findIndex((item) => Number(item.id) === id)
      const saved = savedIndex >= 0 ? savedRows[savedIndex] : row
      const savedConclusion = String(saved['验收结论'] ?? conclusion)
      result = {
        ok: true,
        message:
          savedConclusion === '合格'
            ? `工作票 ${ticketNo} 已完工归档（实际完工时间 ${saved['实际完工时间']}）：首次提交已落库，断线重试只做确认，未重复办理，机组可复役`
            : `工作票 ${ticketNo} 的保留意见已登记（保留项：${saved['保留意见']}），已在检修中：首次提交已落库，断线重试只做确认，未叠加`,
      }
      break
    }
    // 提交前超时：第一次没有任何落库，清掉一次性故障后重试。
    if (fault === 'timeout-pre-persist' && attemptNo === 1) {
      setFault(FAULT_COMPLETION, '')
      continue
    }

    const target: EntryRow =
      conclusion === '合格'
        ? {
            ...row,
            status: ARCHIVED_STATUS,
            pending: false,
            abnormal: false,
            archived: true,
            验收人员: acceptor,
            验收结论: '合格',
            保留意见: '',
            实际完工时间: finishAt,
            验收登记时间: formatNow(),
          }
        : {
            ...row,
            status: '检修中',
            pending: true,
            abnormal: true,
            验收人员: acceptor,
            验收结论: '有保留意见',
            保留意见: reserved,
            实际完工时间: '',
            验收登记时间: formatNow(),
          }

    try {
      if (fault === 'persistent-write-failure') {
        throw new Error('存储持续不可用（模拟）')
      }
      persistOverhaul(rows, index, target)
      // 落库成功但响应断线：数据已写入，留下恢复标记后抛错，第二次只做幂等确认。
      if (fault === 'disconnect-persist' && attemptNo === 1) {
        markCompletionPending(id)
        throw new Error('提交中断，响应未收到（模拟）')
      }
      // 落库后响应超时：第一次已经生效，重试时走开头的幂等恢复分支。
      if (fault === 'timeout-post-persist' && attemptNo === 1) {
        setFault(FAULT_COMPLETION, '')
        continue
      }
    } catch (error) {
      if (attemptNo === 1) {
        continue
      }
      const reason = error instanceof Error ? error.message : '未知存储错误'
      result = {
        ok: false,
        message: `办理完工提交失败，已自动重试一次仍未成功：${reason}。工作票 ${ticketNo} 仍处于检修中，请稍后重新办理。`,
      }
      break
    }

    result =
      conclusion === '合格'
        ? {
            ok: true,
            message: `工作票 ${ticketNo} 完工验收合格，已归档，实际完工时间 ${finishAt}，机组可办理复役`,
          }
        : {
            ok: true,
            message: `验收结论为有保留意见（保留项：${reserved}），工作票 ${ticketNo} 退回检修中，机组暂不能复役`,
          }
    break
  }

  if (result.ok && idempotencyKey) {
    saveIdempotency(idempotencyKey, { ...result, ticketId: id, savedAt: formatNow() })
  }
  return result
}

/**
 * 历史票补记验收（裁决）：早期没有验收人的，不虚构、不倒填时间，
 * 由当值验收人补记姓名与验收结论（默认合格），缺值清单销项；票仍保持归档、完工时间不变。
 */
export function supplementAcceptance(
  id: number,
  input: Pick<OverhaulCompletion, '验收人员' | '验收结论' | '保留意见'>,
): ActionResult {
  const acceptor = String(input.验收人员 ?? '').trim()
  const conclusion = String(input.验收结论 ?? '').trim()
  const reserved = String(input.保留意见 ?? '').trim()
  if (!acceptor) {
    return { ok: false, message: '补记验收人员不能为空' }
  }
  if (conclusion !== '合格' && conclusion !== '有保留意见') {
    return { ok: false, message: '补记必须给出验收结论：合格 / 有保留意见' }
  }
  if (conclusion === '有保留意见' && !reserved) {
    return { ok: false, message: '结论为有保留意见时必须写明保留项' }
  }
  const found = findTicket(id)
  if ('ok' in found) {
    return found
  }
  const { rows, index, row } = found
  const ticketNo = String(row['工作票号'] ?? id)
  if (!row.archived || String(row.status) !== ARCHIVED_STATUS) {
    return { ok: false, message: `工作票 ${ticketNo} 还没完工归档，验收在办理完工时登记，不用补记` }
  }
  if (!isBlank(row['验收人员'])) {
    return { ok: false, message: `工作票 ${ticketNo} 已有验收人「${row['验收人员']}」，补记入口只处理早期缺验收人的票` }
  }
  persistOverhaul(rows, index, {
    ...row,
    验收人员: acceptor,
    验收结论: conclusion,
    保留意见: conclusion === '有保留意见' ? reserved : '',
    验收登记时间: formatNow(),
  })
  return { ok: true, message: `工作票 ${ticketNo} 已补记验收人 ${acceptor}（结论：${conclusion}），归档状态与完工时间不变` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  if (key === OVERHAUL_KEY) {
    return advanceOverhaul(id, action)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  // 重置检修/机组等模块后，以重置后的工作票重新回写发电计划，避免投影停留在旧值。
  saveRows(GENERATION_KEY, stampGenerationRows(allRows()))
  return listEntries(key)
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 报表与明细同源：直接遍历同一份行数据统计与导出，筛选/状态变化后数值跟着变。
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].map(csvCell).join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
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

// ── 检修状态汇总：检修工作票、发电计划、导轴承三处入口共用 ─────────────────────

export function capacitySnapshot(): CapacitySnapshot {
  return buildCapacitySnapshot(allRows())
}

export function overhaulGaps(): OverhaulGap[] {
  return findOverhaulGaps(listRows(OVERHAUL_KEY))
}

export function overhaulStats(): { pending: number; maintaining: number; archived: number } {
  const rows = listRows(OVERHAUL_KEY)
  return {
    pending: rows.filter((row) => String(row.status) === '待审批').length,
    maintaining: maintenanceUnitSet(rows).size,
    archived: rows.filter((row) => row.archived || String(row.status) === ARCHIVED_STATUS).length,
  }
}

export function bearingTodoList() {
  return listBearingTodos(allRows())
}

export function bearingTodoCount(): number {
  return listBearingTodos(allRows()).length
}

/** 验收链路故障演练/自动化校验：清内存缓存，模拟重新进入页面。 */
export function __resetCacheForTest(): void {
  resetStoreCache()
}

/** 自动化校验：立即从 localStorage 重读，等价于关掉页面重新打开。 */
export function __reloadFromStorageForTest(): void {
  reloadStoreFromStorage()
}

/** 验收链路故障演练：mode 传空串清除。模式：timeout-pre-persist / disconnect-persist / timeout-post-persist / persistent-write-failure。 */
export function __injectCompletionFault(mode: string): void {
  setFault('complete-overhaul', mode)
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
