/**
 * 测次交回状态机：外业测验与站上整编之间通过「交回 / 复核 / 退回」衔接。
 *
 *   draft 外业编辑中
 *     └─ 外业交回 → submitted（站上待复核，外业数据冻结）
 *          ├─ 站上退回 → returned（回交失败：外业留在原处重试，已发布那版照旧可查）
 *          │    └─ 外业重试再交回 → submitted
 *          └─ 站上复核通过 → accepted（站上拿全部点据重新拟合，发布新一版定线）
 *               └─ 外业申请修订 → draft（改完重新交回走复核；发布版本不被覆盖）
 */
import type { MeasureMethod } from './section'

/** 测次交回状态 */
export type HandoffStatus = 'draft' | 'submitted' | 'returned' | 'accepted'

export const HANDOFF_STATUSES: HandoffStatus[] = ['draft', 'submitted', 'returned', 'accepted']

export const HANDOFF_STATUS_LABEL: Record<HandoffStatus, string> = {
  draft: '外业编辑中',
  submitted: '已交回待复核',
  returned: '退回外业重试',
  accepted: '站上已采用'
}

/** 状态对应的标签配色（el-tag type） */
export const HANDOFF_STATUS_TAG_TYPE: Record<HandoffStatus, 'info' | 'warning' | 'danger' | 'success'> = {
  draft: 'info',
  submitted: 'warning',
  returned: 'danger',
  accepted: 'success'
}

/** 合法状态迁移表：key 为当前状态，value 为可迁入的状态集合 */
const HANDOFF_TRANSITIONS: Record<HandoffStatus, HandoffStatus[]> = {
  draft: ['submitted'],
  submitted: ['accepted', 'returned'],
  returned: ['submitted'],
  accepted: ['draft']
}

/** 校验状态迁移是否合法，非法时抛出说明性错误 */
export function assertTransition(from: HandoffStatus, to: HandoffStatus): void {
  if (from === to) return
  const allowed = HANDOFF_TRANSITIONS[from] ?? []
  if (!allowed.includes(to)) {
    throw new Error(`测次不能从「${HANDOFF_STATUS_LABEL[from]}」变为「${HANDOFF_STATUS_LABEL[to]}」`)
  }
}

/** 外业可编辑测深 / 流速 / 流量等采集字段的状态 */
export function isFieldEditable(status: HandoffStatus): boolean {
  return status === 'draft' || status === 'returned'
}

/** 站上复核台待处理的测次（已交回） */
export function isPendingReview(status: HandoffStatus): boolean {
  return status === 'submitted'
}

/** 测法认定结果（站上侧；未认定为 null） */
export type DeterminedMethod = MeasureMethod | null

/** 外业交回时写入的交回信息 */
export interface HandoffSubmitPayload {
  /** 拟并入的定线号，如 A / B / C */
  targetLineNo: string
  /** 交回备注（外业填写） */
  handoffNote?: string
}

/** 站上退回时写入的退回信息 */
export interface HandoffRejectPayload {
  /** 退回原因（外业据此留在原处重试） */
  returnReason: string
  /** 退回操作人 */
  reviewer?: string
}
