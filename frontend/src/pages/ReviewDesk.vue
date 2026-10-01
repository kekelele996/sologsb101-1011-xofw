<script setup lang="ts">
/**
 * 站上工作台：/review 测次交回复核与测法认定
 * - 站上只管测法认定与定线发布，不改外业测深/流速/流量；
 * - 复核通过：把外业流量成果接收为点据，拿该定线号全部点据重新拟合，发布新一版；
 * - 回交失败（退回）：外业留在原处重试，已发布那版照旧可查。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { CircleCheck, Close, Promotion, RefreshLeft, View, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import { MEASURE_METHODS, type MeasureMethod } from '@/types/section'
import type { Section } from '@/types/section'
import type { RatingFitResult } from '@/types/rating'
import { HANDOFF_STATUS_LABEL, HANDOFF_STATUS_TAG_TYPE } from '@/types/handoff'
import { acceptSection, acceptSections, determineMethod, previewReview, rejectSection } from '@/utils/handoff'
import { initDatabase } from '@/utils/db'

const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()

const busy = ref(false)
const selected = ref<string[]>([])
const reviewer = ref('林昭')

/** 复核预览抽屉 */
const previewVisible = ref(false)
const previewSection = ref<Section | null>(null)
const previewFit = ref<RatingFitResult | null>(null)
const previewExisting = ref(0)
const previewLoading = ref(false)

/** 测法认定弹窗 */
const determineVisible = ref(false)
const determineSection = ref<Section | null>(null)
const determineForm = ref<{ method: MeasureMethod; note: string }>({ method: '流速仪', note: '' })

/** 退回弹窗 */
const rejectVisible = ref(false)
const rejectSectionRow = ref<Section | null>(null)
const rejectReason = ref('')

const pendingRows = computed(() =>
  [...sectionStore.pendingReviewSections].sort((a, b) => Date.parse(b.handedAt ?? '') - Date.parse(a.handedAt ?? ''))
)

const returnedRows = computed(() =>
  sectionStore.sections
    .filter((section) => section.handoffStatus === 'returned')
    .sort((a, b) => Date.parse(b.returnedAt ?? '') - Date.parse(a.returnedAt ?? ''))
)

const acceptedRows = computed(() =>
  sectionStore.acceptedSections.sort((a, b) => Date.parse(b.acceptedAt ?? '') - Date.parse(a.acceptedAt ?? ''))
)

/** 批量勾选仅限同一目标定线号 */
const selectedLine = computed<string | null>(() => {
  const lines = new Set(pendingRows.value.filter((row) => selected.value.includes(row.id)).map((row) => row.targetLineNo || 'A'))
  return lines.size === 1 ? Array.from(lines)[0] : null
})

const stationName = (stationId: string): string => stationStore.stationById(stationId)?.name ?? '未知测站'

function selectionChange(rows: Section[]): void {
  selected.value = rows.map((row) => row.id)
}

function openDetermine(section: Section): void {
  determineSection.value = section
  determineForm.value = {
    method: section.determinedMethod ?? section.method,
    note: section.determinationNote
  }
  determineVisible.value = true
}

async function submitDetermine(): Promise<void> {
  if (!determineSection.value) return
  busy.value = true
  try {
    await determineMethod(determineSection.value.id, determineForm.value.method, {
      by: reviewer.value,
      note: determineForm.value.note
    })
    ElMessage.success('测法认定已保存（测法听站上）')
    determineVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '认定失败')
  } finally {
    busy.value = false
  }
}

async function openPreview(section: Section): Promise<void> {
  previewSection.value = section
  previewVisible.value = true
  previewLoading.value = true
  previewFit.value = null
  try {
    const result = await previewReview(section.id)
    previewFit.value = result.fit
    previewExisting.value = result.existingCount
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '预览失败')
  } finally {
    previewLoading.value = false
  }
}

function openReject(section: Section): void {
  rejectSectionRow.value = section
  rejectReason.value = section.returnReason ?? ''
  rejectVisible.value = true
}

async function submitReject(): Promise<void> {
  if (!rejectSectionRow.value) return
  if (!rejectReason.value.trim()) {
    ElMessage.warning('请填写退回原因')
    return
  }
  busy.value = true
  try {
    await rejectSection(rejectSectionRow.value.id, { returnReason: rejectReason.value, reviewer: reviewer.value })
    ElMessage.success('已退回外业：测次留在原处可重试，已发布定线不受影响')
    rejectVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '退回失败')
  } finally {
    busy.value = false
  }
}

