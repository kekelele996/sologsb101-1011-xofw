<script setup lang="ts">
/**
 * 应用外壳：顶部导航（外业测验 / 站上整编两侧分流 + 数据概览）、主内容区与页脚。
 * 导航项在层级路由下回落到父级列表，保证任意深链页面都能一键跳走。
 */
import { computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  CircleCheck,
  Histogram,
  Odometer,
  PieChart,
  Promotion,
  TrendCharts
} from '@element-plus/icons-vue'
import { useStationStore } from '@/stores/stationStore'
import { useSectionStore } from '@/stores/sectionStore'
import { useRatingStore } from '@/stores/ratingStore'
import { useWorkSideStore } from '@/stores/workSideStore'
import { SIDE_FULL_LABEL } from '@/types/side'
import { DB_NAME, DB_VERSION } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const stationStore = useStationStore()
const sectionStore = useSectionStore()
const ratingStore = useRatingStore()
const workSide = useWorkSideStore()

onMounted(() => {
  stationStore.start()
  sectionStore.start()
  ratingStore.start()
})

/** 层级路由统一归属到最上层导航项 */
const activeKey = computed(() => {
  if (route.path.startsWith('/stations/')) return '/stations'
  if (route.path.startsWith('/sections/')) return '/sections'
  if (route.path.startsWith('/verticals/')) return '/sections'
  if (route.path.startsWith('/review')) return '/review'
  return route.path
})

const navItems = computed(() => {
  if (workSide.side === 'field') {
    return [
      { key: '/stations', label: '测站与测次', icon: Odometer, badge: String(stationStore.stations.length) },
      {
        key: '/sections',
        label: '外业测验（测深/流速/流量）',
        icon: Histogram,
        badge: String(sectionStore.fieldOwnedSections.length)
      }
    ]
  }
  return [
    { key: '/review', label: '交回复核与测法认定', icon: CircleCheck, badge: String(sectionStore.pendingReviewSections.length) },
    { key: '/ratings', label: '定线发布与版本', icon: TrendCharts, badge: String(ratingStore.versions.length) },
    { key: '/export', label: '比测与导出', icon: PieChart, badge: String(ratingStore.overLimitRows.length) }
  ]
})

/** 外业测验默认落到当前测站的测次列表，否则去测站台账 */
function resolveFieldEntry(path: string): string {
  if (path === '/sections') {
    const stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id
    return stationId ? `/stations/${stationId}/sections` : '/stations'
  }
  return path
}

function go(path: string): void {
  void router.push(resolveFieldEntry(path))
}

function switchSide(side: 'field' | 'station'): void {
  workSide.setSide(side)
  if (side === 'field') {
    void router.push(resolveFieldEntry('/sections'))
  } else {
    void router.push('/review')
  }
}

