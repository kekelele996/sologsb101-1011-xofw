<script setup lang="ts">
/**
 * 外业工作台：/stations/:id/sections 断面测次列表
 * 外业管测次采集字段（水位 / 现场测法 / 起点距 / 时间）、垂线测深与流速；
 * 「交回」把成果交给站上复核，已交回 / 已采用的测次在外业侧只读。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Promotion, Timer, RefreshLeft, Unlock } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { MEASURE_METHODS, type MeasureMethod, type Section } from '@/types/section'
import { LINE_NOS } from '@/types/station'
import { HANDOFF_STATUS_LABEL, HANDOFF_STATUS_TAG_TYPE, isFieldEditable } from '@/types/handoff'
import { submitSection, reopenForRevision } from '@/utils/handoff'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  stageM: 0,
  method: '流速仪' as MeasureMethod,
  targetLineNo: 'A',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const sectionRows = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  return list.filter((section) => {
    const keyword = sectionStore.filter.keyword.trim()
    if (
      keyword.length > 0 &&
      !`${section.measureNo}${section.method}${section.determinedMethod ?? ''}`.includes(keyword)
    )
      return false
    if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
    if (sectionStore.filter.minStageM !== null && section.stageM < sectionStore.filter.minStageM) return false
    if (sectionStore.filter.statuses.length > 0 && !sectionStore.filter.statuses.includes(section.handoffStatus))
      return false
    return true
  })
})

const filterModel = computed<FilterModel>(() => ({
  keyword: sectionStore.filter.keyword,
  methods: sectionStore.filter.methods,
  minStageM: sectionStore.filter.minStageM
}))

const stats = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  const stages = list.map((section) => section.stageM)
  const verticalCount = list.reduce(
    (sum, section) => sum + (sectionStore.sectionVerticalCounts[section.id] ?? 0),
    0
  )
  return {
    count: list.length,
    maxStageM: stages.length ? Math.max(...stages) : null,
    minStageM: stages.length ? Math.min(...stages) : null,
    latest: list.reduce<Section | null>((acc, section) => {
      if (!acc) return section
      return Date.parse(section.measuredAt) > Date.parse(acc.measuredAt) ? section : acc
    }, null),
    verticalCount,
    currentStageM: list.length ? list[0].stageM : null,
    pendingCount: list.filter((section) => section.handoffStatus === 'submitted').length,
    returnedCount: list.filter((section) => section.handoffStatus === 'returned').length
  }
})

function openCreate(): void {
  editingId.value = null
  form.measureNo = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(
    stats.value.count + 1
  ).padStart(3, '0')}`
  form.startDistanceM = stats.value.latest?.startDistanceM ?? 0
  form.stageM = stats.value.latest?.stageM ?? 0
  form.method = '流速仪'
  form.targetLineNo = stats.value.latest?.targetLineNo ?? 'A'
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(section: Section): void {
  if (!isFieldEditable(section.handoffStatus)) {
    ElMessage.info('该测次已交回站上，外业侧只读')
    return
  }
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.stageM = section.stageM
  form.method = section.method
  form.targetLineNo = section.targetLineNo
  form.measuredAt = section.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.measureNo.trim()) {
    ElMessage.warning('请填写测次号')
    return
  }
  if (!Number.isFinite(form.stageM) || form.stageM <= -50 || form.stageM > 200) {
    ElMessage.warning('水位应在 -50 ~ 200 m 之间')
    return
  }
  if (!Number.isFinite(form.startDistanceM) || form.startDistanceM < 0) {
    ElMessage.warning('起点距应为非负数字（m）')
    return
  }
  if (!form.measuredAt) {
    ElMessage.warning('请选择测流时间')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: stationId.value,
      measureNo: form.measureNo.trim(),
      startDistanceM: form.startDistanceM,
      stageM: form.stageM,
      method: form.method,
      targetLineNo: form.targetLineNo,
      measuredAt: new Date(form.measuredAt).toISOString()
    }
    if (editingId.value) {
      await sectionStore.updateSection(editingId.value, payload)
      ElMessage.success('测次已更新（仅外业采集字段）')
    } else {
      const created = await sectionStore.createSection(payload)
      sectionStore.selectSection(created.id)
      ElMessage.success(`测次已新增，当前水位 ${created.stageM.toFixed(2)} m`)
    }
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function removeSection(section: Section): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除测次「${section.measureNo}」将同时删除其垂线、流速测点与相关计算，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await sectionStore.removeSection(section.id)
    ElMessage.success('测次及其垂线测点已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

/** 外业交回：按当前测深/流速重算并固化流量，提交站上复核 */
async function handoff(section: Section): Promise<void> {
  try {
    const { value: note } = await ElMessageBox.prompt(
      `确认交回测次「${section.measureNo}」？交回时将按当前垂线测深与流速测点重算并固化断面流量，交回后外业数据冻结，等待站上测法认定与复核。`,
      '交回站上复核',
      {
        confirmButtonText: '交回',
        cancelButtonText: '取消',
        inputType: 'textarea',
        inputPlaceholder: '交回备注（可选）：如三点法、主流稳定…',
        inputValue: section.handoffNote
      }
    )
    await submitSection(section.id, { targetLineNo: section.targetLineNo || form.targetLineNo, handoffNote: note ?? '' })
    ElMessage.success(
      section.handoffStatus === 'returned' ? '已重新交回，等待站上复核' : '测次已交回，等待站上测法认定与复核'
    )
  } catch (error) {
    if (error === 'cancel' || (error as { message?: string })?.message === 'cancel') return
    ElMessage.error(error instanceof Error ? error.message : '交回失败')
  }
}

