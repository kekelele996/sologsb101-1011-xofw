/**
 * 定线发布组装（纯函数，不依赖 Dexie）：
 * 站上复核通过后，拿某定线号下的全部点据重新拟合一版，冻结参数、点据快照与比测偏差。
 * db 升级 / 播种与 utils/handoff.ts 的交回复核共用同一套组装规则。
 */
import { calcDeviationPct, judgeDeviation, type Compare } from '@/types/compare'
import type { Rating } from '@/types/rating'
import { curveFlow, fitPowerCurve, type RatingFitResult } from '@/types/rating'
import type { RatingVersion, RatingVersionPoint } from '@/types/ratingVersion'

/** 组版入参 */
export interface AssembleVersionInput {
  /** 版本主键（不传由调用方生成） */
  id?: string
  lineNo: string
  /** 版本序号（同号线 1 起递增） */
  versionNo: number
  /** 该定线号下当前全部点据（含历史遗留点与本次交回测次点） */
  ratings: Rating[]
  /** 触发本次发布的交回测次 id */
  sourceSectionIds: string[]
  publishedBy: string
  reviewNote: string
  deviationLimitPct: number
  /** 发布时间 ISO */
  publishedAt: string
  /** 时间戳 */
  now: number
}

export interface AssembleVersionResult {
  version: RatingVersion
  /** 按新发布参数生成的比测记录（待调用方落库） */
  compares: Compare[]
  fit: RatingFitResult
}

/** 取一组点据中出现次数最多的测站作为版本主属测站 */
function dominantStationId(ratings: Rating[]): string | null {
  if (ratings.length === 0) return null
  const counter = new Map<string, number>()
  ratings.forEach((rating) => counter.set(rating.stationId, (counter.get(rating.stationId) ?? 0) + 1))
  return Array.from(counter.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

/**
 * 用全部点据重新拟合并冻结一版定线与比测成果。
 * 注意：只做组装，不校验合法性；调用方需先判断 fit.valid（复核不通过不得发布）。
 */
export function assemblePublishedVersion(input: AssembleVersionInput): AssembleVersionResult {
  const { lineNo, versionNo, ratings } = input
  const samples = ratings.map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
  const fit = fitPowerCurve(samples, lineNo)

  const points: RatingVersionPoint[] = ratings.map((rating) => ({
    ratingId: rating.id,
    sectionId: rating.sectionId,
    stationId: rating.stationId,
    stageM: rating.stageM,
    flowM3s: rating.flowM3s,
    measureNo: rating.measureNo,
    measuredAt: rating.measuredAt,
    determinedMethod: rating.determinedMethod
  }))

  const compares: Compare[] = ratings.map((rating) => {
    const predicted = fit.valid ? curveFlow(fit, rating.stageM) : rating.flowM3s
    const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
    return {
      id: `cmp_${rating.id}`,
      ratingId: rating.id,
      measuredFlow: rating.flowM3s,
      curveFlow: predicted,
      deviationPct,
      verdict: judgeDeviation(deviationPct, input.deviationLimitPct),
      operator: input.publishedBy || '林昭',
      comparedAt: input.publishedAt,
      side: 'station',
      versionId: input.id ?? null,
      lineNo,
      createdAt: input.now,
      updatedAt: input.now
    }
  })

  const version: RatingVersion = {
    id: input.id ?? `ver_pending_${lineNo}_${versionNo}`,
    lineNo,
    versionNo,
    stationId: dominantStationId(ratings),
    status: 'current',
    fit,
    points,
    sourceSectionIds: input.sourceSectionIds,
    publishedBy: input.publishedBy,
    reviewNote: input.reviewNote,
    deviationLimitPct: input.deviationLimitPct,
    publishedAt: input.publishedAt,
    side: 'station',
    createdAt: input.now,
    updatedAt: input.now
  }

  return { version, compares, fit }
}

/**
 * 发布前预览：把待复核测次的外业流量点并入该线现有点据后重新拟合，
 * 返回拟合结果与「并入点数」，供站上复核台判断复核能否通过（不落库）。
 */
export function previewLineFit(
  lineNo: string,
  existing: Array<{ stageM: number; flowM3s: number }>,
  incoming: Array<{ stageM: number; flowM3s: number }>
): RatingFitResult {
  return fitPowerCurve([...existing, ...incoming], lineNo)
}
