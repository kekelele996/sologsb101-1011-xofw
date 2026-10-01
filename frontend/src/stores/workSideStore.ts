/**
 * 工作台侧别（外业测验 / 站上整编）：全局当前侧，导航与页面据此分流。
 * 仅表示当前操作视角，不改变数据归属——真正的互斥边界由 utils/handoff.ts 白名单保证。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WorkSide } from '@/types/side'

const LS_KEY = 'gbhydrogaug:work-side'

function readInitialSide(): WorkSide {
  try {
    return localStorage.getItem(LS_KEY) === 'station' ? 'station' : 'field'
  } catch {
    return 'field'
  }
}

export const useWorkSideStore = defineStore('workSide', () => {
  const side = ref<WorkSide>(readInitialSide())

  function setSide(next: WorkSide): void {
    side.value = next
    try {
      localStorage.setItem(LS_KEY, next)
    } catch {
      // 隐私模式忽略
    }
  }

  function toggle(): void {
    setSide(side.value === 'field' ? 'station' : 'field')
  }

  return { side, setSide, toggle }
})