function gotoVerticals(section: Section): void {
  sectionStore.selectSection(section.id)
  void router.push(`/sections/${section.id}/verticals`)
}

/** 外业对已采用测次申请修订：accepted → draft，已发布版本保留可查 */
async function reopen(section: Section): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `申请修订已采用测次「${section.measureNo}」？测次将回到外业编辑中，修订后重新交回、站上复核通过才发布新版；此前已发布那版定线照旧可查。`,
      '申请修订',
      { type: 'warning', confirmButtonText: '申请修订', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await reopenForRevision(section.id)
    ElMessage.success('测次已回到外业编辑中，可修改测深 / 流速后重新交回')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '操作失败')
  }
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(sectionStore.filter.keyword.trim() ? { kw: sectionStore.filter.keyword.trim() } : {}),
      ...(sectionStore.filter.methods.length ? { methods: sectionStore.filter.methods.join(',') } : {}),
      ...(sectionStore.filter.minStageM !== null ? { minStage: String(sectionStore.filter.minStageM) } : {})
    }
  })
}

function handleReset(): void {
  sectionStore.resetFilter()
  void router.replace({ query: {} })
}

function reseedIfEmpty(): void {
  if (stationStore.stations.length === 0) void initDatabase()
}

function statusTagType(section: Section): 'info' | 'warning' | 'danger' | 'success' {
  return HANDOFF_STATUS_TAG_TYPE[section.handoffStatus]
}

