/**
 * 职责侧别：外业测验（field）与站上整编（station）两侧分开。
 * - 外业管：测深（垂线水深）、流速（测点）、流量（部分面积法成果）
 * - 站上管：测法认定、关系点据与定线发布
 * 同一条业务记录按 side 标明归属侧；升级旧库时按两侧补齐。
 */
export type WorkSide = 'field' | 'station'

export const WORK_SIDES: WorkSide[] = ['field', 'station']

export const SIDE_LABEL: Record<WorkSide, string> = {
  field: '外业',
  station: '站上'
}

export const SIDE_FULL_LABEL: Record<WorkSide, string> = {
  field: '外业测验',
  station: '站上整编'
}

/** 各业务表的归属侧别（升级旧库时据此补 side 字段） */
export const TABLE_SIDE = {
  stations: 'station',
  sections: 'field',
  verticals: 'field',
  points: 'field',
  ratings: 'station',
  compares: 'station',
  ratingVersions: 'station'
} as const satisfies Record<string, WorkSide>