/** 单个测次复核通过：校验测法认定 → 并入点据 → 全部点据重新拟合 → 发布新版 */
async function approve(section: Section): Promise<void> {
  if (!section.determinedMethod) {
    ElMessage.warning('请先完成测法认定，再复核通过')
    return
  }
  try {
    const preview = await previewReview(section.id)
    if (!preview.fit.valid) {
      await ElMessageBox.confirm(
        `并入该测次后，${section.targetLineNo} 线重新拟合未通过（${preview.fit.message}）。仍要尝试发布吗？通常应退回外业补测。`,
        '复核未通过',
        { type: 'warning', confirmButtonText: '仍要发布', cancelButtonText: '退回外业' }
      )
    }
    await ElMessageBox.confirm(
      `复核通过测次「${section.measureNo}」？将按外业固化流量 ${section.fieldFlowM3s.toFixed(
        2
      )} m³/s 并入 ${section.targetLineNo} 线，取该线全部点据重新拟合并发布新一版定线。`,
      '复核通过并发布',
      { type: 'success', confirmButtonText: '复核通过并发布', cancelButtonText: '取消' }
    )
  } catch (error) {
    if (error === 'cancel') return
    ElMessage.error(error instanceof Error ? error.message : '复核校验失败')
    return
  }
  busy.value = true
  try {
    const result = await acceptSection(section.id, { reviewer: reviewer.value })
    ElMessage.success(
      `已发布 ${result.version.lineNo} 线第 ${result.version.versionNo} 版：Q=${result.fit.a}·(H-${result.fit.h0})^${result.fit.b}，平均残差 ${result.fit.meanResidualPct}%`
    )
    previewVisible.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '发布失败')
  } finally {
    busy.value = false
  }
}

