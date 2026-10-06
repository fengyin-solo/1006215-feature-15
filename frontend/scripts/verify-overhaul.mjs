// 检修工作票生命周期自动化校验。
// 运行方式：npm run verify（先用 esbuild 把带 @ 别名的服务层打成单文件，再用 Node 执行本文件）。
// 校验环境里没有浏览器，这里手工挂一个 window/localStorage 桩。

const assert = (cond, message) => {
  if (!cond) {
    console.error(`✗ ${message}`)
    process.exitCode = 1
    return false
  }
  console.log(`✓ ${message}`)
  return true
}
const expectFail = (result, part) =>
  assert(!result.ok && result.message.includes(part), `应被拒绝（${part}）：${result.message}`)
const expectOk = (result, part) =>
  assert(result.ok && (!part || result.message.includes(part)), result.message)

// ── localStorage 桩 + 装载服务层 ───────────────────────────────────────────
function makeStorage() {
  const map = new Map()
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  }
}
globalThis.window = { localStorage: makeStorage() }
globalThis.localStorage = globalThis.window.localStorage

const service = await import('../.verify-bundle/local-service.mjs')

const ENTRIES_KEY = 'hydropower-plant-om:entries'
const META_KEY = 'hydropower-plant-om:meta'

function reloadFromStorage() {
  // 模拟重新进入页面：丢弃内存状态，强制从 localStorage 重新装载（含迁移）。
  service.__reloadFromStorageForTest()
}

function clearAll() {
  service.__injectCompletionFault('')
  localStorage.clear()
  service.__resetCacheForTest()
}

function rows() {
  return service.listEntries('overhaul').items
}
function ticket(id) {
  return rows().find((r) => Number(r.id) === id)
}
function genRows() {
  return service.listEntries('generation').items
}

// 种子票：id=5 待审批，id=6 已批准，id=4 检修中；id=1、3 已完工缺验收人，id=2 合格归档。
clearAll()

// ── 1. 单向链路与跳级退回 ──────────────────────────────────────────────────
console.log('\n[1] 生命周期单向链路 / 跳级退回 / 归档只读')
expectFail(service.runAction('overhaul', 5, '开工检修'), '跳级被退回')
expectFail(service.runAction('overhaul', 5, '办理完工'), '验收人员与验收结论')
expectOk(service.runAction('overhaul', 5, '提交审批'), '已提交审批')
assert(ticket(5).status === '已批准', '提交审批后为已批准')
expectFail(service.runAction('overhaul', 5, '办理完工'), '验收人员与验收结论')
expectOk(service.runAction('overhaul', 5, '开工检修'), '已开工检修')
assert(ticket(5).status === '检修中' && !ticket(5).archived, '开工后为检修中、未归档')
assert(String(ticket(5)['实际开工时间']) !== '', '开工自动记录实际开工时间')
expectFail(service.runAction('overhaul', 5, '提交审批'), '不能倒回')
expectFail(service.runAction('overhaul', 5, '开工检修'), '已经是')

// 已批准票不能直接完工（必须先开工）
expectFail(service.completeOverhaul(6, { 验收人员: '张三', 验收结论: '合格' }), '只有检修中才能办理完工')

// 通用动作也拦不住的归档回退：归档票任何动作都拒绝
expectFail(service.runAction('overhaul', 2, '开工检修'), '已完工并归档')
expectFail(service.runAction('overhaul', 2, '办理完工'), '已完工并归档')

