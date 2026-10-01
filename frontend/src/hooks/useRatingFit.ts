/**
 * useRatingFit：水位流量点据拟合、残差与定线状态管理。
 * 被关系点据页与导出页消费；数据来自 ratingStore（IndexedDB 实时订阅）。
 *
 * 两侧分开后：曲线参数以站上「当前发布版本」为准；外业改测点不会即时改动定线，
 * 需经交回复核发布新版。本 hook 仅做派生展示，不再回写任何拟合参数。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import { curveFlow, fitPowerCurve, type Rating, type RatingFitResult } from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 曲线流量（按当前发布版本参数） */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  fit: RatingFitResult
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  lineNos: ComputedRef<string[]>
  activeLineNo: Ref<string>
  fit: ComputedRef<RatingFitResult>
  allFits: ComputedRef<RatingFitResult[]>
  pointRows: ComputedRef<RatingPointRow[]>
  curveSamples: ComputedRef<CurveSample[]>
  overLimitRows: ComputedRef<RatingPointRow[]>
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 读取当前发布拟合（复核发布后自动变化，无需手工 refit） */
  refit: () => RatingFitResult
}

export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => ratingStore.stationNameOf(stationId)

  /** 当前生效拟合：发布版优先；未发布过则临时拟合（候选值，不作数） */
  const fit = computed<RatingFitResult>(() => {
    const published = ratingStore.currentVersionOf(activeLineNo.value)
    if (published) return published.fit
    return fitPowerCurve(
      ratings.value
        .filter((rating) => rating.lineNo === activeLineNo.value)
        .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
      activeLineNo.value
    )
  })

  const allFits = computed<RatingFitResult[]>(() =>
    lineNos.value.map((lineNo) => {
      const published = ratingStore.currentVersionOf(lineNo)
      if (published) return published.fit
      return fitPowerCurve(
        ratings.value
          .filter((rating) => rating.lineNo === lineNo)
          .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s })),
        lineNo
      )
    })
  )

  const pointRows = computed<RatingPointRow[]>(() => {
    const current = fit.value
    return ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const predicted = current.valid ? curveFlow(current, rating.stageM) : 0
        const residualPct =
          current.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          fit: current
        }
      })
  })

  const curveSamples = computed<CurveSample[]>(() => {
    const current = fit.value
    const rows = pointRows.value
    if (!current.valid || rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(current, stageM) }
    })
  })

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allFits.value.flatMap((item) =>
      ratings.value
        .filter((rating) => rating.lineNo === item.lineNo)
        .map((rating) => {
          const predicted = item.valid ? curveFlow(item, rating.stageM) : 0
          const residualPct =
            item.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            curveFlowM3s: predicted,
            residualPct,
            fit: item
          }
        })
        .filter((row) => Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function refit(): RatingFitResult {
    return fit.value
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    fit,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
