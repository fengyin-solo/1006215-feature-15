<template>
  <section class="page" data-module="overhaul">
    <header class="page-head">
      <div>
        <h2>机组检修管理</h2>
        <p class="page-desc">
          检修工作票按「待审批 → 已批准 → 检修中 → 已完工」单向推进：已批准才能开工检修，检修中才能办理完工，已完工即归档。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记检修工作票</button>
        <button class="btn" type="button" @click="exportRows">导出机组检修清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>

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
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.status === '已完工'" class="archived-tag">已归档</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <button
              v-if="row.status === '已完工'"
              class="link"
              type="button"
              @click="openCompletion(row, '补录')"
            >
              补录验收
            </button>
            <span v-if="!rowActions(row).length && row.status !== '已完工'" class="muted-text">
              无可执行动作
            </span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无机组检修数据，可先登记检修工作票</td>
        </tr>
      </tbody>
    </table>

    <section v-if="missingRows.length" class="missing-panel">
      <h3>缺值清单（已完工但验收人员待补签）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>工作票号</th>
            <th>检修机组</th>
            <th>实际完工时间</th>
            <th>验收结论</th>
            <th>缺值说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in missingRows" :key="String(row.id)">
            <td>{{ row['工作票号'] }}</td>
            <td>{{ row['检修机组'] }}</td>
            <td>{{ row['实际完工时间'] || '—' }}</td>
            <td>{{ row['验收结论'] || '—' }}</td>
            <td>早期完工票没有验收人，已补记「待补签」，请补录验收人</td>
            <td class="row-actions">
              <button class="link" type="button" @click="openCompletion(row, '补录')">补录验收</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条机组检修记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="dialogVisible" class="dialog-mask" @click.self="dialogVisible = false">
      <form class="dialog-card" @submit.prevent="submitCompletion">
        <h3>{{ dialogMode === '补录' ? '补录验收信息' : '办理完工' }}：{{ dialogRow?.['工作票号'] }}</h3>
        <label class="dialog-item">
          <span>验收人员 *</span>
          <input v-model="completionForm.验收人员" placeholder="填写验收人员姓名" />
        </label>
        <label class="dialog-item">
          <span>验收结论 *</span>
          <select v-model="completionForm.验收结论">
            <option value="合格">合格（允许机组复役）</option>
            <option value="有保留意见">有保留意见（退回检修中）</option>
          </select>
        </label>
        <label v-if="completionForm.验收结论 === '有保留意见'" class="dialog-item">
          <span>保留项 *</span>
          <input v-model="completionForm.保留项" placeholder="说明保留项，工作票将退回检修中" />
        </label>
        <label class="dialog-item">
          <span>实际完工时间</span>
          <input v-model="completionForm.实际完工时间" type="date" />
        </label>
        <p class="dialog-hint">
          重复提交只生效一次：已完工的票按最近一次生效的完工信息覆盖，不叠加。
        </p>
        <div class="dialog-actions">
          <button class="btn primary" type="submit">提交</button>
          <button class="btn ghost" type="button" @click="dialogVisible = false">取消</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  migrateOverhaul,
  moduleMeta,
  nextActions,
  overhaulMissing,
  overhaulStats,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('overhaul')
const columns = meta.fields
const statuses = meta.statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = ref(overhaulStats())
const missingRows = ref<EntryRow[]>([])

const dialogVisible = ref(false)
const dialogMode = ref<'完工' | '补录'>('完工')
const dialogRow = ref<EntryRow | null>(null)
const completionForm = ref({
  验收人员: '',
  验收结论: '合格',
  保留项: '',
  实际完工时间: '',
})

const statCards = computed(() => [
  { label: '待审批工作票', value: stats.value.pendingApproval },
  { label: '检修中机组（台）', value: stats.value.repairing },
  { label: '已完工检修', value: stats.value.completed },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowActions(row: EntryRow): string[] {
  return nextActions(meta.key, row)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '检修工作票登记入口尚未接入审批流'
}

function todayLocal(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function openCompletion(row: EntryRow, mode: '完工' | '补录') {
  dialogMode.value = mode
  dialogRow.value = row
  const acceptor = String(row['验收人员'] ?? '')
  completionForm.value = {
    验收人员: acceptor === '待补签' ? '' : acceptor,
    验收结论: '合格',
    保留项: '',
    实际完工时间: String(row['实际完工时间'] ?? '') || todayLocal(),
  }
  dialogVisible.value = true
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '办理完工') {
    openCompletion(row, '完工')
    return
  }
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function submitCompletion() {
  const row = dialogRow.value
  if (!row) {
    return
  }
  const result = applyAction(meta.key, Number(row.id), '办理完工', { ...completionForm.value })
  if (!result.ok) {
    errorMessage.value = result.message
    dialogVisible.value = false
    return
  }
  noticeMessage.value = result.message
  dialogVisible.value = false
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = overhaulStats()
    missingRows.value = overhaulMissing()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '机组检修列表读取失败'
  }
}

onMounted(() => {
  const migration = migrateOverhaul()
  if (migration.applied) {
    noticeMessage.value = `存量工作票已按发生时间迁移落库（${migration.migrated} 条），其中 ${migration.missing.length} 条缺验收人，已在缺值清单单独列示`
  }
  reload()
})
</script>

<style scoped>
.notice-text {
  color: #175cd3;
  font-size: 13px;
  margin: 0 0 10px;
}
.archived-tag {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 8px;
  border-radius: 999px;
  background: #eef2f7;
  color: var(--muted);
  font-size: 12px;
}
.muted-text {
  color: var(--muted);
  font-size: 12px;
}
.missing-panel {
  margin-top: 16px;
}
.missing-panel h3 {
  font-size: 14px;
  margin: 0 0 8px;
}
.dialog-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.dialog-card {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 380px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.dialog-card h3 {
  margin: 0;
  font-size: 15px;
}
.dialog-item span {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 4px;
}
.dialog-item input,
.dialog-item select {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}
.dialog-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0;
}
.dialog-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
