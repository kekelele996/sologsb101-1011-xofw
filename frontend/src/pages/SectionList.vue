<script setup lang="ts">
/**
 * 模块 2：/stations/:id/sections 断面测次列表与测法标记
 * 新增测次后回显当前水位；深链访问时若测站不存在给出友好空态。
 *
 * 外业 / 站上两侧分开：
 * - 外业侧：录入测深、流速、流量，草稿 / 退回测次可「交回」站上复核；
 * - 站上侧：对已交回测次做测法认定与定线发布（复核通过发新版本，退回则外业重试）。
 * 两侧动过同一测次时流量按外业算、测法认定听站上，不互相覆盖。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Right, Timer, Upload, RefreshLeft, Check, Close } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import RouteMissingPanel from '@/components/common/RouteMissingPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import {
  MEASURE_METHODS,
  SIDE_LABELS,
  SURVEY_STATUS_LABELS,
  SURVEY_STATUS_TAG_TYPE,
  type MeasureMethod,
  type Section,
  type SurveySide,
  type SurveyStatus
} from '@/types/section'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()

const stationId = computed(() => String(route.params.id ?? ''))
const station = computed(() => stationStore.stationById(stationId.value))

/** 侧别 / 状态展示辅助（模板中不能直接引用类型，故用函数收窄） */
function sideLabel(side: string): string {
  return SIDE_LABELS[side as SurveySide] ?? side
}
function statusLabel(status: string): string {
  return SURVEY_STATUS_LABELS[status as SurveyStatus] ?? status
}
function statusTagType(status: string): 'info' | 'warning' | 'success' | 'danger' {
  return SURVEY_STATUS_TAG_TYPE[status as SurveyStatus] ?? 'info'
}

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  measureNo: '',
  startDistanceM: 0,
  stageM: 0,
  method: '流速仪' as MeasureMethod,
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 站上复核弹窗 */
const reviewVisible = ref(false)
const reviewSubmitting = ref(false)
const reviewForm = reactive({
  method: '流速仪' as MeasureMethod,
  lineNo: 'A',
  note: ''
})
const reviewingSection = ref<Section | null>(null)
/** 待复核测次的外业断面流量（部分面积法） */
const reviewDischarge = ref(0)

