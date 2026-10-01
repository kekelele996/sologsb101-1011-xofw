/**
 * 测次交回编排：外业测验 ⇄ 站上整编 的状态迁移、两侧字段白名单写入与定线发布。
 *
 * 不可互相覆盖的边界：
 * - 外业只能写测次采集字段（水位/现场测法/起点距/测流时间）与垂线测点、流量快照；
 * - 站上只能写测法认定与采用字段；发布后的点据/版本归站上，流量数值取自外业快照。
 * - 任意一侧都不能整体 put 对方的字段，store 层统一经本文件的白名单函数落库。
 */
import { db, createId } from '@/utils/db'
import { calcMeanVelocity, calcSectionDischarge } from '@/utils/flow'
import { assemblePublishedVersion, previewLineFit } from '@/utils/ratingPublish'
import type { Section, MeasureMethod } from '@/types/section'
import { FIELD_SECTION_KEYS, STATION_SECTION_KEYS } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating, RatingFitResult } from '@/types/rating'
import type { RatingVersion } from '@/types/ratingVersion'
import {
  assertTransition,
  isFieldEditable,
  type HandoffRejectPayload,
  type HandoffSubmitPayload
} from '@/types/handoff'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'

/** 外业成果快照 */
export interface FieldFlowSnapshot {
  flowM3s: number
  areaM2: number
  meanVelocityMs: number
  verticalCount: number
  pointCount: number
}

/** 外业写测次：仅保留外业采集字段，站上字段即便传入也被丢弃，杜绝互相覆盖 */
export function pickFieldSectionPatch(patch: Partial<Section>): Partial<Section> {
  const allowed = new Set<string>(FIELD_SECTION_KEYS)
  return Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key))) as Partial<Section>
}

/** 站上写测次：仅保留测法认定 / 采用字段 */
export function pickStationSectionPatch(patch: Partial<Section>): Partial<Section> {
  const allowed = new Set<string>(STATION_SECTION_KEYS)
  return Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.has(key))) as Partial<Section>
}

async function requireSection(sectionId: string): Promise<Section> {
  const section = await db.sections.get(sectionId)
  if (!section) throw new Error('测次不存在或已被删除')
  return section
}

/** 由当前垂线 / 测点实时汇总断面流量（流量按外业算的唯一来源） */
export async function computeFieldFlow(sectionId: string): Promise<FieldFlowSnapshot> {
  const verticals = await db.verticals.where('sectionId').equals(sectionId).toArray()
  const verticalIds = verticals.map((vertical) => vertical.id)
  const points = verticalIds.length > 0 ? await db.points.where('verticalId').anyOf(verticalIds).toArray() : []
  const pointsByVertical = new Map<string, Point[]>()
  points.forEach((point) => {
    const list = pointsByVertical.get(point.verticalId) ?? []
    list.push(point)
    pointsByVertical.set(point.verticalId, list)
  })
  const result = calcSectionDischarge(
    verticals
      .sort((a, b) => a.startDistanceM - b.startDistanceM)
      .map((vertical: Vertical) => ({
        id: vertical.id,
        no: vertical.no,
        startDistanceM: vertical.startDistanceM,
        depthM: vertical.depthM,
        meanVelocityMs: calcMeanVelocity(
          (pointsByVertical.get(vertical.id) ?? []).map((point) => ({
            velocityMs: point.velocityMs,
            weight: point.weight
          }))
        )
      }))
  )
  return {
    flowM3s: result.flowM3s,
    areaM2: result.areaM2,
    meanVelocityMs: result.meanVelocityMs,
    verticalCount: verticals.length,
    pointCount: points.length
  }
}

/** 外业保存：编辑中 / 退回状态下把最新测深流速汇成流量快照（未交回前可随时刷新） */
export async function saveFieldFlowSnapshot(sectionId: string): Promise<FieldFlowSnapshot> {
  const section = await requireSection(sectionId)
  if (!isFieldEditable(section.handoffStatus)) {
    throw new Error('测次已交回，外业数据冻结；如需修改请先申请修订')
  }
  const snapshot = await computeFieldFlow(sectionId)
  await db.sections.update(sectionId, {
    fieldFlowM3s: snapshot.flowM3s,
    fieldAreaM2: snapshot.areaM2,
    fieldMeanVelocityMs: snapshot.meanVelocityMs,
    updatedAt: Date.now()
  } as never)
  return snapshot
}

