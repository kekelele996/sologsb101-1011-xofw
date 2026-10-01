/** 流量测验方法 */
import type { WorkSide } from './side'
import type { HandoffStatus } from './handoff'

export type MeasureMethod = '流速仪' | '浮标' | 'ADCP'

export const MEASURE_METHODS: MeasureMethod[] = ['流速仪', '浮标', 'ADCP']

/** 断面测次：一次完整的流量测验（外业采集 + 站上整编 两侧字段共档但分写） */
export interface Section {
  id: string
  /** 所属测站 */
  stationId: string
  /** 测次号，如 2024-06-001 */
  measureNo: string
  /** 起点距（m）：断面起点到测流断面的距离（外业） */
  startDistanceM: number
  /** 水位（m）（外业实测） */
  stageM: number
  /**
   * 外业现场记录的测验方法（流速仪 / 浮标 / ADCP）。
   * 仅供外业记录，最终采用哪种测法由站上认定（determinedMethod），两者不互相覆盖。
   */
  method: MeasureMethod
  /** 测流时间 */
  measuredAt: string

  /* ----------------------------- 外业侧（field） ----------------------------- */
  /** 归属侧：测次由外业建立，升级旧库时补 field */
  side: WorkSide
  /** 交回状态（draft 外业编辑中 / submitted 待复核 / returned 退回重试 / accepted 已采用） */
  handoffStatus: HandoffStatus
  /** 交回时固化的断面流量快照（m³/s）：流量按外业算，站上不得改写 */
  fieldFlowM3s: number
  /** 固化流量时的断面面积（m²）与断面平均流速（m/s），随外业快照一并冻结 */
  fieldAreaM2: number
  fieldMeanVelocityMs: number
  /** 外业交回拟并入的定线号 */
  targetLineNo: string
  /** 交回时间 / 退回后最近一次重新交回时间 */
  handedAt: string | null
  /** 外业交回备注 */
  handoffNote: string
  /** 最近一次退回时间与次数（回交失败后外业留在原处重试） */
  returnedAt: string | null
  returnReason: string
  returnCount: number

  /* ----------------------------- 站上侧（station） ---------------------------- */
  /** 站上认定的测法；null 表示尚未认定，测法认定听站上 */
  determinedMethod: MeasureMethod | null
  /** 站上认定时间 / 认定操作人 / 认定意见 */
  determinedAt: string | null
  determinedBy: string
  determinationNote: string
  /** 已采用该测次点据的定线号（发布后回写；历史点据为空串） */
  acceptedLineNo: string
  /** 已被哪一定线版本采用（发布后回写） */
  acceptedVersionId: string | null
  acceptedAt: string | null

  createdAt: number
  updatedAt: number
}

/** 外业可写的测次采集字段（站上侧写入一律拒绝，避免互相覆盖） */
export const FIELD_SECTION_KEYS = [
  'measureNo',
  'startDistanceM',
  'stageM',
  'method',
  'measuredAt',
  'targetLineNo',
  'handoffNote'
] as const satisfies ReadonlyArray<keyof Section>

/** 站上可写的整编字段（认定 / 采用），外业侧写入一律拒绝 */
export const STATION_SECTION_KEYS = [
  'determinedMethod',
  'determinedAt',
  'determinedBy',
  'determinationNote',
  'acceptedLineNo',
  'acceptedVersionId',
  'acceptedAt'
] as const satisfies ReadonlyArray<keyof Section>

/** 交回状态机相关字段（仅 utils/handoff.ts 状态迁移时写） */
export const HANDOFF_SECTION_KEYS = [
  'handoffStatus',
  'fieldFlowM3s',
  'fieldAreaM2',
  'fieldMeanVelocityMs',
  'handedAt',
  'handoffNote',
  'returnedAt',
  'returnReason',
  'returnCount'
] as const satisfies ReadonlyArray<keyof Section>

/** 断面列表页的筛选条件（存于 sectionStore） */
export interface SectionFilterState {
  keyword: string
  methods: MeasureMethod[]
  /** 水位下限（m） */
  minStageM: number | null
  /** 交回状态筛选（外业 / 站上工作台各取所需） */
  statuses: HandoffStatus[]
}

export function createEmptySectionFilter(): SectionFilterState {
  return {
    keyword: '',
    methods: [],
    minStageM: null,
    statuses: []
  }
}
