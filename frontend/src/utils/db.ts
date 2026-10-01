/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 库名 gbhydrogaug，含数据结构版本号与升级迁移逻辑
 * - 外业测验（field：测深 / 流速 / 流量）与站上整编（station：测法认定 / 定线发布）两侧分写
 * - 定线版本 ratingVersions：复核通过才发布，逐版冻结不可变，历史版本可查
 * - 首次打开自动播种互相引用的演示数据（测站 → 断面 → 垂线 → 测点 → 点据 → 比测）
 * - 纯前端应用：不依赖任何后端服务或数据库服务
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import type { Station } from '@/types/station'
import type { Section, MeasureMethod } from '@/types/section'
import type { Vertical } from '@/types/vertical'
import type { Point } from '@/types/point'
import type { Rating } from '@/types/rating'
import type { Compare } from '@/types/compare'
import type { RatingVersion } from '@/types/ratingVersion'
import { DEVIATION_LIMIT_PCT } from '@/types/compare'
import { calcMeanVelocity, calcSectionDischarge, DEFAULT_WEIGHTS, round } from '@/utils/flow'
import { assemblePublishedVersion } from '@/utils/ratingPublish'

/** 当前数据结构版本号：每次调整字段结构必须 +1 并补迁移 */
export const DB_VERSION = 3

/** 数据库名（浏览器 IndexedDB 中的库名） */
export const DB_NAME = 'gbhydrogaug'

/** localStorage 侧少量元数据键名 */
export const LS_KEYS = {
  dbVersion: 'gbhydrogaug:db-version',
  lastBackupAt: 'gbhydrogaug:last-backup-at',
  lastStationId: 'gbhydrogaug:last-station-id'
} as const

/** 备份文件结构，供 utils/export.ts 与导出页使用 */
export interface BackupPayload {
  app: 'gbhydrogaug'
  dbVersion: number
  exportedAt: string
  stations: Station[]
  sections: Section[]
  verticals: Vertical[]
  points: Point[]
  ratings: Rating[]
  compares: Compare[]
  ratingVersions: RatingVersion[]
}

class HydroGaugeDatabase extends Dexie {
  stations!: Table<Station, string>
  sections!: Table<Section, string>
  verticals!: Table<Vertical, string>
  points!: Table<Point, string>
  ratings!: Table<Rating, string>
  compares!: Table<Compare, string>
  ratingVersions!: Table<RatingVersion, string>