// ── 2. 完工验收：必填、合格归档、保留意见退回 ─────────────────────────────
console.log('\n[2] 完工验收规则')
expectFail(service.completeOverhaul(4, { 验收人员: '', 验收结论: '合格' }), '必须登记验收人员')
expectFail(
  service.completeOverhaul(4, { 验收人员: '赵验收', 验收结论: '有保留意见', 保留意见: '' }),
  '必须写明保留项',
)
expectOk(
  service.completeOverhaul(4, {
    验收人员: '赵验收',
    验收结论: '有保留意见',
    保留意见: '下导瓦温偏高，需跟踪一周',
  }),
  '退回检修中',
)
assert(ticket(4).status === '检修中' && ticket(4).abnormal, '保留意见：仍在检修中且挂异常')
assert(ticket(4)['验收人员'] === '赵验收' && ticket(4)['验收结论'] === '有保留意见', '保留项已登记')
assert(!ticket(4).archived && ticket(4)['实际完工时间'] === '', '保留意见不归档、不写完工时间，机组不可复役')

// 消缺后重新验收合格：覆盖旧版验收记录
expectOk(
  service.completeOverhaul(4, { 验收人员: '赵验收', 验收结论: '合格', 实际完工时间: '2026-10-10 16:00' }),
  '机组可办理复役',
)
const t4 = ticket(4)
assert(t4.status === '已完工' && t4.archived && t4.abnormal === false, '重新验收合格后归档、异常清除')
assert(t4['验收结论'] === '合格' && t4['保留意见'] === '', '新结论覆盖旧保留项，不叠加')
assert(t4['实际完工时间'] === '2026-10-10 16:00', '按实际完工时间落库')

// id=5 走到完工，用固定时间验证覆盖
expectOk(service.completeOverhaul(5, { 验收人员: '钱工', 验收结论: '合格', 实际完工时间: '2026-10-24 15:00' }), '已归档')
expectOk(
  service.completeOverhaul(5, { 验收人员: '孙工', 验收结论: '合格', 实际完工时间: '2026-10-24 18:30' }),
  '已完工归档',
)
const t5 = ticket(5)
assert(t5['实际完工时间'] === '2026-10-24 15:00', '归档票重复完工：旧值保留，不被叠加/覆盖')

// 完工弹窗重开后允许重新办理？归档后一律拒绝（覆盖只发生在归档前的重新验收）
expectFail(service.runAction('overhaul', 4, '开工检修'), '已完工并归档')

// ── 3. 幂等：同一把钥匙重复提交只生效一次 ─────────────────────────────────
console.log('\n[3] 完工动作幂等')
clearAll()
const key = 'idem-key-001'
expectOk(
  service.completeOverhaul(4, { 验收人员: '甲', 验收结论: '合格', 实际完工时间: '2026-10-10 10:00' }, key),
  '机组可办理复役',
)
const second = service.completeOverhaul(
  4,
  { 验收人员: '乙', 验收结论: '合格', 实际完工时间: '2026-10-11 10:00' },
  key,
)
expectOk(second, '重复提交，完工只生效一次')
assert(ticket(4)['验收人员'] === '甲', '幂等重放返回首次结果，验收人未被第二次覆盖')
assert(ticket(4)['实际完工时间'] === '2026-10-10 10:00', '幂等重放完工时间未变')
// 无钥匙的直接重复办理同样不生效
const again = service.completeOverhaul(4, { 验收人员: '丙', 验收结论: '合格' })
expectOk(again, '已完工归档')
assert(ticket(4)['验收人员'] === '甲', '归档票再次办理不产生第二版')

// ── 4. 超时/断线重试一次，重试不成给原因 ──────────────────────────────────
console.log('\n[4] 链路故障：自动重试一次')
clearAll()
// 4.1 提交前超时：第一次没落库，重试成功
service.__injectCompletionFault('timeout-pre-persist')
expectOk(
  service.completeOverhaul(4, { 验收人员: '重试验收', 验收结论: '合格', 实际完工时间: '2026-10-10 10:00' }, 'k-a'),
  '机组可办理复役',
)
assert(ticket(4).archived && ticket(4)['验收人员'] === '重试验收', '提交前超时经重试后成功归档')