/**
 * 外业交回：draft/returned → submitted。
 * 交回瞬间按当前垂线测点重算并固化流量；未布垂线（无流量成果）不允许交回。
 */
export async function submitSection(
  sectionId: string,
  payload: HandoffSubmitPayload,
  snapshot?: FieldFlowSnapshot
): Promise<Section> {
  const section = await requireSection(sectionId)
  const from = section.handoffStatus
  assertTransition(from, 'submitted')

  const flow = snapshot ?? (await computeFieldFlow(sectionId))
  if (flow.verticalCount === 0 || flow.flowM3s <= 0) {
    throw new Error('尚未布设垂线或断面流量为 0，外业成果不完整，不能交回')
  }
  const now = Date.now()
  await db.sections.update(sectionId, {
    handoffStatus: 'submitted' satisfies Section['handoffStatus'],
    fieldFlowM3s: flow.flowM3s,
    fieldAreaM2: flow.areaM2,
    fieldMeanVelocityMs: flow.meanVelocityMs,
    targetLineNo: payload.targetLineNo.trim() || section.targetLineNo || 'A',
    handoffNote: payload.handoffNote?.trim() ?? '',
    handedAt: new Date(now).toISOString(),
    returnedAt: null,
    returnReason: '',
    updatedAt: now
  } as never)
  return requireSection(sectionId)
}

/**
 * 站上退回（回交失败）：submitted → returned。
 * 测次留在外业原处可改可重试；此前已发布的定线版本不受影响、照旧可查。
 */
export async function rejectSection(sectionId: string, payload: HandoffRejectPayload): Promise<Section> {
  const section = await requireSection(sectionId)
  assertTransition(section.handoffStatus, 'returned')
  const reason = payload.returnReason.trim()
  if (!reason) throw new Error('退回必须填写退回原因，供外业原位重试')
  const now = Date.now()
  await db.sections.update(sectionId, {
    handoffStatus: 'returned' satisfies Section['handoffStatus'],
    returnReason: reason,
    returnedAt: new Date(now).toISOString(),
    returnCount: section.returnCount + 1,
    updatedAt: now
  } as never)
  return requireSection(sectionId)
}

/** 外业对已采用测次申请修订：accepted → draft（发布版本不回滚、不覆盖） */
export async function reopenForRevision(sectionId: string): Promise<Section> {
  const section = await requireSection(sectionId)
  assertTransition(section.handoffStatus, 'draft')
  await db.sections.update(sectionId, { handoffStatus: 'draft' satisfies Section['handoffStatus'], updatedAt: Date.now() } as never)
  return requireSection(sectionId)
}

/** 站上测法认定：只写站上字段；认定可在交回后、采用前进行（测法听站上） */
export async function determineMethod(
  sectionId: string,
  method: MeasureMethod,
  params: { by: string; note?: string }
): Promise<Section> {
  const section = await requireSection(sectionId)
  if (section.handoffStatus !== 'submitted' && section.handoffStatus !== 'accepted') {
    throw new Error('测次尚未交回，站上暂不能认定测法')
  }
  await db.sections.update(
    sectionId,
    pickStationSectionPatch({
      determinedMethod: method,
      determinedAt: new Date().toISOString(),
      determinedBy: params.by || '站上',
      determinationNote: params.note ?? ''
    }) as never
  )
  return requireSection(sectionId)
}

/** 交回复核预览：把待交测次的外业流量点并入目标定线后重新拟合（不落库） */
export async function previewReview(sectionId: string): Promise<{
  section: Section
  fit: RatingFitResult
  existingCount: number
  incomingCount: number
}> {
  const section = await requireSection(sectionId)
  const lineNo = (section.targetLineNo || 'A').trim() || 'A'
  const existing = await db.ratings.where('lineNo').equals(lineNo).toArray()
  const incoming = [{ stageM: section.stageM, flowM3s: section.fieldFlowM3s }]
  const fit = previewLineFit(
    lineNo,
    existing.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
    incoming
  )
  return { section: { ...section, targetLineNo: lineNo }, fit, existingCount: existing.length, incomingCount: 1 }
}