  constructor() {
    super(DB_NAME)

    // v1：初版结构（保留历史数据，仅基础索引）
    this.version(1).stores({
      stations: 'id, name, river, sectionCode',
      sections: 'id, stationId, measureNo, method',
      verticals: 'id, sectionId, no',
      points: 'id, verticalId, relativeDepth',
      ratings: 'id, stationId, lineNo, stageM',
      compares: 'id, ratingId, verdict'
    })

    // v2：补齐筛选与统计需要的索引（河名/集水面积、水位、测法、偏差判定）
    this.version(2).stores({
      stations: 'id, name, river, sectionCode, catchmentKm2, updatedAt',
      sections: 'id, stationId, measureNo, method, stageM, measuredAt, updatedAt',
      verticals: 'id, sectionId, no, startDistanceM, depthM, updatedAt',
      points: 'id, verticalId, relativeDepth, velocityMs, updatedAt',
      ratings: 'id, stationId, lineNo, stageM, flowM3s, measuredAt, updatedAt',
      compares: 'id, ratingId, verdict, deviationPct, comparedAt, updatedAt'
    })

    // v3：外业 / 站上两侧分开，测次交回状态机 + 定线版本发布
    this.version(DB_VERSION)
      .stores({
        stations: 'id, name, river, sectionCode, catchmentKm2, side, updatedAt',
        sections:
          'id, stationId, measureNo, method, stageM, measuredAt, side, handoffStatus, targetLineNo, acceptedLineNo, updatedAt',
        verticals: 'id, sectionId, no, startDistanceM, depthM, side, updatedAt',
        points: 'id, verticalId, relativeDepth, velocityMs, side, updatedAt',
        ratings: 'id, stationId, lineNo, stageM, flowM3s, sectionId, side, publishedVersionId, measuredAt, updatedAt',
        compares: 'id, ratingId, verdict, deviationPct, versionId, lineNo, side, comparedAt, updatedAt',
        ratingVersions: 'id, lineNo, versionNo, status, stationId, side, publishedAt'
      })
      .upgrade(async (tx) => {
        const now = Date.now()
        const iso = new Date(now).toISOString()

        // ① 时间戳与既有默认字段（沿用 v2 的回填规则）
        const stamps: Array<[string, () => Record<string, unknown>]> = [
          ['stations', () => ({})],
          ['sections', () => ({ measuredAt: iso })],
          ['verticals', () => ({ pointCount: 0, bedNote: '' })],
          ['points', () => ({ weight: DEFAULT_WEIGHTS[1], durationS: 100 })],
          ['ratings', () => ({ measureNo: '', lineNo: 'A' })],
          ['compares', () => ({ operator: '', comparedAt: iso })]
        ]
        for (const [tableName, defaults] of stamps) {
          await tx
            .table(tableName)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              if (typeof row.createdAt !== 'number') row.createdAt = now
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt
              Object.assign(row, defaults())
            })
        }

        // ② 按两侧补侧别（side）与归属字段
        await tx.table('stations').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'station'
        })
        await tx.table('verticals').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'field'
        })
        await tx.table('points').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'field'
        })
        await tx.table('ratings').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'station'
          if (row.sectionId === undefined) row.sectionId = null
          if (row.determinedMethod === undefined) row.determinedMethod = null
          if (row.publishedVersionId === undefined) row.publishedVersionId = null
        })
        await tx.table('compares').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'station'
          if (row.versionId === undefined) row.versionId = null
          if (typeof row.lineNo !== 'string') row.lineNo = 'A'
        })

        // ③ 测次升级为交回状态机：旧库里的测次视为「已交回并采用」，
        //    外业流量快照按当时垂线/测点重算（流量按外业算），测法默认尚未由站上认定。
        const oldSections: Section[] = await tx.table('sections').toCollection().toArray()
        const oldVerticals: Vertical[] = await tx.table('verticals').toCollection().toArray()
        const oldPoints: Point[] = await tx.table('points').toCollection().toArray()
        const oldRatings: Rating[] = await tx.table('ratings').toCollection().toArray()

        const pointsByVertical = new Map<string, Point[]>()
        oldPoints.forEach((point) => {
          const list = pointsByVertical.get(point.verticalId) ?? []
          list.push(point)
          pointsByVertical.set(point.verticalId, list)
        })
        const flowBySection = new Map<string, { flowM3s: number; areaM2: number; meanVelocityMs: number }>()
        oldSections.forEach((section) => {
          const verticals = oldVerticals
            .filter((vertical) => vertical.sectionId === section.id)
            .sort((a, b) => a.startDistanceM - b.startDistanceM)
          const result = calcSectionDischarge(
            verticals.map((vertical) => ({
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
          flowBySection.set(section.id, {
            flowM3s: result.flowM3s,
            areaM2: result.areaM2,
            meanVelocityMs: result.meanVelocityMs
          })
        })

        await tx.table('sections').toCollection().modify((row: Record<string, unknown>) => {
          if (row.side !== 'field' && row.side !== 'station') row.side = 'field'
          if (!['draft', 'submitted', 'returned', 'accepted'].includes(String(row.handoffStatus))) {
            row.handoffStatus = 'accepted'
          }
          const flow = flowBySection.get(String(row.id))
          row.fieldFlowM3s = typeof row.fieldFlowM3s === 'number' ? row.fieldFlowM3s : flow?.flowM3s ?? 0
          row.fieldAreaM2 = typeof row.fieldAreaM2 === 'number' ? row.fieldAreaM2 : flow?.areaM2 ?? 0
          row.fieldMeanVelocityMs =
            typeof row.fieldMeanVelocityMs === 'number' ? row.fieldMeanVelocityMs : flow?.meanVelocityMs ?? 0
          if (typeof row.targetLineNo !== 'string') {
            const matched = oldRatings.find((rating) => rating.measureNo === row.measureNo && rating.stationId === row.stationId)
            row.targetLineNo = matched?.lineNo ?? 'A'
          }
          if (typeof row.handedAt !== 'string') row.handedAt = iso
          if (typeof row.handoffNote !== 'string') row.handoffNote = ''
          if (typeof row.returnedAt !== 'string') row.returnedAt = null
          if (typeof row.returnReason !== 'string') row.returnReason = ''
          if (typeof row.returnCount !== 'number') row.returnCount = 0
          if (typeof row.determinedMethod !== 'string') row.determinedMethod = null
          if (typeof row.determinedAt !== 'string') row.determinedAt = null
          if (typeof row.determinedBy !== 'string') row.determinedBy = ''
          if (typeof row.determinationNote !== 'string') row.determinationNote = ''
          if (typeof row.acceptedLineNo !== 'string') row.acceptedLineNo = row.targetLineNo
          if (typeof row.acceptedVersionId !== 'string') row.acceptedVersionId = null
          if (typeof row.acceptedAt !== 'string') row.acceptedAt = iso
        })

        // ④ 既有定线：每条定线号用全部点据补发首版 v1（冻结参数/点据/比测），已发布那版可查
        const upgradedSections = await tx.table<Section, string>('sections').toArray()
        const lineGroups = new Map<string, Rating[]>()
        oldRatings.forEach((rating) => {
          const list = lineGroups.get(rating.lineNo) ?? []
          list.push(rating)
          lineGroups.set(rating.lineNo, list)
        })
        const versions: RatingVersion[] = []
        const versionCompares: Compare[] = []
        for (const [lineNo, lineRatings] of lineGroups) {
          const versionId = `ver_${lineNo.toLowerCase()}_1`
          const assembled = assemblePublishedVersion({
            id: versionId,
            lineNo,
            versionNo: 1,
            ratings: lineRatings,
            sourceSectionIds: upgradedSections
              .filter((section) => section.acceptedLineNo === lineNo)
              .map((section) => section.id),
            publishedBy: '升级迁移',
            reviewNote: '由历史点据补发的首版定线',
            deviationLimitPct: DEVIATION_LIMIT_PCT,
            publishedAt: iso,
            now
          })
          versions.push(assembled.version)
          assembled.compares.forEach((compare) => compare.versionId = versionId)
          versionCompares.push(...assembled.compares)

          await tx
            .table('ratings')
            .where('lineNo')
            .equals(lineNo)
            .modify((row: Record<string, unknown>) => {
              row.publishedVersionId = versionId
            })
          await tx
            .table('sections')
            .where('acceptedLineNo')
            .equals(lineNo)
            .modify((row: Record<string, unknown>) => {
              row.acceptedVersionId = versionId
            })
        }
        if (versions.length > 0) {
          await tx.table('ratingVersions').clear()
          await tx.table('ratingVersions').bulkPut(versions)
          await tx.table('compares').clear()
          await tx.table('compares').bulkPut(versionCompares)
        }
      })
  }
}