// 4.2 落库后断线：第一次已生效，重试幂等恢复
clearAll()
service.__injectCompletionFault('disconnect-persist')
expectOk(
  service.completeOverhaul(4, { 验收人员: '断线验收', 验收结论: '合格', 实际完工时间: '2026-10-10 11:00' }, 'k-b'),
  '重试未重复办理',
)
assert(ticket(4).archived && ticket(4)['验收人员'] === '断线验收', '断线重试恢复，未叠加第二张完工')

// 4.3 落库后响应超时：同样幂等恢复
clearAll()
service.__injectCompletionFault('timeout-post-persist')
expectOk(
  service.completeOverhaul(4, { 验收人员: '超时验收', 验收结论: '合格' }, 'k-c'),
  '重试未重复办理',
)
assert(ticket(4).archived, '响应超时重试恢复')

// 4.4 持续不可用：两次都失败，给出原因且状态不动
clearAll()
service.__injectCompletionFault('persistent-write-failure')
const failed = service.completeOverhaul(4, { 验收人员: '失败验收', 验收结论: '合格' }, 'k-d')
expectFail(failed, '已自动重试一次仍未成功')
assert(ticket(4).status === '检修中' && !ticket(4).archived, '永久失败后工作票仍在检修中')
service.__injectCompletionFault('')

// ── 5. 容量快照：两处入口台数一致，发电计划回写 ───────────────────────────
console.log('\n[5] 检修中机组 → 发电计划可调容量回写')
clearAll()
let snap = service.capacitySnapshot()
assert(snap.totalUnits === 3, `在册机组 3 台（实际 ${snap.totalUnits}）`)
assert(snap.maintenanceCount === 1, `初始检修中 1 台（实际 ${snap.maintenanceCount}：${snap.maintenanceUnits.join(',')}）`)
assert(snap.totalMw === 750 && snap.maintenanceMw === 150 && snap.adjustableMw === 600,
  `可调容量 600MW（总 ${snap.totalMw} − 检修 ${snap.maintenanceMw}）`)
assert(service.overhaulStats().maintaining === 1, '检修工作票页「检修中机组」=1')
assert(service.bearingTodoCount() === 1, '导轴承待办 1 项（3号机组 BEAR-301）')
assert(genRows().every((g) => g['检修中机组台数'] === 1 && g['机组可调容量(MW)'] === 600),
  '发电计划每行已回写台数 1、可调容量 600')

// id=6（2号机组）批准→开工，台数变 2，可调容量变 300，导轴承待办不增加（2号轴承已检修）
service.runAction('overhaul', 6, '开工检修')
snap = service.capacitySnapshot()
assert(snap.maintenanceCount === 2, `开工后检修中 2 台（实际 ${snap.maintenanceCount}：${snap.maintenanceUnits.join(',')}）`)
assert(snap.adjustableMw === 300, `可调容量降到 300MW（实际 ${snap.adjustableMw}）`)
assert(service.overhaulStats().maintaining === 2, '工作票页台数同步变 2')
assert(service.bearingTodoCount() === 1, '导轴承待办仍为 1（2号轴承非待检修）')
assert(genRows().every((g) => g['检修中机组台数'] === 2 && g['机组可调容量(MW)'] === 300),
  '发电计划回写同步变为台数 2、容量 300')

// id=4（3号机组）验收合格完工：台数回到 1，容量恢复
service.completeOverhaul(4, { 验收人员: '赵验收', 验收结论: '合格', 实际完工时间: '2026-10-10 16:00' })
snap = service.capacitySnapshot()
assert(snap.maintenanceCount === 1 && snap.adjustableMw === 450,
  `3号机组完工复役后：检修中 1 台、可调 450MW（实际 ${snap.maintenanceCount}/${snap.adjustableMw}）`)
assert(service.bearingTodoCount() === 0, '3号机组完工后导轴承待办清零')
assert(genRows().every((g) => g['检修中机组台数'] === 1 && g['机组可调容量(MW)'] === 450),
  '发电计划回写与工作票再次一致')