/** 发布一版定线：同号线旧当前版置为历史版，点据/参数/比测全部冻结 */
async function publishLineVersion(params: {
  lineNo: string
  sourceSectionIds: string[]
  publishedBy: string
  reviewNote: string
  deviationLimitPct: number
}): Promise<{ version: RatingVersion; fit: RatingFitResult }> {
  const lineNo = params.lineNo.trim() || 'A'
  const ratings = await db.ratings.where('lineNo').equals(lineNo).toArray()
  if (ratings.length === 0) throw new Error(`定线 ${lineNo} 没有点据，不能发布`)

  const prior = await db.ratingVersions
    .where('lineNo')
    .equals(lineNo)
    .toArray()
  const nextVersionNo = prior.reduce((max, item) => Math.max(max, item.versionNo), 0) + 1
  const versionId = createId('ver')
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const assembled = assemblePublishedVersion({
    id: versionId,
    lineNo,
    versionNo: nextVersionNo,
    ratings,
    sourceSectionIds: params.sourceSectionIds,
    publishedBy: params.publishedBy,
    reviewNote: params.reviewNote,
    deviationLimitPct: params.deviationLimitPct,
    publishedAt: iso,
    now
  })
  if (!assembled.fit.valid) {
    throw new Error(assembled.fit.message || '全部点据重新拟合未通过，不能发布新版')
  }

  await db.transaction(
    'rw',
    [db.ratingVersions, db.ratings, db.compares, db.sections],
    async () => {
      // 同号线旧当前版 → 历史版（已发布那版照旧可查）
      await db.ratingVersions
        .where('lineNo')
        .equals(lineNo)
        .modify((version: RatingVersion) => {
          version.status = 'superseded'
          version.updatedAt = now
        })
      await db.ratingVersions.put(assembled.version)

      // 该线比测以新版参数为准重建（旧版比测仍保留在版本快照之外，按 versionId 可追溯）
      await db.compares.where('lineNo').equals(lineNo).delete()
      await db.compares.bulkPut(assembled.compares)

      await db.ratings
        .where('lineNo')
        .equals(lineNo)
        .modify((rating: Rating) => {
          rating.publishedVersionId = versionId
          rating.updatedAt = now
        })

      await db.sections
        .where('acceptedLineNo')
        .equals(lineNo)
        .modify((section: Section) => {
          section.acceptedVersionId = versionId
          section.updatedAt = now
        })
    }
  )

  return { version: assembled.version, fit: assembled.fit }
}

/**
 * 站上复核通过：submitted → accepted。
 * 必须先完成测法认定；通过后把外业流量成果接收为该定线号点据（流量取外业快照，站上不改数值），
 * 再拿该线全部点据重新拟合，复核通过才发布新一版。
 */
export async function acceptSection(
  sectionId: string,
  options: { reviewer?: string; reviewNote?: string; deviationLimitPct?: number } = {}
): Promise<{ section: Section; version: RatingVersion; fit: RatingFitResult }> {
  const section = await requireSection(sectionId)
  assertTransition(section.handoffStatus, 'accepted')
  if (!section.determinedMethod) {
    throw new Error('请先完成测法认定，再复核通过')
  }
  const lineNo = (section.targetLineNo || 'A').trim() || 'A'
  const reviewer = options.reviewer?.trim() || section.determinedBy || '站上'
  const now = Date.now()

  // 先切状态并 upsert 点据（同一测次修订后重新采用，按 sectionId 覆盖原有点据而非新增）
  await db.sections.update(sectionId, {
    handoffStatus: 'accepted' satisfies Section['handoffStatus'],
    acceptedLineNo: lineNo,
    acceptedAt: new Date(now).toISOString()
  } as never)

  const ratingId = `rat_${section.id}`
  const existingRating = await db.ratings.get(ratingId)
  const rating: Rating = {
    id: ratingId,
    stationId: section.stationId,
    stageM: section.stageM,
    flowM3s: section.fieldFlowM3s,
    lineNo,
    measureNo: section.measureNo,
    measuredAt: section.measuredAt,
    side: 'station',
    sectionId: section.id,
    determinedMethod: section.determinedMethod,
    publishedVersionId: null,
    createdAt: existingRating?.createdAt ?? now,
    updatedAt: now
  }
  await db.ratings.put(rating)

  const published = await publishLineVersion({
    lineNo,
    sourceSectionIds: [sectionId],
    publishedBy: reviewer,
    reviewNote: options.reviewNote?.trim() || `复核通过：测次 ${section.measureNo}（${section.determinedMethod}）`,
    deviationLimitPct: options.deviationLimitPct ?? DEVIATION_LIMIT_PCT
  })
  await db.sections.update(sectionId, {
    acceptedVersionId: published.version.id,
    acceptedLineNo: lineNo,
    updatedAt: Date.now()
  } as never)

  return { section: await requireSection(sectionId), version: published.version, fit: published.fit }
}

