<template>
  <section class="page" data-module="overhaul">
    <header class="page-head">
      <div>
        <h2>机组检修管理</h2>
        <p class="page-desc">工作票沿 待审批→已批准→检修中→已完工 单向推进：已批准才能开工，检修中才能办理完工；已完工即归档，回不到检修中。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修工作票</button>
        <button class="btn" type="button" @click="exportRows">导出机组检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">可调容量：{{ snapshot.adjustableMw }}MW（总装机 {{ snapshot.totalMw }}MW，检修占用 {{ snapshot.maintenanceMw }}MW）</span>
    </p>

    <section v-if="gaps.length" class="gap-panel">
      <h3>缺值单独列示（{{ gaps.length }} 张票）</h3>
      <p class="page-desc">迁移与日常校验发现的应填未填项，不虚构补值；早期完工票缺验收人的，由当值验收人补记后销项。</p>
      <table class="data-table">
        <thead>
          <tr><th>工作票号</th><th>检修机组</th><th>当前状态</th><th>缺失项</th><th>处理</th></tr>
        </thead>
        <tbody>
          <tr v-for="gap in gaps" :key="gap.id">
            <td>{{ gap.工作票号 }}</td>
            <td>{{ gap.检修机组 }}</td>
            <td>{{ gap.status }}</td>
            <td class="error-text">{{ gap.missing.join('、') }}</td>
            <td>
              <button
                v-if="gap.missing.includes('验收人员') && gap.status === '已完工'"
                class="link"
                type="button"
                @click="openSupplement(gap.id)"
              >
                补记验收人
              </button>
              <span v-else class="page-desc">按当前状态补齐资料</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ displayValue(row, column) }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.archived" class="tag tag-archived">已归档</span>
            <span v-else-if="hasReservation(row)" class="tag tag-reserved">保留待消缺</span>
          </td>
          <td class="row-actions">
            <template v-if="!row.archived && row.status !== '已完工'">
              <button class="link" type="button" @click="runAction('提交审批', row)">提交审批</button>
              <button class="link" type="button" @click="runAction('开工检修', row)">开工检修</button>
              <button class="link" type="button" @click="openComplete(row)">办理完工</button>
            </template>
            <span v-else class="page-desc">归档只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机组检修数据，可先登记检修工作票</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条机组检修记录，数据已持久化在本机浏览器，重新进入页面仍然保留</span>
      <span v-if="message" :class="messageOk ? 'success-text' : 'error-text'">{{ message }}</span>
    </footer>

    <div v-if="completeRow" class="modal-mask" @click.self="closeComplete">
      <form class="modal-card" @submit.prevent="submitComplete">
        <h3>办理完工验收 · {{ completeRow['工作票号'] }}（{{ completeRow['检修机组'] }}）</h3>
        <label class="filter-item">
          <span>验收人员 *</span>
          <input v-model="completeForm.验收人员" placeholder="必须登记验收人员" />
        </label>
        <label class="filter-item">
          <span>验收结论 *</span>
          <select v-model="completeForm.验收结论">
            <option value="合格">合格（归档，机组可复役）</option>
            <option value="有保留意见">有保留意见（退回检修中，机组不可复役）</option>
          </select>
        </label>
        <label v-if="completeForm.验收结论 === '有保留意见'" class="filter-item">
          <span>保留项 *</span>
          <textarea v-model="completeForm.保留意见" rows="3" placeholder="写明保留内容与后续消缺要求"></textarea>
        </label>
        <label class="filter-item">
          <span>实际完工时间</span>
          <input v-model="completeForm.实际完工时间" placeholder="留空按当前时间；重复办理以本次时间覆盖旧值" />
        </label>
        <p class="page-desc">提交内置断线重试一次；同一弹窗重复提交只生效一次。</p>
        <div class="modal-actions">
          <button class="btn primary" type="submit">确认提交验收</button>
          <button class="btn ghost" type="button" @click="closeComplete">取消</button>
        </div>
      </form>
    </div>

    <div v-if="supplementId !== null" class="modal-mask" @click.self="supplementId = null">
      <form class="modal-card" @submit.prevent="submitSupplement">
        <h3>补记历史票验收人 · 工作票 {{ supplementId }}</h3>
        <p class="page-desc">裁决口径：早期没有验收人的票不虚构、不倒填时间，由当值验收人补记；归档状态与实际完工时间不变。</p>
        <label class="filter-item">
          <span>验收人员 *</span>
          <input v-model="supplementForm.验收人员" placeholder="补记验收人姓名" />
        </label>
        <label class="filter-item">
          <span>验收结论 *</span>
          <select v-model="supplementForm.验收结论">
            <option value="合格">合格</option>
            <option value="有保留意见">有保留意见</option>
          </select>
        </label>
        <label v-if="supplementForm.验收结论 === '有保留意见'" class="filter-item">
          <span>保留项 *</span>
          <textarea v-model="supplementForm.保留意见" rows="3"></textarea>
        </label>
        <div class="modal-actions">
          <button class="btn primary" type="submit">保存补记</button>
          <button class="btn ghost" type="button" @click="supplementId = null">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  capacitySnapshot,
  completeOverhaul,
  downloadEntries,
  listEntries,
  moduleMeta,
  overhaulGaps,
  overhaulStats,
  runAction as applyAction,
  supplementAcceptance,
} from '@/api/local-service'
import type { CapacitySnapshot, EntryRow, OverhaulCompletion } from '@/data/types'