// 保留意见退回检修中时，容量仍按检修中占用（先让 4 回到检修中：重置模块后重放）
clearAll()
service.completeOverhaul(4, {
  验收人员: '赵验收', 验收结论: '有保留意见', 保留意见: '下导瓦温偏高',
})
snap = service.capacitySnapshot()
assert(snap.maintenanceCount === 1 && snap.adjustableMw === 600, '保留意见退回检修中：机组仍不可用')

// ── 6. 重新进入页面：持久化与一致性 ───────────────────────────────────────
console.log('\n[6] 刷新/重进页面后数据持久、两处取值一致')
clearAll()
service.runAction('overhaul', 6, '开工检修') // 此刻检修中：3号（id=4）、2号（id=6）
const before = service.capacitySnapshot()
reloadFromStorage()
const after = service.capacitySnapshot()
assert(JSON.stringify(before) === JSON.stringify(after), '重载后容量快照一致：' + JSON.stringify(after))
const stored = JSON.parse(localStorage.getItem(ENTRIES_KEY))
assert(stored.version === 2, `存储结构版本为 2（实际 ${stored.version}）`)
assert(stored.entries.overhaul.find((r) => r.id === 6).status === '检修中', '状态已落库，重载后仍为检修中')
assert(stored.entries.generation.every((g) => g['机组可调容量(MW)'] === after.adjustableMw),
  '落库的发电计划与快照取值一致')