onMounted(() => {
  reseedIfEmpty()
  const query = route.query
  sectionStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    methods: typeof query.methods === 'string' ? (query.methods.split(',') as MeasureMethod[]) : [],
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null,
    statuses: []
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <el-skeleton v-if="!stationStore.ready" :rows="5" animated />

    <RouteMissingPanel
      v-else-if="!station"
      entity-label="测站"
      :missing-id="stationId"
      fallback-path="/stations"
      fallback-text="返回测站台账"
      :candidates="
        stationStore.stations.slice(0, 3).map((item) => ({
          id: item.id,
          label: `${item.name} 的测次`,
          path: `/stations/${item.id}/sections`
        }))
      "
    />

    <template v-else>
      <div class="page__head">
        <div>
          <el-breadcrumb separator="/">
            <el-breadcrumb-item :to="{ path: '/stations' }">测站台账</el-breadcrumb-item>
            <el-breadcrumb-item>{{ station.name }}</el-breadcrumb-item>
            <el-breadcrumb-item>外业测次</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 断面测次（外业测验）
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="warning" effect="plain">外业</el-tag>
          </h2>
          <p class="gb-hint">
            外业管测深、流速与流量：录入水位与现场测法、布设垂线并录流速测点；测次交回后由站上做测法认定与定线发布。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge label="当前水位" :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)" suffix="m" tone="info" icon="Odometer" />
        <StatBadge label="已交回待复核" :value="stats.pendingCount" suffix="次" tone="warning" icon="Promotion" />
        <StatBadge label="退回重试" :value="stats.returnedCount" suffix="次" tone="danger" icon="RefreshLeft" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '现场测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
        ]"
        :number-ranges="[{ key: 'minStageM', label: '水位不低于', placeholder: '不限', unit: 'm' }]"
        keyword-placeholder="搜索测次号 / 测法"
        @change="handleFilterChange"
        @reset="handleReset"
      >
        <template #extra>
          <el-tag v-if="stats.latest" type="success" effect="plain">
            最新测次 {{ stats.latest.measureNo }} · 水位 {{ stats.latest.stageM.toFixed(2) }} m
          </el-tag>
        </template>
      </FilterBar>

      <EmptyPanel
        v-if="sectionRows.length === 0"
        :title="sectionStore.sectionsOfStation(stationId).length === 0 ? '该测站还没有测次' : '没有符合条件的测次'"
        description="新增一次流量测验后，即可布设垂线、录入测深与流速测点；完成后交回站上复核。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact" row-key="id">
        <el-table-column prop="measureNo" label="测次号" min-width="140" />
        <el-table-column label="交回状态" width="128">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row)" effect="plain">
              {{ HANDOFF_STATUS_LABEL[row.handoffStatus as Section['handoffStatus']] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="现场测法 / 站上认定" width="190">
          <template #default="{ row }">
            <div class="page__method-cell">
              <el-tag size="small" :type="row.method === 'ADCP' ? 'success' : row.method === '浮标' ? 'warning' : 'primary'" effect="plain">
                {{ row.method }}
              </el-tag>
              <span class="gb-hint">→</span>
              <el-tag size="small" :type="row.determinedMethod ? 'success' : 'info'" effect="dark">
                {{ row.determinedMethod ?? '未认定' }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业断面流量 (m³/s)" width="170" align="right">
          <template #default="{ row }">
            <span class="gb-mono" :class="{ 'page__flow-pending': row.fieldFlowM3s === 0 }">
              {{ row.fieldFlowM3s > 0 ? row.fieldFlowM3s.toFixed(2) : '待计算' }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="拟并定线" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.targetLineNo || 'A' }} 线</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="垂线" width="84" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.id] ?? 0 }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="测流时间" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业操作" width="290" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">
              {{ isFieldEditable(row.handoffStatus) ? '垂线/测点' : '查看' }}
            </el-button>
            <el-button
              v-if="isFieldEditable(row.handoffStatus)"
              size="small"
              :icon="Edit"
              @click="openEdit(row)"
            >编辑</el-button>
            <el-button
              v-if="isFieldEditable(row.handoffStatus)"
              size="small"
              type="success"
              plain
              :icon="Promotion"
              @click="handoff(row)"
            >{{ row.handoffStatus === 'returned' ? '重新交回' : '交回' }}</el-button>
            <el-button
              v-if="isFieldEditable(row.handoffStatus)"
              size="small"
              type="danger"
              plain
              :icon="Delete"
              @click="removeSection(row)"
            >删除</el-button>
            <el-button
              v-else-if="row.handoffStatus === 'accepted'"
              size="small"
              type="warning"
              plain
              :icon="Unlock"
              @click="reopen(row)"
            >申请修订</el-button>
            <span v-else class="gb-hint page__locked">外业只读</span>
          </template>
        </el-table-column>
        <template #expanded-row="{ row }">
          <div class="page__detail">
            <template v-if="row.handoffStatus === 'returned'">
              <el-alert
                type="error"
                :closable="false"
                show-icon
                :title="`退回原因（${row.returnedAt ? new Date(row.returnedAt).toLocaleString('zh-CN') : ''}，已退回 ${row.returnCount} 次）：${row.returnReason || '（未填写原因）'}`"
              />
              <p class="gb-hint">外业留在原处修改测深 / 流速后点「重新交回」；已发布的那版定线不受影响、照旧可查。</p>
            </template>
            <template v-else-if="row.handoffStatus === 'accepted'">
              <el-alert
                type="success"
                :closable="false"
                :title="`已被 ${row.acceptedLineNo} 线定线采用${row.acceptedAt ? `（${new Date(row.acceptedAt).toLocaleString('zh-CN')}）` : ''}；如需修订测深流速，可申请修订后重新交回，已发布版本保留可查。`"
              />
            </template>
            <template v-else>
              <p class="gb-hint">交回备注：{{ row.handoffNote || '（无）' }} · 断面面积 {{ row.fieldAreaM2?.toFixed?.(2) ?? '—' }} m² · 平均流速 {{ row.fieldMeanVelocityMs?.toFixed?.(3) ?? '—' }} m/s</p>
            </template>
          </div>
        </template>
      </el-table>

      <p class="gb-hint">
        <el-icon><Timer /></el-icon>
        流量按外业算：交回时按部分面积法固化断面流量，站上不改写流量数值；测法认定听站上，现场记录与站上认定分列显示、互不覆盖。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次（外业采集字段）' : '新增断面测次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="现场测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
          <p class="gb-hint">外业现场记录；最终采用测法由站上认定。</p>
        </el-form-item>
        <el-form-item label="拟并定线号" required>
          <el-select v-model="form.targetLineNo" class="page__line-select">
            <el-option v-for="lineNo in LINE_NOS" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
          </el-select>
          <span class="page__unit">交回后由站上复核并入</span>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="起点距" required>
          <el-input-number v-model="form.startDistanceM" :min="0" :max="2000" :step="0.5" :precision="1" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="测流时间" required>
          <el-date-picker v-model="form.measuredAt" type="datetime" placeholder="选择测流时间" value-format="YYYY-MM-DDTHH:mm" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存修改' : '新增并布设垂线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 8px 0 4px;
  font-size: 18px;
  color: #0f4c75;
}

.page__tag {
  font-weight: 400;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__method-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__flow-pending {
  color: #b06a00;
}

.page__locked {
  margin-left: 6px;
}

.page__line-select {
  width: 120px;
}

.page__detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 10px;
}
</style>