export const db = new HydroGaugeDatabase()

/** 生成主键：短前缀 + 时间戳 + 随机串，避免多标签页写入冲突 */
export function createId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${Date.now().toString(36)}${rand}`
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchTable<T>(table: () => Table<T, string>): { subscribe: (cb: (rows: T[]) => void) => () => void } {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/* ------------------------------ 演示数据播种 ------------------------------ */

interface SeedPointSpec {
  id: string
  relativeDepth: number
  velocityMs: number
  durationS?: number
}
interface SeedVerticalSpec {
  id: string
  no: number
  startDistanceM: number
  depthM: number
  bedNote: string
  points: SeedPointSpec[]
}
interface SeedSectionSpec {
  id: string
  measureNo: string
  startDistanceM: number
  stageM: number
  method: MeasureMethod
  measuredAt: string
  targetLineNo: string
  handoffStatus: Section['handoffStatus']
  /** 退回原因（returned 演示测次用） */
  returnReason?: string
  handoffNote?: string
  verticals: SeedVerticalSpec[]
}
interface SeedStationBundle {
  station: Omit<Station, 'side' | 'createdAt' | 'updatedAt'>
  sections: SeedSectionSpec[]
}

function pointWeight(count: number): number {
  return Number((1 / count).toFixed(4))
}

/**
 * 播种演示数据：3 个测站 → 6 个断面测次（覆盖交回四态）→ 垂线 → 测点，
 * 已采用测次的外业流量成果由站上接收为关系点据并发布 A/B/C 三线 v1（C 线含超限点）。
 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const iso = new Date(now).toISOString()

  const stationBundles: SeedStationBundle[] = [
    {
      station: {
        id: 'stn_lh01',
        name: '龙门水文站',
        river: '澜沧江',
        catchmentKm2: 45200,
        sectionCode: 'CS-LM-01',
        remark: '基本水文站，缆道测流，断面稳定'
      },
      sections: [
        {
          id: 'sec_lh_2406',
          measureNo: '2024-06-001',
          startDistanceM: 12.5,
          stageM: 5.42,
          method: '流速仪',
          measuredAt: '2024-06-12T08:30:00.000Z',
          targetLineNo: 'A',
          handoffStatus: 'accepted',
          handoffNote: '三点法，主流稳定，流量成果随测次交回',
          verticals: [
            {
              id: 'vrt_lh_1',
              no: 1,
              startDistanceM: 6.5,
              depthM: 1.4,
              bedNote: '左岸浅滩，砾石河床',
              points: [
                { id: 'pnt_lh_11', relativeDepth: 0.2, velocityMs: 0.62 },
                { id: 'pnt_lh_12', relativeDepth: 0.8, velocityMs: 0.48 }
              ]
            },
            {
              id: 'vrt_lh_2',
              no: 2,
              startDistanceM: 14.0,
              depthM: 3.2,
              bedNote: '主流，砂卵石',
              points: [
                { id: 'pnt_lh_21', relativeDepth: 0.2, velocityMs: 1.42 },
                { id: 'pnt_lh_22', relativeDepth: 0.6, velocityMs: 1.18 },
                { id: 'pnt_lh_23', relativeDepth: 0.8, velocityMs: 0.96 }
              ]
            },
            {
              id: 'vrt_lh_3',
              no: 3,
              startDistanceM: 22.0,
              depthM: 2.1,
              bedNote: '右岸缓流，细砂',
              points: [
                { id: 'pnt_lh_31', relativeDepth: 0.2, velocityMs: 0.82 },
                { id: 'pnt_lh_32', relativeDepth: 0.8, velocityMs: 0.64 }
              ]
            }
          ]
        },
        {
          id: 'sec_lh_2407',
          measureNo: '2024-07-002',
          startDistanceM: 12.5,
          stageM: 6.15,
          method: 'ADCP',
          measuredAt: '2024-07-18T09:10:00.000Z',
          targetLineNo: 'A',
          handoffStatus: 'accepted',
          handoffNote: 'ADCP 走航断面，外业自报 ADCP，站上认定为 ADCP',
          verticals: [
            {
              id: 'vrt_lh_4',
              no: 1,
              startDistanceM: 8.0,
              depthM: 3.6,
              bedNote: 'ADCP 走航断面，主槽左侧',
              points: [
                { id: 'pnt_lh_41', relativeDepth: 0.2, velocityMs: 1.72, durationS: 120 },
                { id: 'pnt_lh_42', relativeDepth: 0.6, velocityMs: 1.52, durationS: 120 },
                { id: 'pnt_lh_43', relativeDepth: 0.8, velocityMs: 1.24, durationS: 120 }
              ]
            },
            {
              id: 'vrt_lh_5',
              no: 2,
              startDistanceM: 18.0,
              depthM: 4.2,
              bedNote: 'ADCP 主泓',
              points: [
                { id: 'pnt_lh_51', relativeDepth: 0.2, velocityMs: 2.05, durationS: 120 },
                { id: 'pnt_lh_52', relativeDepth: 0.6, velocityMs: 1.82, durationS: 120 },
                { id: 'pnt_lh_53', relativeDepth: 0.8, velocityMs: 1.55, durationS: 120 }
              ]
            }
          ]
        },
        {
          id: 'sec_lh_2409',
          measureNo: '2024-09-010',
          startDistanceM: 12.5,
          stageM: 6.58,
          method: '流速仪',
          measuredAt: '2024-09-15T08:00:00.000Z',
          targetLineNo: 'A',
          handoffStatus: 'draft',
          handoffNote: '',
          verticals: []
        },
        {
          id: 'sec_lh_2410',
          measureNo: '2024-10-011',
          startDistanceM: 12.5,
          stageM: 6.88,
          method: '流速仪',
          measuredAt: '2024-10-12T08:20:00.000Z',
          targetLineNo: 'A',
          handoffStatus: 'submitted',
          handoffNote: '退水期加测，三点法，资料已自检，申请并入 A 线待站上认定测法',
          verticals: [
            {
              id: 'vrt_lh_6',
              no: 1,
              startDistanceM: 7.0,
              depthM: 3.0,
              bedNote: '主槽左侧',
              points: [
                { id: 'pnt_lh_61', relativeDepth: 0.2, velocityMs: 1.62 },
                { id: 'pnt_lh_62', relativeDepth: 0.6, velocityMs: 1.4 },
                { id: 'pnt_lh_63', relativeDepth: 0.8, velocityMs: 1.14 }
              ]
            },
            {
              id: 'vrt_lh_7',
              no: 2,
              startDistanceM: 16.5,
              depthM: 3.6,
              bedNote: '主泓',
              points: [
                { id: 'pnt_lh_71', relativeDepth: 0.2, velocityMs: 1.96 },
                { id: 'pnt_lh_72', relativeDepth: 0.6, velocityMs: 1.72 },
                { id: 'pnt_lh_73', relativeDepth: 0.8, velocityMs: 1.46 }
              ]
            }
          ]
        }
      ]
    },
    {
      station: {
        id: 'stn_qj02',
        name: '青矶水位站',
        river: '沅江',
        catchmentKm2: 1860,
        sectionCode: 'CS-QJ-02',
        remark: '小河站，浮标法为主，洪水期加测'
      },
      sections: [
        {
          id: 'sec_qj_2405',
          measureNo: '2024-05-003',
          startDistanceM: 4.2,
          stageM: 3.18,
          method: '浮标',
          measuredAt: '2024-05-22T07:50:00.000Z',
          targetLineNo: 'B',
          handoffStatus: 'accepted',
          handoffNote: '浮标中泓法',
          verticals: [
            {
              id: 'vrt_qj_1',
              no: 1,
              startDistanceM: 2.4,
              depthM: 1.1,
              bedNote: '浮标上断面',
              points: [
                { id: 'pnt_qj_11', relativeDepth: 0.2, velocityMs: 0.62 },
                { id: 'pnt_qj_12', relativeDepth: 0.8, velocityMs: 0.48 }
              ]
            },
            {
              id: 'vrt_qj_2',
              no: 2,
              startDistanceM: 6.8,
              depthM: 1.9,
              bedNote: '浮标中泓',
              points: [
                { id: 'pnt_qj_21', relativeDepth: 0.2, velocityMs: 0.96 },
                { id: 'pnt_qj_22', relativeDepth: 0.8, velocityMs: 0.78 }
              ]
            }
          ]
        },
        {
          id: 'sec_qj_2408',
          measureNo: '2024-08-004',
          startDistanceM: 4.2,
          stageM: 4.36,
          method: '流速仪',
          measuredAt: '2024-08-09T06:40:00.000Z',
          targetLineNo: 'B',
          handoffStatus: 'returned',
          handoffNote: '涨水期加测，申请并入 B 线',
          returnReason: '测点流速历时偏短（100s）且 0.8 水深流速异常，请复测后重新交回',
          verticals: [
            {
              id: 'vrt_qj_3',
              no: 1,
              startDistanceM: 3.1,
              depthM: 1.6,
              bedNote: '涨水期，流速仪三点法',
              points: [
                { id: 'pnt_qj_31', relativeDepth: 0.2, velocityMs: 1.18 },
                { id: 'pnt_qj_32', relativeDepth: 0.6, velocityMs: 1.02 },
                { id: 'pnt_qj_33', relativeDepth: 0.8, velocityMs: 0.86 }
              ]
            },
            {
              id: 'vrt_qj_4',
              no: 2,
              startDistanceM: 7.6,
              depthM: 2.4,
              bedNote: '主槽，卵石夹砂',
              points: [
                { id: 'pnt_qj_41', relativeDepth: 0.2, velocityMs: 1.42 },
                { id: 'pnt_qj_42', relativeDepth: 0.6, velocityMs: 1.26 },
                { id: 'pnt_qj_43', relativeDepth: 0.8, velocityMs: 1.08 }
              ]
            }
          ]
        }
      ]
    },
    {
      station: {
        id: 'stn_bs03',
        name: '白沙滩巡测站',
        river: '澜沧江',
        catchmentKm2: 51200,
        sectionCode: 'CS-BS-03',
        remark: '巡测断面，与龙门站比测'
      },
      sections: [
        {
          id: 'sec_bs_2406',
          measureNo: '2024-06-005',
          startDistanceM: 18.0,
          stageM: 5.36,
          method: 'ADCP',
          measuredAt: '2024-06-20T10:05:00.000Z',
          targetLineNo: 'C',
          handoffStatus: 'accepted',
          handoffNote: 'ADCP 比测次',
          verticals: [
            {
              id: 'vrt_bs_1',
              no: 1,
              startDistanceM: 10.0,
              depthM: 2.6,
              bedNote: 'ADCP 左半断面',
              points: [
                { id: 'pnt_bs_11', relativeDepth: 0.2, velocityMs: 1.30, durationS: 120 },
                { id: 'pnt_bs_12', relativeDepth: 0.6, velocityMs: 1.14, durationS: 120 },
                { id: 'pnt_bs_13', relativeDepth: 0.8, velocityMs: 0.96, durationS: 120 }
              ]
            },
            {
              id: 'vrt_bs_2',
              no: 2,
              startDistanceM: 24.0,
              depthM: 3.4,
              bedNote: 'ADCP 右半断面',
              points: [
                { id: 'pnt_bs_21', relativeDepth: 0.2, velocityMs: 1.52, durationS: 120 },
                { id: 'pnt_bs_22', relativeDepth: 0.6, velocityMs: 1.36, durationS: 120 },
                { id: 'pnt_bs_23', relativeDepth: 0.8, velocityMs: 1.12, durationS: 120 }
              ]
            }
          ]
        }
      ]
    }
  ]

  // 历史遗留点据（无对应测次，站上手工整编的早期点据；各线补足定线点数，
  // 流量量级与外业部分面积法实算成果一致，保证幂函数定线有效）
  const legacyRatingSpecs: Array<Omit<Rating, 'side' | 'sectionId' | 'determinedMethod' | 'publishedVersionId' | 'createdAt' | 'updatedAt'>> = [
    { id: 'rat_lh_a0', stationId: 'stn_lh01', stageM: 4.62, flowM3s: 18.0, lineNo: 'A', measureNo: '2024-04-001', measuredAt: '2024-04-08T08:00:00.000Z' },
    { id: 'rat_qj_b0', stationId: 'stn_qj02', stageM: 2.5, flowM3s: 2.6, lineNo: 'B', measureNo: '2023-05-001', measuredAt: '2023-05-11T07:30:00.000Z' },
    { id: 'rat_bs_c0', stationId: 'stn_bs03', stageM: 4.9, flowM3s: 32.0, lineNo: 'C', measureNo: '2024-05-004', measuredAt: '2024-05-28T09:00:00.000Z' },
    { id: 'rat_bs_c3', stationId: 'stn_bs03', stageM: 5.88, flowM3s: 82.0, lineNo: 'C', measureNo: '2024-07-007', measuredAt: '2024-07-25T09:30:00.000Z' },
    { id: 'rat_bs_c4', stationId: 'stn_bs03', stageM: 6.44, flowM3s: 66.0, lineNo: 'C', measureNo: '2024-08-008', measuredAt: '2024-08-15T09:40:00.000Z' }
  ]

  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points],
    async () => {
      await db.stations.bulkPut(
        stationBundles.map((bundle) => {
          const station: Station = {
            ...bundle.station,
            side: 'station',
            createdAt: now,
            updatedAt: now
          }
          return station
        })
      )

      for (const bundle of stationBundles) {
        for (const spec of bundle.sections) {
          const stamp = now + spec.id.length
          const accepted = spec.handoffStatus === 'accepted'
          const section: Section = {
            id: spec.id,
            stationId: bundle.station.id,
            measureNo: spec.measureNo,
            startDistanceM: spec.startDistanceM,
            stageM: spec.stageM,
            method: spec.method,
            measuredAt: spec.measuredAt,
            side: 'field',
            handoffStatus: spec.handoffStatus,
            fieldFlowM3s: 0,
            fieldAreaM2: 0,
            fieldMeanVelocityMs: 0,
            targetLineNo: spec.targetLineNo,
            handedAt: spec.handoffStatus === 'draft' ? null : spec.measuredAt,
            handoffNote: spec.handoffNote ?? '',
            returnedAt: spec.handoffStatus === 'returned' ? spec.measuredAt : null,
            returnReason: spec.returnReason ?? '',
            returnCount: spec.handoffStatus === 'returned' ? 1 : 0,
            // 播种时站上已对已采用测次完成测法认定（测法听站上；外业自报仅作记录）
            determinedMethod: accepted ? spec.method : null,
            determinedAt: accepted ? spec.measuredAt : null,
            determinedBy: accepted ? '林昭' : '',
            determinationNote: accepted ? '复核认定与外业记录一致' : '',
            acceptedLineNo: accepted ? spec.targetLineNo : '',
            acceptedVersionId: null,
            acceptedAt: accepted ? spec.measuredAt : null,
            createdAt: stamp,
            updatedAt: stamp
          }
          await db.sections.put(section)

          const verticals: Vertical[] = []
          const points: Point[] = []
          spec.verticals.forEach((verticalSpec) => {
            const count = verticalSpec.points.length
            verticals.push({
              id: verticalSpec.id,
              sectionId: spec.id,
              no: verticalSpec.no,
              startDistanceM: verticalSpec.startDistanceM,
              depthM: verticalSpec.depthM,
              pointCount: count,
              bedNote: verticalSpec.bedNote,
              side: 'field',
              createdAt: stamp + verticalSpec.no,
              updatedAt: stamp + verticalSpec.no
            })
            verticalSpec.points.forEach((pointSpec, index) => {
              points.push({
                id: pointSpec.id,
                verticalId: verticalSpec.id,
                relativeDepth: pointSpec.relativeDepth,
                velocityMs: pointSpec.velocityMs,
                weight: pointWeight(count),
                durationS: pointSpec.durationS ?? 100,
                side: 'field',
                createdAt: stamp + index,
                updatedAt: stamp + index
              })
            })
          })
          if (verticals.length > 0) await db.verticals.bulkPut(verticals)
          if (points.length > 0) await db.points.bulkPut(points)
        }
      }
    }
  )

  // 第二阶段：按已落库垂线/测点重算外业流量快照，并由站上接收已采用测次为点据、发布三线 v1
  const [allSections, allVerticals, allPoints] = await Promise.all([
    db.sections.toArray(),
    db.verticals.toArray(),
    db.points.toArray()
  ])

  const pointsOfVertical = (verticalId: string): Point[] =>
    allPoints
      .filter((point) => point.verticalId === verticalId)
      .sort((a, b) => a.relativeDepth - b.relativeDepth)

  const acceptedRatingSpecs: Array<{ section: Section; flow: number }> = []

  await db.transaction(
    'rw',
    [db.sections, db.ratings, db.compares, db.ratingVersions],
    async () => {
      for (const section of allSections) {
        const verticals = allVerticals
          .filter((vertical) => vertical.sectionId === section.id)
          .sort((a, b) => a.startDistanceM - b.startDistanceM)
        const result = calcSectionDischarge(
          verticals.map((vertical) => ({
            id: vertical.id,
            no: vertical.no,
            startDistanceM: vertical.startDistanceM,
            depthM: vertical.depthM,
            meanVelocityMs: calcMeanVelocity(
              pointsOfVertical(vertical.id).map((point) => ({ velocityMs: point.velocityMs, weight: point.weight }))
            )
          }))
        )
        await db.sections.update(section.id, {
          fieldFlowM3s: result.flowM3s,
          fieldAreaM2: result.areaM2,
          fieldMeanVelocityMs: result.meanVelocityMs,
          updatedAt: Date.now()
        } as never)
        if (section.handoffStatus === 'accepted') {
          acceptedRatingSpecs.push({ section, flow: result.flowM3s })
        }
      }

      const ratings: Rating[] = [
        ...legacyRatingSpecs.map((spec) => ({
          ...spec,
          side: 'station' as const,
          sectionId: null,
          determinedMethod: null,
          publishedVersionId: null,
          createdAt: now,
          updatedAt: now
        })),
        ...acceptedRatingSpecs.map(({ section, flow }) => ({
          id: `rat_${section.id}`,
          stationId: section.stationId,
          stageM: section.stageM,
          flowM3s: round(flow, 1),
          lineNo: section.acceptedLineNo,
          measureNo: section.measureNo,
          measuredAt: section.measuredAt,
          side: 'station' as const,
          sectionId: section.id,
          determinedMethod: section.determinedMethod,
          publishedVersionId: null,
          createdAt: now,
          updatedAt: now
        }))
      ]
      await db.ratings.bulkPut(ratings)

      // 逐定线号发布 v1：站上拿全部点据重新拟合，冻结点据与比测
      const lineNos = Array.from(new Set(ratings.map((rating) => rating.lineNo))).sort()
      const versions: RatingVersion[] = []
      const compares: Compare[] = []
      for (const lineNo of lineNos) {
        const versionId = `ver_${lineNo.toLowerCase()}_1`
        const lineRatings = ratings.filter((rating) => rating.lineNo === lineNo)
        const assembled = assemblePublishedVersion({
          id: versionId,
          lineNo,
          versionNo: 1,
          ratings: lineRatings,
          sourceSectionIds: acceptedRatingSpecs
            .filter(({ section }) => section.acceptedLineNo === lineNo)
            .map(({ section }) => section.id),
          publishedBy: lineNo === 'C' ? '周渝' : '林昭',
          reviewNote: '播种：复核通过后发布的首版定线',
          deviationLimitPct: DEVIATION_LIMIT_PCT,
          publishedAt: iso,
          now
        })
        versions.push(assembled.version)
        compares.push(...assembled.compares)
        await db.ratings
          .where('lineNo')
          .equals(lineNo)
          .modify((rating: Rating) => {
            rating.publishedVersionId = versionId
          })
        await db.sections
          .where('acceptedLineNo')
          .equals(lineNo)
          .modify((section: Section) => {
            section.acceptedVersionId = versionId
          })
      }
      await db.ratingVersions.bulkPut(versions)
      await db.compares.bulkPut(compares)
    }
  )
}

/** 打开数据库并幂等播种：仅当测站表为空时灌入演示数据 */
export async function initDatabase(): Promise<void> {
  await db.open()
  const count = await db.stations.count()
  if (count === 0) {
    await seedDemoData()
  }
  stampDbVersion()
}

/** 清空全部业务表（导入覆盖与重置共用） */
export async function clearAllTables(): Promise<void> {
  await db.transaction(
    'rw',
    [db.stations, db.sections, db.verticals, db.points, db.ratings, db.compares, db.ratingVersions],
    async () => {
      await Promise.all([
        db.stations.clear(),
        db.sections.clear(),
        db.verticals.clear(),
        db.points.clear(),
        db.ratings.clear(),
        db.compares.clear(),
        db.ratingVersions.clear()
      ])
    }
  )
}

/** 清空并重新播种演示数据 */
export async function resetDatabase(): Promise<void> {
  await clearAllTables()
  await seedDemoData()
}

/** 统计各表行数，供页脚概览与导出页展示 */
export async function countAll(): Promise<Record<string, number>> {
  const [stations, sections, verticals, points, ratings, compares, ratingVersions] = await Promise.all([
    db.stations.count(),
    db.sections.count(),
    db.verticals.count(),
    db.points.count(),
    db.ratings.count(),
    db.compares.count(),
    db.ratingVersions.count()
  ])
  return { stations, sections, verticals, points, ratings, compares, ratingVersions }
}

/** 写入结构版本号到 localStorage，便于导出页比对 */
export function stampDbVersion(): void {
  try {
    localStorage.setItem(LS_KEYS.dbVersion, String(DB_VERSION))
  } catch {
    // 隐私模式下 localStorage 不可用，忽略即可
  }
}

export function readStampedDbVersion(): number {
  try {
    const raw = localStorage.getItem(LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DB_VERSION
  } catch {
    return DB_VERSION
  }
}

export function stampBackupTime(iso: string): void {
  try {
    localStorage.setItem(LS_KEYS.lastBackupAt, iso)
  } catch {
    // 忽略
  }
}

export function readLastBackupAt(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastBackupAt)
  } catch {
    return null
  }
}

export function readLastStationId(): string | null {
  try {
    return localStorage.getItem(LS_KEYS.lastStationId)
  } catch {
    return null
  }
}

export function writeLastStationId(id: string | null): void {
  try {
    if (id === null) localStorage.removeItem(LS_KEYS.lastStationId)
    else localStorage.setItem(LS_KEYS.lastStationId, id)
  } catch {
    // 忽略
  }
}

/** 计算某垂线的平均流速（页面与播种共用同一套算法） */
export function verticalMeanVelocity(points: Point[]): number {
  return calcMeanVelocity(points.map((point) => ({ velocityMs: point.velocityMs, weight: point.weight })))
}