// ── 7. 存量记录迁移：旧版数据按发生时间迁移、历史票回填、缺值列示 ─────────
console.log('\n[7] 旧版本存量迁移')
{
  localStorage.clear()
  // 构造旧版（无 version、字段为 计划工期/实际工期/检修状态，验收人占位）数据
  const legacy = {
    overhaul: [
      { id: 1, status: '待审批', pending: true, abnormal: false, 工作票号: 'OLD-1', 检修机组: '机组检修样例1', 检修级别: 'C', 计划工期: '2026-02-01', 实际工期: '', 工作负责人: '组长', 验收人员: '机组检修样例1', 检修状态: '待审批' },
      { id: 2, status: '检修中', pending: true, abnormal: false, 工作票号: 'OLD-2', 检修机组: '机组检修样例2', 检修级别: 'B', 计划工期: '2026-01-10', 实际工期: '2026-01-10 08:00', 工作负责人: '组长', 验收人员: '机组检修样例2', 检修状态: '检修中' },
      { id: 3, status: '已完工', pending: false, abnormal: false, 工作票号: 'OLD-3', 检修机组: '机组检修样例3', 检修级别: 'A', 计划工期: '2025-12-01', 实际工期: '2025-12-20 17:00', 工作负责人: '组长', 验收人员: '机组检修样例3', 检修状态: '已完工' },
    ],
    unit: [
      { id: 1, status: '运行中', pending: false, abnormal: false, 机组编号: 'UNIT-0001' },
      { id: 2, status: '运行中', pending: false, abnormal: false, 机组编号: 'UNIT-0002' },
      { id: 3, status: '运行中', pending: false, abnormal: false, 机组编号: 'UNIT-0003' },
    ],
    bearing: [
      { id: 9, status: '待检修', pending: true, abnormal: false, 轴承编号: 'B9', 所属机组: '导轴承样例2' },
    ],
    generation: [
      { id: 1, status: '执行中', pending: true, abnormal: false, 计划编号: 'G1' },
    ],
  }
  localStorage.setItem(ENTRIES_KEY, JSON.stringify(legacy))
  reloadFromStorage()

  const migrated = service.listEntries('overhaul').items
  assert(migrated.map((r) => r.id).join(',') === '3,2,1',
    `按发生时间先后落库（实际顺序 ${migrated.map((r) => r.id).join(',')}）`)
  const old3 = migrated.find((r) => r.id === 3)
  assert(old3['计划开工'] === '2025-12-01' && old3['计划完工'] === '2025-12-01', '历史票计划工期回填到起止格')
  assert(old3['实际开工时间'] === '2025-12-20 17:00' && old3['实际完工时间'] === '2025-12-20 17:00', '实际工期回填')
  assert(old3.archived === true && old3['验收人员'] === '', '历史完工票归档且验收人留空（不虚构）')
  assert(old3['验收结论'] === '', '无验收记录不臆造合格结论')
  const old2 = migrated.find((r) => r.id === 2)
  assert(old2['检修机组'] === '2号机组', '占位机组名归一为 2号机组')

  const gaps = service.overhaulGaps()
  const gap3 = gaps.find((g) => g.id === 3)
  assert(gap3 && gap3.missing.includes('验收人员') && gap3.missing.includes('验收结论'),
    '缺值单独列示：历史票缺验收人员/结论 → ' + (gap3 ? gap3.missing.join('、') : '未列出'))

  // 补记验收人：裁决口径落地
  const sup = service.supplementAcceptance(3, { 验收人员: '补记验收人', 验收结论: '合格' })
  expectOk(sup, '已补记验收人')
  const after3 = service.listEntries('overhaul').items.find((r) => r.id === 3)
  assert(after3['验收人员'] === '补记验收人' && after3.archived && after3['实际完工时间'] === '2025-12-20 17:00',
    '补记后归档与完工时间不变')
  assert(!service.overhaulGaps().some((g) => g.id === 3), '补记后缺值销项')
  // 已补记的不能重复补记
  expectFail(service.supplementAcceptance(3, { 验收人员: '另一位', 验收结论: '合格' }), '已有验收人')

  // 迁移后联动：检修中是 2号机组，容量与导轴承待办归一名称后对得上
  const snap2 = service.capacitySnapshot()
  assert(snap2.maintenanceCount === 1 && snap2.maintenanceUnits[0] === '2号机组',
    '迁移后检修中机组为 2号机组')
  assert(snap2.adjustableMw === 450, `迁移后可调容量 450MW（实际 ${snap2.adjustableMw}）`)
  assert(service.bearingTodoCount() === 1, '导轴承样例2 归一为 2号机组后进入待办')
  const g = service.listEntries('generation').items[0]
  assert(g['检修中机组台数'] === 1 && g['机组可调容量(MW)'] === 450, '迁移即回写发电计划')

  const stored2 = JSON.parse(localStorage.getItem(ENTRIES_KEY))
  assert(stored2.version === 2 && stored2.entries.overhaul.every((r) => !('计划工期' in r)),
    '迁移后旧字段清除、版本落 2（不叠加两套字段）')
}

// ── 8. 报表与明细始终一致 ─────────────────────────────────────────────────
console.log('\n[8] 报表（统计/CSV）与明细一致')
clearAll()
{
  const detail = service.listEntries('overhaul').items
  const csv = service.exportEntries('overhaul').content
  const dataLines = csv.split('\n').slice(1).filter(Boolean)
  assert(dataLines.length === detail.length, `CSV 行数=${dataLines.length} 与明细=${detail.length} 一致`)
  const maintaining = detail.filter((r) => r.status === '检修中').length
  const maintainingUnits = new Set(detail.filter((r) => r.status === '检修中').map((r) => r['检修机组'])).size
  assert(service.overhaulStats().maintaining === maintainingUnits, `统计口径按机组去重：${maintainingUnits}（检修中行数 ${maintaining}）`)
  const gen = service.listEntries('generation').items
  assert(gen.every((p) => p['检修中机组台数'] === service.overhaulStats().maintaining),
    '发电计划报表台数 = 检修明细台数')
  const genCsv = service.exportEntries('generation').content.split('\n').slice(1).filter(Boolean)
  assert(genCsv.length === gen.length, '发电计划 CSV 与明细行数一致')
}

console.log('\n校验完成。')
