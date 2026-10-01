/**
 * 定线发布版本：站上每次复核通过后发布的一版定线成果。
 * 已发布的版本照旧可查；发布新版本时旧版本归档但不删除。
 */
import type { SurveySide } from './section'

/** 定线版本状态：已发布 / 已归档（旧版仍可查） / 草稿（复核中） */
export type RatingVersionStatus = 'published' | 'archived' | 'draft'

export const RATING_VERSION_STATUS_LABELS: Record<RatingVersionStatus, string> = {
  published: '已发布',
  archived: '已归档',
  draft: '复核中'
}

/** 定线发布版本：一次定线发布的完整成果快照 */
export interface RatingVersion {
  id: string
  /** 定线号：同一定线号的版本构成一条版本链 */
  lineNo: string
  /** 版本号：同一 lineNo 内递增，从 1 开始 */
  version: number
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0 */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 平均残差（%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R² */
  r2: number
  /** 是否可定线 */
  valid: boolean
  /** 版本状态 */
  status: RatingVersionStatus
  /** 侧别：定线发布归属站上侧 */
  side: SurveySide
  /** 复核意见 */
  note: string
  /** 发布时间 */
  publishedAt: string | null
  createdAt: number
  updatedAt: number
}

/** 由拟合结果生成一版定线发布记录（id 与时间戳由调用方补齐） */
export function createRatingVersion(
  fit: {
    lineNo: string
    a: number
    b: number
    h0: number
    sampleCount: number
    meanResidualPct: number
    maxResidualPct: number
    r2: number
    valid: boolean
  },
  version: number,
  note = ''
): Omit<RatingVersion, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    lineNo: fit.lineNo,
    version,
    a: fit.a,
    b: fit.b,
    h0: fit.h0,
    sampleCount: fit.sampleCount,
    meanResidualPct: fit.meanResidualPct,
    maxResidualPct: fit.maxResidualPct,
    r2: fit.r2,
    valid: fit.valid,
    status: 'draft',
    side: 'station',
    note,
    publishedAt: null
  }
}