/**
 * 站上批量复核通过：同一定线号的多个待复核测次一次接收、一次发布新版。
 * 必须全部完成测法认定且定线号一致；任一不满足整批中止，不产生半成品版本。
 */
export async function acceptSections(
  sectionIds: string[],
  options: { reviewer?: string; reviewNote?: string; deviationLimitPct?: number } = {}
): Promise<{ lineNo: string; sections: Section[]; version: RatingVersion; fit: RatingFitResult }> {
  if (sectionIds.length === 0) throw new Error('请先勾选要复核通过的测次')
  const sections = await db.sections.where('id').anyOf(sectionIds).toArray()
  if (sections.length !== sectionIds.length) throw new Error('部分测次已不存在，请刷新后重试')

  const lineNos = new Set(sections.map((section) => (section.targetLineNo || 'A').trim() || 'A'))
  if (lineNos.size !== 1) throw new Error('批量复核仅支持同一目标定线号的测次，请分开操作')
  const undetermined = sections.find((section) => !section.determinedMethod)
  if (undetermined) throw new Error(`测次 ${undetermined.measureNo} 尚未完成测法认定`)

  const lineNo = Array.from(lineNos)[0]
  const reviewer = options.reviewer?.trim() || '站上'
  const now = Date.now()

  await db.transaction('rw', [db.sections, db.ratings], async () => {
    for (const section of sections) {
      if (section.handoffStatus !== 'submitted') {
        throw new Error(`测次 ${section.measureNo} 不在待复核状态`)
      }
      await db.sections.update(section.id, {
        handoffStatus: 'accepted' satisfies Section['handoffStatus'],
        acceptedLineNo: lineNo,
        acceptedAt: new Date(now).toISOString(),
        updatedAt: now
      } as never)
      const ratingId = `rat_${section.id}`
      const existingRating = await db.ratings.get(ratingId)
      await db.ratings.put({
        id: ratingId,
        stationId: section.stationId,
        stageM: section.stageM,
        flowM3s: section.fieldFlowM3s,
        lineNo,
        measureNo: section.measureNo,
        measuredAt: section.measuredAt,
        side: 'station',
        sectionId: section.id,
        determinedMethod: section.determinedMethod,
        publishedVersionId: null,
        createdAt: existingRating?.createdAt ?? now,
        updatedAt: now
      } satisfies Rating)
    }
  })

  const published = await publishLineVersion({
    lineNo,
    sourceSectionIds: sectionIds,
    publishedBy: reviewer,
    reviewNote: options.reviewNote?.trim() || `批量复核通过 ${sections.length} 个测次`,
    deviationLimitPct: options.deviationLimitPct ?? DEVIATION_LIMIT_PCT
  })
  await db.sections.where('id').anyOf(sectionIds).modify((section: Section) => {
    section.acceptedVersionId = published.version.id
  })

  return { lineNo, sections: await db.sections.where('id').anyOf(sectionIds).toArray(), ...published }
}

/** 外业删除测次：仅外业可删，且已交回/已采用的测次需先退回或经站上处理 */
export async function assertFieldCanMutate(section: Section): Promise<void> {
  if (!isFieldEditable(section.handoffStatus)) {
    throw new Error('测次已交回站上，外业侧只读，不能修改或删除')
  }
}