/** 批量复核通过（同一目标定线号） */
async function approveSelected(): Promise<void> {
  if (selected.value.length === 0) {
    ElMessage.warning('请先勾选要复核通过的测次')
    return
  }
  if (!selectedLine.value) {
    ElMessage.warning('批量复核仅支持同一目标定线号的测次')
    return
  }
  const rows = pendingRows.value.filter((row) => selected.value.includes(row.id))
  const undetermined = rows.find((row) => !row.determinedMethod)
  if (undetermined) {
    ElMessage.warning(`测次 ${undetermined.measureNo} 尚未完成测法认定`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `将把选中的 ${rows.length} 个测次并入 ${selectedLine.value} 线，取全部点据重新拟合并发布新一版，确认复核通过？`,
      '批量复核通过',
      { type: 'success', confirmButtonText: '复核通过并发布', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  busy.value = true
  try {
    const result = await acceptSections(selected.value, { reviewer: reviewer.value })
    ElMessage.success(`已发布 ${result.lineNo} 线第 ${result.version.versionNo} 版（并入 ${result.sections.length} 个测次）`)
    selected.value = []
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '批量复核失败')
  } finally {
    busy.value = false
  }
}

function gotoVerticals(section: Section): void {
  void router.push(`/sections/${section.id}/verticals`)
}

function gotoRatings(): void {
  void router.push('/ratings')
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">测次交回复核与测法认定（站上整编）</h2>
        <p class="gb-hint">
          站上管测法认定与定线发布：外业交回后在此认定测法、预览并入后的全线拟合；复核通过才发布新一版，退回则外业留在原处重试。
        </p>
      </div>
      <div class="page__actions">
        <el-input v-model="reviewer" placeholder="复核人" class="page__reviewer" maxlength="12" />
        <el-button :icon="View" @click="gotoRatings">查看定线与版本</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="待复核测次" :value="pendingRows.length" suffix="次" tone="warning" icon="Promotion" />
      <StatBadge label="退回外业重试" :value="returnedRows.length" suffix="次" tone="danger" icon="RefreshLeft" />
      <StatBadge label="已采用测次" :value="acceptedRows.length" suffix="次" tone="success" icon="CircleCheck" />
      <StatBadge label="已发布定线版本" :value="ratingStore.versions.length" suffix="版" tone="info" icon="View" />
    </div>

    <div class="gb-panel">
      <div class="gb-panel-title">
        <h3>交回待复核队列</h3>
        <span class="gb-hint">流量取外业交回固化成果（不可改）；先认定测法，再并入定线复核</span>
      </div>

      <EmptyPanel
        v-if="pendingRows.length === 0"
        title="没有待复核的测次"
        description="外业在测次页完成测深、流速后点「交回」，此处即出现待复核队列。"
        compact
      />

      <template v-else>
        <div class="page__bulkbar">
          <el-button
            type="success"
            :icon="CircleCheck"
            :disabled="selected.length === 0"
            :loading="busy"
            @click="approveSelected"
          >
            批量复核通过（{{ selected.length }}）
          </el-button>
          <el-tag v-if="selected.length > 0" :type="selectedLine ? 'success' : 'danger'" effect="plain">
            {{ selectedLine ? `并入 ${selectedLine} 线` : '勾选测次必须为同一目标定线号' }}
          </el-tag>
        </div>
        <el-table
          :data="pendingRows"
          border
          stripe
          class="gb-table-compact"
          row-key="id"
          @selection-change="selectionChange"
        >
          <el-table-column type="selection" width="46" reserve-selection />
          <el-table-column label="测站 / 测次" min-width="190">
            <template #default="{ row }">
              <div>{{ stationName(row.stationId) }}</div>
              <div class="gb-hint gb-mono">{{ row.measureNo }}</div>
            </template>
          </el-table-column>
          <el-table-column label="水位 (m)" width="100" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.stageM.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="外业流量 (m³/s)" width="150" align="right">
            <template #default="{ row }">
              <span class="gb-mono">{{ row.fieldFlowM3s.toFixed(2) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="现场记录 → 站上认定" width="220">
            <template #default="{ row }">
              <div class="page__method-cell">
                <el-tag size="small" effect="plain">{{ row.method }}</el-tag>
                <span class="gb-hint">→</span>
                <el-tag size="small" :type="row.determinedMethod ? 'success' : 'danger'" effect="dark">
                  {{ row.determinedMethod ?? '未认定' }}
                </el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="目标定线" width="96" align="center">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ row.targetLineNo || 'A' }} 线</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="交回时间 / 备注" min-width="180">
            <template #default="{ row }">
              <div class="gb-mono">{{ row.handedAt ? new Date(row.handedAt).toLocaleString('zh-CN') : '—' }}</div>
              <div class="gb-hint">{{ row.handoffNote || '（无备注）' }}</div>
            </template>
          </el-table-column>
          <el-table-column label="站上操作" width="330" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="gotoVerticals(row)">查看外业成果</el-button>
              <el-button size="small" :type="row.determinedMethod ? 'info' : 'warning'" @click="openDetermine(row)">
                {{ row.determinedMethod ? '改测法认定' : '测法认定' }}
              </el-button>
              <el-button size="small" type="primary" plain :icon="View" @click="openPreview(row)">拟合预览</el-button>
              <el-button size="small" type="success" :icon="CircleCheck" :loading="busy" @click="approve(row)">通过发布</el-button>
              <el-button size="small" type="danger" plain :icon="Close" @click="openReject(row)">退回</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </div>

    <div v-if="returnedRows.length > 0" class="gb-panel">
      <div class="gb-panel-title">
        <h3>
          回交失败（外业留在原处重试）
          <el-tag type="danger" size="small" effect="plain">{{ returnedRows.length }}</el-tag>
        </h3>
        <span class="gb-hint">已发布那版定线不受影响、照旧可查；外业改完重新交回后回到上方队列</span>
      </div>
      <el-table :data="returnedRows" border size="small" class="gb-table-compact">
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div>{{ stationName(row.stationId) }}</div>
            <div class="gb-hint gb-mono">{{ row.measureNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="外业流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fieldFlowM3s.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="退回原因 / 次数" min-width="260">
          <template #default="{ row }">
            <div class="page__reject-reason">
              <el-icon><Warning /></el-icon> {{ row.returnReason || '（未填写原因）' }}
            </div>
            <div class="gb-hint">已退回 {{ row.returnCount }} 次 · {{ row.returnedAt ? new Date(row.returnedAt).toLocaleString('zh-CN') : '' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="130" align="center">
          <template #default="{ row }">
            <el-tag size="small" :type="HANDOFF_STATUS_TAG_TYPE[(row as Section).handoffStatus]" effect="plain">
              {{ HANDOFF_STATUS_LABEL[(row as Section).handoffStatus] }}
            </el-tag>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <div v-if="acceptedRows.length > 0" class="gb-panel">
      <div class="gb-panel-title">
        <h3>近期已采用测次</h3>
        <el-button text type="primary" size="small" @click="gotoRatings">前往定线版本查询 →</el-button>
      </div>
      <el-table :data="acceptedRows.slice(0, 8)" border size="small" class="gb-table-compact">
        <el-table-column label="测站 / 测次" min-width="180">
          <template #default="{ row }">
            <div>{{ stationName(row.stationId) }}</div>
            <div class="gb-hint gb-mono">{{ row.measureNo }}</div>
          </template>
        </el-table-column>
        <el-table-column label="外业流量 (m³/s)" width="150" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.fieldFlowM3s.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="认定测法" width="110" align="center">
          <template #default="{ row }">
            <el-tag size="small" type="success" effect="plain">{{ row.determinedMethod ?? '—' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="并入定线" width="100" align="center">
          <template #default="{ row }">{{ row.acceptedLineNo }} 线</template>
        </el-table-column>
        <el-table-column label="采用时间" min-width="160">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.acceptedAt ? new Date(row.acceptedAt).toLocaleString('zh-CN') : '—' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 拟合预览抽屉 -->
    <el-drawer v-model="previewVisible" title="并入定线复核预览" size="460px">
      <div v-if="previewSection" class="page__preview">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="测次">{{ previewSection.measureNo }}</el-descriptions-item>
          <el-descriptions-item label="水位">{{ previewSection.stageM.toFixed(2) }} m</el-descriptions-item>
          <el-descriptions-item label="外业固化流量">
            <strong>{{ previewSection.fieldFlowM3s.toFixed(2) }} m³/s</strong>（站上不改写）
          </el-descriptions-item>
          <el-descriptions-item label="现场记录 / 站上认定">
            {{ previewSection.method }} → {{ previewSection.determinedMethod ?? '尚未认定' }}
          </el-descriptions-item>
          <el-descriptions-item label="目标定线">{{ previewSection.targetLineNo }} 线（现有点据 {{ previewExisting }} 个）</el-descriptions-item>
        </el-descriptions>

        <el-skeleton v-if="previewLoading" :rows="4" animated />
        <template v-else-if="previewFit">
          <el-alert
            :type="previewFit.valid ? 'success' : 'error'"
            :closable="false"
            show-icon
            :title="
              previewFit.valid
                ? `重新拟合有效：Q = ${previewFit.a} × (H - ${previewFit.h0})^${previewFit.b}`
                : previewFit.message
            "
          />
          <el-descriptions :column="2" border size="small" class="page__preview-stats">
            <el-descriptions-item label="样本点数">{{ previewFit.sampleCount }}</el-descriptions-item>
            <el-descriptions-item label="R²">{{ previewFit.r2 }}</el-descriptions-item>
            <el-descriptions-item label="平均残差">{{ previewFit.meanResidualPct }}%</el-descriptions-item>
            <el-descriptions-item label="最大残差">{{ previewFit.maxResidualPct }}%</el-descriptions-item>
          </el-descriptions>
          <p class="gb-hint">
            复核通过后，将取该线全部点据重新拟合并冻结为新一版；未通过请退回外业补测，不要勉强发布。
          </p>
          <div class="page__preview-actions">
            <el-button
              type="success"
              :icon="CircleCheck"
              :disabled="!previewSection.determinedMethod"
              :loading="busy"
              @click="approve(previewSection)"
            >复核通过并发布</el-button>
            <el-button type="danger" plain :icon="Close" @click="openReject(previewSection)">退回外业</el-button>
          </div>
        </template>
      </div>
    </el-drawer>

    <!-- 测法认定弹窗 -->
    <el-dialog v-model="determineVisible" title="站上测法认定" width="440px">
      <div v-if="determineSection">
        <p class="gb-hint">
          测次 {{ determineSection.measureNo }}：外业现场记录为「{{ determineSection.method }}」，最终测法听站上认定，不会覆盖外业记录。
        </p>
        <el-radio-group v-model="determineForm.method" class="page__method-radio">
          <el-radio-button v-for="method in MEASURE_METHODS" :key="method" :value="method">{{ method }}</el-radio-button>
        </el-radio-group>
        <el-input v-model="determineForm.note" type="textarea" :rows="3" placeholder="认定意见（可选）" class="page__method-note" />
      </div>
      <template #footer>
        <el-button @click="determineVisible = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitDetermine">保存认定</el-button>
      </template>
    </el-dialog>

    <!-- 退回弹窗 -->
    <el-dialog v-model="rejectVisible" title="退回外业重试（回交失败）" width="460px">
      <p class="gb-hint">
        退回后测次留在外业原处（测深/流速可改），外业改完重新交回；已发布的那版定线不受影响、照旧可查。
      </p>
      <el-input v-model="rejectReason" type="textarea" :rows="3" placeholder="必填：退回原因，如测点历时不足、流速异常需复测" />
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="busy" @click="submitReject">确认退回</el-button>
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
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__reviewer {
  width: 120px;
}

.page__bulkbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}

.page__method-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}

.page__reject-reason {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #c0392b;
}

.page__preview {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__preview-stats {
  margin-top: 4px;
}

.page__preview-actions {
  display: flex;
  gap: 10px;
}

.page__method-radio {
  display: flex;
  margin: 10px 0;
}

.page__method-note {
  margin-top: 8px;
}
</style>
