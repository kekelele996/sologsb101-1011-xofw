<script setup lang="ts">
/**
 * 站上工作台：/ratings 水位流量关系定线发布与版本
 * - 曲线参数以「当前发布版本」为准，外业改测点不会即时改变定线；
 * - 只有交回复核通过才发布新一版（复核动作在 /review）；历史版本冻结可查；
 * - 手工新增/编辑仅限无来源测次的历史遗留点据。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Delete, Document, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import type { Rating } from '@/types/rating'
import type { RatingVersion } from '@/types/ratingVersion'
import { RATING_VERSION_STATUS_LABEL } from '@/types/ratingVersion'
import { curveFlow } from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

/** 历史版本抽屉 */
const historyVisible = ref(false)
/** 版本历史折叠面板展开项 */
const activeHistory = ref<string[]>([])

const fit = computed(() => ratingStore.activeFit)
const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))
const currentVersion = computed<RatingVersion | null>(() => ratingStore.currentVersionOf(ratingStore.activeLineNo))
const lineVersions = computed<RatingVersion[]>(() => ratingStore.versionsOfLine(ratingStore.activeLineNo))

/** 当前版本快照点据（冻结），未发布过则回落到当前点据表 */
const pointRows = computed(() => {
  const version = currentVersion.value
  const fitValue = fit.value
  if (version) {
    return version.points
      .map((point) => {
        const rating = ratingStore.ratings.find((item) => item.id === point.ratingId) ?? null
        const predicted = fitValue.valid ? curveFlow(fitValue, point.stageM) : 0
        const residualPct =
          fitValue.valid && point.flowM3s > 0
            ? Number((((point.flowM3s - predicted) / point.flowM3s) * 100).toFixed(2))
            : 0
        const compare = ratingStore.compares.find(
          (item) => item.ratingId === point.ratingId && item.versionId === version.id
        )
        return {
          ratingId: point.ratingId,
          sectionId: point.sectionId,
          stationId: point.stationId,
          stageM: point.stageM,
          flowM3s: point.flowM3s,
          measureNo: point.measureNo,
          measuredAt: point.measuredAt,
          determinedMethod: point.determinedMethod,
          stationName: ratingStore.stationNameOf(point.stationId),
          predicted,
          residualPct,
          verdict: compare?.verdict ?? (Math.abs(residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
        }
      })
      .sort((a, b) => a.stageM - b.stageM)
  }
  return ratingStore.pointRows.map((row) => ({
    ratingId: row.rating.id,
    sectionId: row.rating.sectionId,
    stationId: row.rating.stationId,
    stageM: row.rating.stageM,
    flowM3s: row.rating.flowM3s,
    measureNo: row.rating.measureNo,
    measuredAt: row.rating.measuredAt,
    determinedMethod: row.rating.determinedMethod,
    stationName: row.stationName,
    predicted: row.predicted,
    residualPct: row.residualPct,
    verdict:
      ratingStore.compares.find((item) => item.ratingId === row.rating.id)?.verdict ??
      (Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
  }))
})

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量（按当前发布版参数） */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return { samples: '', points: [] as Array<{ id: string; cx: number; cy: number; verdict: string }>, stageMin: 0, stageMax: 0, flowMax: 0 }
  }
  const stages = rows.map((row) => row.stageM)
  const flows = rows.map((row) => row.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)
  const sampleCount = 13
  const samples = Array.from({ length: sampleCount }, (_, index) => {
    const stageM = stageMin + ((stageMax - stageMin) * index) / (sampleCount - 1 || 1)
    const value = fit.value.valid ? fit.value.a * Math.pow(Math.max(stageM - fit.value.h0, 1e-6), fit.value.b) : 0
    return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
  }).join(' ')
  return {
    samples,
    points: rows.map((row) => ({
      id: row.ratingId,
      cx: toX(row.stageM),
      cy: toY(row.flowM3s),
      verdict: row.verdict
    })),
    stageMin,
    stageMax,
    flowMax
  }
})

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  form.stageM = 3
  form.flowM3s = 50
  form.measureNo = ''
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  if (rating.sectionId !== null) {
    ElMessage.info('该点据来自外业交回测次，流量以测次成果为准，不能在此编辑')
    return
  }
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      await ratingStore.updateRating(editingId.value, payload)
      ElMessage.success('历史遗留点据已更新；需在复核台重新发布才会改变定线')
    } else {
      await ratingStore.createRating(payload)
      ElMessage.success('历史遗留点据已新增；交回复核发布后才会进入定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  if (rating.sectionId !== null) {
    ElMessage.info('该点据来自已采用测次，不能直接删除；请由外业修订测次后重新交回')
    return
  }
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的历史遗留点据？已发布版本中的快照保留可查。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await ratingStore.removeRating(rating.id)
    ElMessage.success('历史遗留点据已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除失败')
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

function gotoReview(): void {
  void router.push('/review')
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系定线发布与版本（站上整编）</h2>
        <p class="gb-hint">
          报出去的定线以当前发布版本为准；外业测点修改不会即时改变定线，须经交回复核通过发布新版。历史版本冻结、可随时查询。
        </p>
      </div>
      <div class="page__actions">
        <el-select :model-value="ratingStore.activeLineNo" class="page__line-select" @change="handleLineChange">
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Document" @click="historyVisible = true">版本历史（{{ lineVersions.length }}）</el-button>
        <el-button type="primary" :icon="CircleCheck" @click="gotoReview">去复核台发布</el-button>
        <el-button :icon="Plus" @click="openCreate">补历史遗留点</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        { key: 'verdicts', label: '判定', options: [
          { label: '合格', value: '合格' },
          { label: '超限', value: '超限' }
        ] }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <el-alert
      v-if="currentVersion"
      type="success"
      show-icon
      :closable="false"
      :title="`${currentVersion.lineNo} 线当前生效第 ${currentVersion.versionNo} 版（${new Date(currentVersion.publishedAt).toLocaleString('zh-CN')} 由 ${currentVersion.publishedBy} 发布）`"
      :description="`Q = ${fit.a} × (H - ${fit.h0})^${fit.b}；样本 ${fit.sampleCount} 点，平均残差 ${fit.meanResidualPct}%，最大残差 ${fit.maxResidualPct}%。本版冻结，复核发布新版前不会因测点改动而变化。`"
    />
    <el-alert
      v-else
      type="warning"
      show-icon
      :closable="false"
      title="该定线号尚未发布任何版本"
      description="当前曲线仅为按点据的临时拟合候选，不作数；请在复核台对交回测次复核通过后发布首版。"
    />

    <div class="gb-stats-row">
      <StatBadge label="当前版点据" :value="pointRows.length" suffix="点" icon="TrendCharts" />
      <StatBadge
        label="定线系数 a"
        :value="fit.valid ? fit.a : '—'"
        :suffix="fit.valid ? `b=${fit.b}` : '未定线'"
        tone="info"
        icon="TrendCharts"
      />
      <StatBadge
        label="平均残差"
        :value="fit.valid ? fit.meanResidualPct : '—'"
        suffix="%"
        :tone="fit.valid && fit.meanResidualPct <= ratingStore.deviationLimitPct ? 'success' : 'warning'"
        icon="Refresh"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'TrendCharts'"
      />
    </div>

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有已发布点据"
        description="外业交回测次、站上复核通过后点据才会随版发布；历史遗留点可手工补录。"
        action-text="补历史遗留点"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="外业实测流量 (m³/s)" width="165" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="曲线流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="190">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
          </template>
        </el-table-column>
        <el-table-column label="来源 / 认定测法" min-width="200">
          <template #default="{ row }">
            <div>
              {{ row.stationName }}
              <el-tag size="small" :type="row.sectionId ? 'success' : 'info'" effect="plain" class="page__source-tag">
                {{ row.sectionId ? '测次交回' : '历史遗留' }}
              </el-tag>
            </div>
            <div class="gb-hint gb-mono">{{ row.measureNo || '未标记测次' }} · 认定 {{ row.determinedMethod ?? '—' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <template v-if="!row.sectionId">
              <el-button
                size="small"
                :icon="Edit"
                @click="openEdit(ratingStore.ratings.find((item) => item.id === row.ratingId) as Rating)"
              >编辑</el-button>
              <el-button
                size="small"
                type="danger"
                plain
                :icon="Delete"
                @click="removeRating(ratingStore.ratings.find((item) => item.id === row.ratingId) as Rating)"
              >删除</el-button>
            </template>
            <el-tag v-else size="small" type="success" effect="plain">交回点据</el-tag>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线关系曲线{{ currentVersion ? ` · v${currentVersion.versionNo}` : '（未发布）' }}</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="300" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>
          <polyline v-if="fit.valid" :points="chart.samples" fill="none" stroke="#0f4c75" stroke-width="2" />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="point.verdict === '超限' ? '#c0392b' : '#7fd1e8'"
            :stroke="point.verdict === '超限' ? '#7b241c' : '#0f4c75'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="复核发布定线后自动生成关系曲线。" compact />
        <p class="gb-hint">红点为残差超限点据；曲线为当前发布版幂函数定线成果，历史版本可在「版本历史」中查看。</p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑历史遗留点据' : '补录历史遗留点据'" width="560px" :close-on-click-modal="false">
      <el-alert
        type="info"
        :closable="false"
        title="仅用于站上手工整编、无对应外业测次的早期点据；来自测次的点据必须由外业交回复核产生。"
        class="page__dialog-alert"
      />
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="历史资料可留空" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">保存</el-button>
      </template>
    </el-dialog>

    <!-- 版本历史抽屉：已发布各版均可查 -->
    <el-drawer v-model="historyVisible" :title="`${ratingStore.activeLineNo} 线定线版本历史`" size="520px">
      <div class="page__history">
        <EmptyPanel v-if="lineVersions.length === 0" title="尚未发布过版本" description="复核台通过交回测次后发布首版。" compact />
        <el-collapse v-else v-model="activeHistory">
          <el-collapse-item
            v-for="version in lineVersions"
            :key="version.id"
            :name="version.id"
            :title="`第 ${version.versionNo} 版 · ${RATING_VERSION_STATUS_LABEL[version.status]}`"
          >
            <div class="page__version-head">
              <el-tag size="small" :type="version.status === 'current' ? 'success' : 'info'" effect="plain">
                {{ RATING_VERSION_STATUS_LABEL[version.status] }}
              </el-tag>
              <span class="gb-hint">{{ new Date(version.publishedAt).toLocaleString('zh-CN') }} · {{ version.publishedBy }}</span>
            </div>
            <el-descriptions :column="2" border size="small" class="page__version-desc">
              <el-descriptions-item label="系数 a">{{ version.fit.a }}</el-descriptions-item>
              <el-descriptions-item label="指数 b">{{ version.fit.b }}</el-descriptions-item>
              <el-descriptions-item label="基线 H0">{{ version.fit.h0 }}</el-descriptions-item>
              <el-descriptions-item label="样本点数">{{ version.fit.sampleCount }}</el-descriptions-item>
              <el-descriptions-item label="平均残差">{{ version.fit.meanResidualPct }}%</el-descriptions-item>
              <el-descriptions-item label="最大残差">{{ version.fit.maxResidualPct }}%</el-descriptions-item>
              <el-descriptions-item label="R²">{{ version.fit.r2 }}</el-descriptions-item>
              <el-descriptions-item label="触发测次">{{ version.sourceSectionIds.length }} 个</el-descriptions-item>
            </el-descriptions>
            <p class="gb-hint">{{ version.reviewNote }}</p>
            <el-table :data="version.points" size="small" border max-height="260">
              <el-table-column label="水位 (m)" prop="stageM" width="100" align="right">
                <template #default="{ row }">{{ row.stageM.toFixed(2) }}</template>
              </el-table-column>
              <el-table-column label="流量 (m³/s)" prop="flowM3s" align="right">
                <template #default="{ row }">{{ row.flowM3s.toFixed(1) }}</template>
              </el-table-column>
              <el-table-column label="测次 / 认定" min-width="150">
                <template #default="{ row }">
                  <div class="gb-hint gb-mono">{{ row.measureNo || '历史遗留' }}</div>
                  <div class="gb-hint">{{ row.determinedMethod ?? '—' }}</div>
                </template>
              </el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </div>
    </el-drawer>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__line-select {
  width: 110px;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(520px, 1.5fr) minmax(320px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

.page__source-tag {
  margin-left: 6px;
}

.page__dialog-alert {
  margin-bottom: 12px;
}

.page__history {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.page__version-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.page__version-desc {
  margin-bottom: 8px;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
