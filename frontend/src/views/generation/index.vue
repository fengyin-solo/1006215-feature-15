<template>
  <section class="page" data-module="generation">
    <header class="page-head">
      <div>
        <h2>发电计划管理</h2>
        <p class="page-desc">维护发电计划，围绕计划编号、计划日期、计划出力、实际出力做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发电计划</button>
        <button class="btn" type="button" @click="exportRows">导出发电计划清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="capacity-hint">
      机组可调容量 = 机组总台数 − 检修中机组台数；检修中的机组不计入可调容量。
      检修中机组台数与机组检修页同源，两处读数始终一致。
    </p>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无发电计划数据，可先登记发电计划</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条发电计划记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  generationCapacity,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { CapacityInfo, EntryRow } from '@/data/types'

const meta = moduleMeta('generation')
const columns = ["计划编号", "计划日期", "计划出力", "实际出力", "日发电量", "上网电量", "完成比率", "计划状态"]
const actions = ["提交编制", "下达计划", "确认完成"]
const statuses = ["待编制", "已下达", "执行中", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const capacity = ref<CapacityInfo>({ totalUnits: 0, repairingUnits: 0, availableUnits: 0 })

const statCards = computed(() => [
  { label: '机组总台数（台）', value: capacity.value.totalUnits },
  { label: '检修中机组（台）', value: capacity.value.repairingUnits },
  { label: '机组可调容量（台）', value: capacity.value.availableUnits },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '发电计划登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    capacity.value = generationCapacity()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电计划列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.capacity-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 0 0 10px;
}
</style>