const sectionRows = computed(() => {
  const list = sectionStore.sectionsOfStation(stationId.value)
  return list.filter((section) => {
    const keyword = sectionStore.filter.keyword.trim()
    if (keyword.length > 0 && !`${section.measureNo}${section.method}`.includes(keyword)) return false
    if (sectionStore.filter.methods.length > 0 && !sectionStore.filter.methods.includes(section.method)) return false
    if (sectionStore.filter.minStageM !== null && section.stageM < sectionStore.filter.minStageM) return false
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
    currentStageM: list.length ? list[0].stageM : null
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
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(section: Section): void {
  editingId.value = section.id
  form.measureNo = section.measureNo
  form.startDistanceM = section.startDistanceM
  form.stageM = section.stageM
  form.method = section.method
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
      measuredAt: new Date(form.measuredAt).toISOString()
    }
    if (editingId.value) {
      await sectionStore.updateSection(editingId.value, payload)
      ElMessage.success('测次已更新')
    } else {
      const created = await sectionStore.createSection(payload)
      sectionStore.selectSection(created.id)
      ElMessage.success(`测次已新增，当前水位 ${created.stageM.toFixed(2)} m`)
    }
    dialogVisible.value = false
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
  await sectionStore.removeSection(section.id)
  ElMessage.success('测次及其垂线测点已删除')
}

/** 外业交回：草稿 / 退回 → 已交回，待站上复核 */
async function submitSection(section: Section): Promise<void> {
  const discharge = sectionStore.sectionDischarge(section.id)
  try {
    await ElMessageBox.confirm(
      `将测次「${section.measureNo}」交回站上复核？交回后外业测点不可再改，断面流量 ${discharge.toFixed(2)} m³/s 按外业成果带入。`,
      '交回确认',
      { type: 'info', confirmButtonText: '交回站上', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await sectionStore.submitSection(section.id)
  ElMessage.success('测次已交回，等待站上复核')
}

/** 站上复核：打开复核弹窗，回显外业测法与断面流量 */
function openReview(section: Section): void {
  reviewingSection.value = section
  reviewForm.method = section.methodObserved ?? section.method
  reviewForm.lineNo = ratingStore.activeLineNo
  reviewForm.note = ''
  reviewDischarge.value = sectionStore.sectionDischarge(section.id)
  reviewVisible.value = true
}

/** 站上复核通过：认定测法、生成关系点据、发布定线新版本 */
async function approveReview(): Promise<void> {
  if (!reviewingSection.value) return
  if (!reviewForm.lineNo.trim()) {
    ElMessage.warning('请填写定线号')
    return
  }
  reviewSubmitting.value = true
  try {
    const section = reviewingSection.value
    const lineNo = reviewForm.lineNo.trim()
    // 测法认定听站上
    await sectionStore.approveSection(section.id, { method: reviewForm.method, reviewNote: reviewForm.note || '复核通过，同意发布' })
    // 流量按外业算：由断面流量生成关系点据
    await ratingStore.upsertRatingFromSection(section, reviewDischarge.value, lineNo)
    // 重新拟合，发新的一版
    await ratingStore.publishVersion(lineNo, reviewForm.note || '复核通过，同意发布')
    await ratingStore.rebuildCompares(lineNo)
    ElMessage.success(`复核通过，${lineNo} 线已定线发布新版本`)
    reviewVisible.value = false
  } finally {
    reviewSubmitting.value = false
  }
}

/** 站上复核退回：外业留在原处重试，已发布版本照旧可查 */
async function rejectReview(): Promise<void> {
  if (!reviewingSection.value) return
  if (!reviewForm.note.trim()) {
    ElMessage.warning('请填写退回意见，外业据此重试')
    return
  }
  reviewSubmitting.value = true
  try {
    await sectionStore.rejectSection(reviewingSection.value.id, reviewForm.note.trim())
    ElMessage.success('已退回，外业留在原处重试')
    reviewVisible.value = false
  } finally {
    reviewSubmitting.value = false
  }
}

/** 外业重试：退回 → 草稿，不新建测次，原处修改后重新交回 */
async function retrySection(section: Section): Promise<void> {
  await sectionStore.retrySection(section.id)
  ElMessage.success('已退回草稿，可在原处修改后重新交回')
}

function gotoVerticals(section: Section): void {
  sectionStore.selectSection(section.id)
  void router.push(`/sections/${section.id}/verticals`)
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

onMounted(() => {
  reseedIfEmpty()
  const query = route.query
  sectionStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    methods: typeof query.methods === 'string' ? (query.methods.split(',') as MeasureMethod[]) : [],
    minStageM: typeof query.minStage === 'string' ? Number(query.minStage) : null
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
            <el-breadcrumb-item>断面测次</el-breadcrumb-item>
          </el-breadcrumb>
          <h2 class="page__title">
            {{ station.name }} · 断面测次
            <el-tag size="small" effect="plain" class="page__tag">{{ station.sectionCode }}</el-tag>
            <el-tag size="small" type="info" effect="plain">{{ station.river }}</el-tag>
          </h2>
          <p class="gb-hint">
            集水面积 {{ station.catchmentKm2 }} km²。每次测流记录测次号、起点距、水位与测法，随后布设垂线并录流速测点。
          </p>
        </div>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增测次</el-button>
      </div>

      <div class="gb-stats-row">
        <StatBadge label="测次总数" :value="stats.count" suffix="次" icon="Files" />
        <StatBadge
          label="当前水位"
          :value="stats.currentStageM === null ? '—' : stats.currentStageM.toFixed(2)"
          suffix="m"
          tone="info"
          icon="Odometer"
        />
        <StatBadge
          label="水位变幅"
          :value="stats.minStageM === null ? '—' : `${stats.minStageM.toFixed(2)} ~ ${stats.maxStageM?.toFixed(2)}`"
          suffix="m"
          tone="warning"
          icon="TrendCharts"
        />
        <StatBadge label="垂线合计" :value="stats.verticalCount" suffix="条" tone="success" icon="Histogram" />
      </div>

      <FilterBar
        :model-value="filterModel"
        :selects="[
          { key: 'methods', label: '测法', options: MEASURE_METHODS.map((method) => ({ label: method, value: method })) }
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
        description="新增一次流量测验后，即可布设垂线、录入测深与流速测点。"
        action-text="新增测次"
        secondary-text="重置筛选"
        @action="openCreate"
        @secondary="handleReset"
      />

      <el-table v-else :data="sectionRows" border stripe class="gb-table-compact">
        <el-table-column prop="measureNo" label="测次号" min-width="150" />
        <el-table-column label="侧别" width="90" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="row.side === 'field' ? 'primary' : 'success'" effect="plain">
              {{ sideLabel(row.side) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)" effect="dark">
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="测法认定" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="row.method === 'ADCP' ? 'success' : row.method === '浮标' ? 'warning' : 'primary'" effect="plain">
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="110" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="断面流量 (m³/s)" width="130" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ sectionStore.sectionDischarge(row.id).toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="起点距 (m)" width="120" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDistanceM.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="垂线条数" width="110" align="center">
          <template #default="{ row }">
            <el-button text type="primary" size="small" @click="gotoVerticals(row)">
              {{ sectionStore.sectionVerticalCounts[row.id] ?? 0 }} 条
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="测流时间" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button size="small" type="primary" :icon="Right" @click="gotoVerticals(row)">垂线</el-button>
            <el-button size="small" :icon="Edit" @click="openEdit(row)">编辑</el-button>
            <el-button
              v-if="row.status === 'draft' || row.status === 'rejected'"
              size="small"
              type="warning"
              :icon="Upload"
              @click="submitSection(row)"
            >交回</el-button>
            <el-button
              v-if="row.status === 'rejected'"
              size="small"
              type="info"
              :icon="RefreshLeft"
              @click="retrySection(row)"
            >重试</el-button>
            <el-button
              v-if="row.status === 'returned'"
              size="small"
              type="success"
              :icon="Check"
              @click="openReview(row)"
            >复核</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeSection(row)">删除</el-button>
          </template>
        </el-table-column>
        <template #empty>
          <EmptyPanel title="暂无测次" description="点击右上角「新增测次」开始录入。" compact />
        </template>
      </el-table>

      <p class="gb-hint">
        <el-icon><Timer /></el-icon>
        提示：测次的水位将参与水位流量关系点据定线；同一测次下的垂线按起点距升序参与部分面积法流量计算。
      </p>
    </template>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑测次' : '新增断面测次'" width="560px" :close-on-click-modal="false">
      <el-form label-width="104px">
        <el-form-item label="测次号" required>
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="测法" required>
          <el-radio-group v-model="form.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
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

    <el-dialog v-model="reviewVisible" title="站上复核 · 测法认定与定线发布" width="600px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        title="流量按外业算（部分面积法），测法认定听站上；复核通过才发新的一版，退回则外业留在原处重试。"
        class="page__review-alert"
      />
      <el-descriptions :column="2" border size="small" class="page__review-desc">
        <el-descriptions-item label="测次号">{{ reviewingSection?.measureNo }}</el-descriptions-item>
        <el-descriptions-item label="外业观测测法">{{ reviewingSection?.methodObserved ?? reviewingSection?.method }}</el-descriptions-item>
        <el-descriptions-item label="水位 (m)">{{ reviewingSection?.stageM.toFixed(2) }}</el-descriptions-item>
        <el-descriptions-item label="外业断面流量 (m³/s)">
          <span class="gb-mono">{{ reviewDischarge.toFixed(2) }}</span>
        </el-descriptions-item>
      </el-descriptions>
      <el-form label-width="104px" class="page__review-form">
        <el-form-item label="测法认定" required>
          <el-radio-group v-model="reviewForm.method">
            <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="reviewForm.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="复核意见">
          <el-input v-model="reviewForm.note" type="textarea" :rows="2" placeholder="复核通过 / 退回原因" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="reviewVisible = false">取消</el-button>
        <el-button type="danger" plain :icon="Close" :loading="reviewSubmitting" @click="rejectReview">退回外业重试</el-button>
        <el-button type="success" :icon="Check" :loading="reviewSubmitting" @click="approveReview">复核通过并发布</el-button>
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

.page__review-alert {
  margin-bottom: 12px;
}

.page__review-desc {
  margin-bottom: 12px;
}

.page__review-form {
  margin-top: 4px;
}
</style>