/** 当前上下文的快捷入口：选中测站 → 断面，选中断面 → 垂线，选中垂线 → 测点 */
const contextLinks = computed(() => {
  const links: Array<{ label: string; path: string }> = []
  const stationId = route.params.id as string | undefined
  if (route.path.startsWith('/stations/') && stationId) {
    links.push({ label: '该站断面测次', path: `/stations/${stationId}/sections` })
  }
  if (route.path.startsWith('/sections/') && stationId) {
    const section = sectionStore.sectionById(stationId)
    if (section) links.push({ label: '所属测站断面', path: `/stations/${section.stationId}/sections` })
    links.push({ label: '该断面垂线', path: `/sections/${stationId}/verticals` })
  }
  if (route.path.startsWith('/verticals/') && stationId) {
    const vertical = sectionStore.verticals.find((item) => item.id === stationId)
    if (vertical) links.push({ label: '所属断面垂线', path: `/sections/${vertical.sectionId}/verticals` })
  }
  if (route.path.startsWith('/ratings')) links.push({ label: '交回复核', path: '/review' })
  if (route.path.startsWith('/review')) links.push({ label: '定线发布与版本', path: '/ratings' })
  return links
})
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <div class="app-header__brand">
        <span class="app-header__mark">水</span>
        <div>
          <h1 class="app-header__title">水文站流量测验与绳套曲线台</h1>
          <p class="app-header__sub">
            外业管测深·流速·流量 ｜ 站上管测法认定·定线发布 ｜ 交回复核后发布新版，已发布版本可查
          </p>
        </div>
      </div>
      <div class="app-header__right">
        <div class="app-side-switch" role="tablist" :aria-label="'职责侧别切换'">
          <button
            type="button"
            class="app-side-switch__item"
            :class="{ 'is-active': workSide.side === 'field' }"
            @click="switchSide('field')"
          >
            <el-icon><Histogram /></el-icon> 外业测验
          </button>
          <button
            type="button"
            class="app-side-switch__item"
            :class="{ 'is-active': workSide.side === 'station' }"
            @click="switchSide('station')"
          >
            <el-icon><Promotion /></el-icon> 站上整编
          </button>
        </div>
        <nav class="app-nav">
          <button
            v-for="item in navItems"
            :key="item.key"
            class="app-nav__item"
            :class="{ 'is-active': activeKey === item.key }"
            type="button"
            @click="go(item.key)"
          >
            <el-icon><component :is="item.icon" /></el-icon>
            <span>{{ item.label }}</span>
            <em v-if="item.badge" class="app-nav__badge">{{ item.badge }}</em>
          </button>
        </nav>
      </div>
    </header>

    <div class="app-context-row">
      <div v-if="contextLinks.length > 0" class="app-context">
        <span class="app-context__label">当前上下文：</span>
        <el-button
          v-for="link in contextLinks"
          :key="link.path"
          size="small"
          text
          type="primary"
          @click="go(link.path)"
        >
          {{ link.label }}
        </el-button>
      </div>
      <el-tag size="small" :type="workSide.side === 'field' ? 'warning' : 'success'" effect="dark" round>
        当前工作台：{{ SIDE_FULL_LABEL[workSide.side] }}
      </el-tag>
    </div>

    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>

    <footer class="app-footer">
      <span>
        本地库 {{ DB_NAME }} · 结构版本 v{{ DB_VERSION }} · 数据仅存于本浏览器 IndexedDB，不上传任何服务器。
      </span>
      <span>
        测站 {{ stationStore.stations.length }} · 测次 {{ sectionStore.sections.length }} · 垂线
        {{ sectionStore.verticals.length }} · 测点 {{ sectionStore.points.length }} · 点据
        {{ ratingStore.ratings.length }} · 定线版本 {{ ratingStore.versions.length }}
      </span>
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.app-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px;
  background: linear-gradient(120deg, #0b3c5d 0%, #0f4c75 55%, #116d8c 100%);
  color: #eaf6fb;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: 12px;
}

.app-header__mark {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.14);
  border: 1px solid rgba(255, 255, 255, 0.3);
  font-size: 20px;
  font-weight: 700;
}

.app-header__title {
  margin: 0;
  font-size: 18px;
  letter-spacing: 1px;
}

.app-header__sub {
  margin: 2px 0 0;
  font-size: 12px;
  letter-spacing: 1px;
  color: rgba(234, 246, 251, 0.75);
}

.app-header__right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}

.app-side-switch {
  display: inline-flex;
  padding: 3px;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.app-side-switch__item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 14px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: #dcecf4;
  font-size: 12.5px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-side-switch__item.is-active {
  background: #eaf6fb;
  color: #0f4c75;
  font-weight: 700;
}

.app-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.app-nav__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border: 1px solid rgba(255, 255, 255, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  color: #eaf6fb;
  font-size: 13px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.app-nav__item:hover {
  background: rgba(255, 255, 255, 0.16);
}

.app-nav__item.is-active {
  background: #eaf6fb;
  color: #0f4c75;
  font-weight: 600;
}

.app-nav__badge {
  font-style: normal;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}

.app-context-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 24px 0;
}

.app-context {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.app-context__label {
  font-size: 12px;
  color: #5b6b78;
}

.app-main {
  flex: 1;
  width: 100%;
  max-width: 1360px;
  margin: 0 auto;
  padding: 16px 24px 32px;
}

.app-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 24px 20px;
  font-size: 12px;
  color: #6b7d8b;
}
</style>