const meta = moduleMeta('overhaul')
const columns = meta.fields
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const gaps = ref(overhaulGaps())
const snapshot = ref<CapacitySnapshot>(capacitySnapshot())

const stats = computed(() => {
  const summary = overhaulStats()
  return [
    { label: '待审批工作票', value: summary.pending },
    { label: '检修中机组', value: summary.maintaining },
    { label: '已完工检修（归档）', value: summary.archived },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function displayValue(row: EntryRow, column: string): string {
  const value = row[column]
  if (value === undefined || value === null || String(value) === '') {
    return column === '验收人员' && row.archived ? '待补记' : '—'
  }
  return String(value)
}

function hasReservation(row: EntryRow): boolean {
  return String(row['验收结论'] ?? '') === '有保留意见'
}

function notify(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  notify(false, '检修工作票登记入口尚未接入审批流')
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  notify(result.ok, result.message)
  reload()
}

// ── 办理完工验收 ────────────────────────────────────────────────────────────

const completeRow = ref<EntryRow | null>(null)
const completeForm = ref<OverhaulCompletion>({ 验收人员: '', 验收结论: '合格', 保留意见: '', 实际完工时间: '' })
const idemKey = ref('')

function openComplete(row: EntryRow) {
  completeRow.value = row
  completeForm.value = { 验收人员: '', 验收结论: '合格', 保留意见: '', 实际完工时间: '' }
  // 每次打开弹窗发一把新钥匙：同一次提交（含内部重试/双击）只生效一次。
  idemKey.value = `complete-${row.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function closeComplete() {
  completeRow.value = null
}

function submitComplete() {
  if (!completeRow.value) {
    return
  }
  const result = completeOverhaul(Number(completeRow.value.id), { ...completeForm.value }, idemKey.value)
  notify(result.ok, result.message)
  closeComplete()
  reload()
}

// ── 历史票补记验收人 ─────────────────────────────────────────────────────────

const supplementId = ref<number | null>(null)
const supplementForm = ref<Pick<OverhaulCompletion, '验收人员' | '验收结论' | '保留意见'>>({
  验收人员: '',
  验收结论: '合格',
  保留意见: '',
})

function openSupplement(id: number) {
  supplementId.value = id
  supplementForm.value = { 验收人员: '', 验收结论: '合格', 保留意见: '' }
}

function submitSupplement() {
  if (supplementId.value === null) {
    return
  }
  const result = supplementAcceptance(supplementId.value, { ...supplementForm.value })
  notify(result.ok, result.message)
  supplementId.value = null
  reload()
}

function reload() {
  message.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    gaps.value = overhaulGaps()
    snapshot.value = capacitySnapshot()
  } catch (error) {
    notify(false, error instanceof Error ? error.message : '机组检修列表读取失败')
  }
}

onMounted(reload)
</script>
