/**
 * 定线版本（站上侧）：复核通过后发布的一版水位—流量关系定线，一经发布不可变。
 * - 站上拿该定线号下全部点据重新拟合，复核通过才发新的一版；
 * - 每一版冻结拟合参数、参与点据与比测偏差，已发布那版始终可查；
 * - 同一定线号 versionNo 递增，仅 status='current' 的版本为当前生效版。
 */
import type { MeasureMethod } from './section'
import type { RatingFitResult } from './rating'
import type { WorkSide } from './side'

/** 版本状态：current 当前生效 / superseded 已被新版取代 */
export type RatingVersionStatus = 'current' | 'superseded'

export const RATING_VERSION_STATUS_LABEL: Record<RatingVersionStatus, string> = {
  current: '当前生效',
  superseded: '历史版本'
}

/** 随版本冻结的点据快照 */
export interface RatingVersionPoint {
  ratingId: string
  sectionId: string | null
  stationId: string
  stageM: number
  /** 流量取外业成果，发布时冻结 */
  flowM3s: number
  measureNo: string
  measuredAt: string
  /** 站上认定的测法 */
  determinedMethod: MeasureMethod | null
}

export interface RatingVersion {
  id: string
  /** 定线号，同号线按 versionNo 递增 */
  lineNo: string
  /** 版本序号（1 起） */
  versionNo: number
  /** 主属测站（该版本点据中出现最多的测站） */
  stationId: string | null
  /** 发布状态 */
  status: RatingVersionStatus
  /** 冻结的幂函数定线结果 Q = a×(H-H0)^b */
  fit: RatingFitResult
  /** 发布时参与拟合的全部点据快照 */
  points: RatingVersionPoint[]
  /** 触发本次发布的交回测次 id 列表 */
  sourceSectionIds: string[]
  /** 发布操作人（复核人） */
  publishedBy: string
  /** 复核意见 */
  reviewNote: string
  /** 偏差限值（%，发布时冻结） */
  deviationLimitPct: number
  /** 发布时间 */
  publishedAt: string
  /** 归属侧 */
  side: WorkSide
  createdAt: number
  updatedAt: number
}
