<template>
  <section class="page" data-module="generation">
    <header class="page-head">
      <div>
        <h2>发电计划管理</h2>
        <p class="page-desc">机组可调容量由检修工作票回写：检修中机组不计入可调容量，本页台数与「机组检修」页完全一致。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记发电计划</button>
        <button class="btn" type="button" @click="exportRows">导出发电计划清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">检修中机组（工作票回写）</span>
        <strong class="stat-value">{{ snapshot.maintenanceCount }}</strong>
        <span class="page-desc">{{ snapshot.maintenanceUnits.join('、') || '无' }}</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">机组可调容量(MW)</span>
        <strong class="stat-value">{{ snapshot.adjustableMw }}</strong>
        <span class="page-desc">总装机 {{ snapshot.totalMw }} − 检修占用 {{ snapshot.maintenanceMw }}</span>
      </article>
      <article class="stat-card">
        <span class="stat-label">在册机组台数</span>
        <strong class="stat-value">{{ snapshot.totalUnits }}</strong>
        <span class="page-desc">检修 {{ snapshot.maintenanceCount }} 台，其余可参与计划</span>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item">报表与明细同源：台数取自同一份工作票结论</span>
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
      <span>共 {{ total }} 条发电计划记录；检修中机组台数与机组检修页一致：{{ snapshot.maintenanceCount }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  capacitySnapshot,
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { CapacitySnapshot, EntryRow } from '@/data/types'

const meta = moduleMeta('generation')
const columns = meta.fields
const actions = ["提交编制", "下达计划", "确认完成"]
const statuses = ["待编制", "已下达", "执行中", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const snapshot = ref<CapacitySnapshot>(capacitySnapshot())
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
    // 每次进页面/流转后重读快照，保证与机组检修页取值一致。
    snapshot.value = capacitySnapshot()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '发电计划列表读取失败'
  }
}

onMounted(reload)
</script>
