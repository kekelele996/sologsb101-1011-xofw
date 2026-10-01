/** 流量测验方法 */
export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/**
 * 侧别：区分同一份测次的外业与站上两侧。
 * - field 外业：管测深、流速、流量（起点距 / 水位 / 垂线 / 测点 / 断面流量）
 * - station 站上：管测法认定与定线发布（测法认证、关系点据、定线版本）
 * 两侧动过同一测次时各写各的字段，不互相覆盖。
 */
export type SurveySide = 'field' | 'station'

export const SURVEY_SIDES: SurveySide[] = ['field', 'station']

export const SIDE_LABELS: Record<SurveySide, string> = {
  field: '外业',
  station: '站上'
}

/**
 * 测次交回状态（外业 → 站上 的工作流）。
 * - draft 草稿：外业录入中，可反复修改
 * - returned 已交回：外业已提交，待站上复核
 * - published 已发布：站上复核通过，成果入库并发布定线新版本
 * - rejected 已退回：复核未通过，外业留在原处重试（已发布版本照旧可查）
 */
export type SurveyStatus = 'draft' | 'returned' | 'published' | 'rejected'

export const SURVEY_STATUS_LABELS: Record<SurveyStatus, string> = {
  draft: '草稿',
  returned: '已交回',
  published: '已发布',
  rejected: '已退回'
}

export const SURVEY_STATUS_TAG_TYPE: Record<SurveyStatus, 'info' | 'warning' | 'success' | 'danger'> = {
  draft: 'info',
  returned: 'warning',
  published: 'success',
  rejected: 'danger'
}

/** 断面测次：一次完整的流量测验 */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离（外业） */
  startDistanceM: number
  /** 水位（m）（外业） */
  stageM: number
  /**
   * 测法（站上认定）：外业可先填观测测法，最终以站上认定为准。
   * 两侧各写各的字段，外业改测点不影响站上认定的测法。
   */
  method: MeasureMethod
  /** 外业观测测法（外业记录，供站上认定参考） */
  methodObserved?: MeasureMethod
  /** 测法认定时间（站上） */
  methodCertifiedAt?: string
  /** 测流时间 */
  measuredAt: string
  /** 侧别：该测次由外业发起，归属外业侧 */
  side: SurveySide
  /** 交回状态：草稿 / 已交回 / 已发布 / 已退回 */
  status: SurveyStatus
  /** 交回时间（外业 → 站上） */
  returnedAt?: string
  /** 复核时间（站上） */
  reviewedAt?: string
  /** 复核意见（站上） */
  reviewNote?: string
  createdAt: number
  updatedAt: number
}

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null
  }
}
