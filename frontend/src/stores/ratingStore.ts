/**
 * 定线 store（站上侧）：维护水位流量关系点据、比测记录、定线版本与残差派生值。
 *
 * 与旧版的关键差异：
 * - 报出去的定线以「当前发布版本」ratingVersions 中 status=current 的参数为准，
 *   外业改测点不会即时改变已发布定线，必须经交回复核发布新版才会变；
 * - 点据的新增/替换发生在测次复核通过时（utils/handoff.ts），普通点据 CRUD
 *   仅保留给站上手工维护的历史遗留点（无来源测次）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult } from '@/types/rating'
import { createEmptyRatingFilter, curveFlow, fitPowerCurve, type RatingFilterState } from '@/types/rating'
import type { RatingVersion } from '@/types/ratingVersion'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const versions = ref<RatingVersion[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<RatingVersion>(() => db.ratingVersions).subscribe((rows) => {
      versions.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    versions.value.forEach((version) => set.add(version.lineNo))
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add('A')
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string | null): string =>
    stationId ? stations.value.find((station) => station.id === stationId)?.name ?? '未知测站' : '未知测站'

  /** 定线号 → 当前发布版本（报出去的定线以此为准） */
  const currentVersions = computed<Map<string, RatingVersion>>(() => {
    const map = new Map<string, RatingVersion>()
    versions.value
      .filter((version) => version.status === 'current')
      .forEach((version) => map.set(version.lineNo, version))
    return map
  })

  const currentVersionOf = (lineNo: string): RatingVersion | null => currentVersions.value.get(lineNo) ?? null

  /** 定线号 → 历史版本（含当前版，按版本号倒序） */
  const versionsOfLine = (lineNo: string): RatingVersion[] =>
    versions.value
      .filter((version) => version.lineNo === lineNo)
      .sort((a, b) => b.versionNo - a.versionNo)

  const versionById = (id: string | null | undefined): RatingVersion | null =>
    id ? versions.value.find((version) => version.id === id) ?? null : null

  /** 当前定线的生效拟合：优先取发布版本，未发布过则按当前点据临时拟合（仅候选、不作数） */
  const activeFit = computed<RatingFitResult>(() => {
    const published = currentVersionOf(activeLineNo.value)
    if (published) return published.fit
    const points = ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
    return fitPowerCurve(points, activeLineNo.value)
  })

  /** 逐定线号拟合（发布版优先），供导出页结论使用 */
  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => currentVersionOf(lineNo)?.fit ?? fitPowerCurve(
      ratings.value
        .filter((rating) => rating.lineNo === lineNo)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      lineNo
    ))
  )

  /** 当前定线点据（含按发布参数计算的曲线流量与残差），供页面与 hook 共用 */
  const pointRows = computed(() => {
    const fit = activeFit.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return { rating, stationName: stationNameOf(rating.stationId), predicted, residualPct }
      })
  })

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id && item.versionId === currentVersionOf(rating.lineNo)?.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：以当前发布版本的比测记录为准（历史版本比测可随版本快照查询） */
  const compareRows = computed<CompareRow[]>(() => {
    const currentVersionIds = new Set(
      versions.value.filter((version) => version.status === 'current').map((version) => version.id)
    )
    return compares.value
      .filter((compare) => compare.versionId === null || currentVersionIds.has(compare.versionId))
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? compare.lineNo ?? '-'
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  })

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比（基于已发布版本） */
  const fitQuality = computed(() => {
    const valid = versions.value.filter((version) => version.status === 'current' && version.fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, version) => sum + version.fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  /**
   * 站上手工新增历史遗留点据（无来源测次）。
   * 来自测次的点据只能由交回复核产生（utils/handoff.ts），此入口不允许覆盖外业成果。
   */
  async function createRating(
    payload: Omit<
      Rating,
      'id' | 'side' | 'sectionId' | 'determinedMethod' | 'publishedVersionId' | 'createdAt' | 'updatedAt'
    >
  ): Promise<Rating> {
    const now = Date.now()
    const row: Rating = {
      ...payload,
      id: createId('rat'),
      side: 'station',
      sectionId: null,
      determinedMethod: null,
      publishedVersionId: null,
      createdAt: now,
      updatedAt: now
    }
    await db.ratings.put(row)
    return row
  }

  /** 编辑历史遗留点据（sectionId=null）；已随测次采用的点据听外业，不在此改写流量 */
  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    const rating = await db.ratings.get(id)
    if (rating && rating.sectionId !== null) {
      throw new Error('该点据来自外业交回测次，流量以测次成果为准，不能在此改写')
    }
    await db.ratings.update(id, {
      stageM: patch.stageM,
      flowM3s: patch.flowM3s,
      lineNo: patch.lineNo,
      measureNo: patch.measureNo,
      measuredAt: patch.measuredAt,
      updatedAt: Date.now()
    } as never)
  }

  async function removeRating(id: string): Promise<void> {
    const rating = await db.ratings.get(id)
    if (rating && rating.sectionId !== null) {
      throw new Error('该点据来自已采用测次，不能直接删除；如外业修订测次，重新交回复核后会自动更新')
    }
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
  }

  /** 手工登记比测记录（导出页分析清单用，归属站上，未挂版本） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'side' | 'versionId' | 'lineNo' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      lineNo?: string
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      side: 'station',
      versionId: null,
      lineNo: payload.lineNo ?? activeLineNo.value,
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  /** 兼容旧页面的“重新定线”入口：现在只重新读取当前发布版，不产生未复核的新参数 */
  async function rebuildCompares(lineNo?: string): Promise<number> {
    const line = lineNo ?? activeLineNo.value
    return compares.value.filter((compare) => compare.lineNo === line).length
  }

  return {
    ratings,
    compares,
    versions,
    stations,
    ready,
    error,
    filter,
    activeLineNo,
    activeFit,
    deviationLimitPct,
    lineNos,
    allFits,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    currentVersionOf,
    versionsOfLine,
    versionById,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    createRating,
    updateRating,
    removeRating,
    rebuildCompares,
    createCompare,
    removeCompare
  }
})
