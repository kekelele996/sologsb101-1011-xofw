# sologsb101-1011 水文站流量测验与绳套曲线台

面向水文站测验与资料整编人员的纯前端单页应用：**外业测验**与**站上整编**两侧分开——外业管测深、流速与断面流量，站上管测法认定与定线发布。外业测次交回后，站上拿该定线全部点据重新拟合，复核通过才发布新一版定线；退回则外业留在原处重试，已发布版本照旧可查。数据全部保存在浏览器本地（IndexedDB），不依赖任何后端服务或外部接口。

## 〇、两侧职责与交回流程（v3）

| 侧别 | 拥有数据 | 能做的事 |
| --- | --- | --- |
| 外业 `field` | 测次采集字段、垂线测深、流速测点、外业断面流量快照 | 布设垂线、录测深/流速、权重归一；编辑中或退回的测次可「交回」 |
| 站上 `station` | 测法认定、关系点据、比测、定线版本 | 测法认定、并入预览、复核通过发布新版 / 退回外业、查版本历史 |

- **互不覆盖**：两侧对同一测次各写字段白名单（外业写水位/现场测法/起点距/时间，站上写认定测法/采用信息），一侧即使带上另一侧字段也会被剔除。**两边动过同一测次时，流量按外业算（交回瞬间按部分面积法固化），测法认定听站上**。
- **交回状态机**：`外业编辑中 draft → 已交回待复核 submitted → 站上已采用 accepted`；复核不过则 `submitted → 退回重试 returned`（外业留在原处改完重新交回，已发布那版照旧可查）；已采用测次外业可「申请修订」回到 draft，修订交回后复核发布新版。
- **定线版本**：新增 `ratingVersions` 表，复核通过时取该线**全部点据**重新拟合并冻结参数/点据/比测，版本号递增，旧版置为历史版（`superseded`）永久可查。外业改测点不会即时影响已发布定线。
- **旧库升级（v2 → v3）**：按两侧补 `side`（测站/点据/比测 → station，测次/垂线/测点 → field）；旧测次视为已交回采用、按当时垂线测点重算外业流量快照；既有每条定线号补发首版 v1 并冻结比测。

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动完成后访问：**http://localhost:22811**

常用命令：

```bash
docker compose ps                 # 查看容器状态
docker compose logs -f frontend   # 查看 nginx 访问日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 修改代码后重新构建
```

> 宿主端口由 `.env` 中的 `FRONTEND_PORT` 控制（默认 22811），如需换端口改这一个变量即可。
> 容器为纯静态 nginx，无数据库服务、不挂载任何命名卷，可随时删除重建。

## 二、技术栈

| 层次 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3.5（Composition API + `<script setup>`） | 页面全部按路由懒加载 |
| 语言 | TypeScript 5.7（strict） | 构建脚本执行 `vue-tsc --noEmit` 类型检查 |
| UI 组件 | Element Plus 2.9 + @element-plus/icons-vue | 中文语言包，表格 / 表单 / 弹窗 / 徽标 |
| 构建 | Vite 6 | 产物 `dist/`，交给 nginx 托管 |
| 状态管理 | Pinia 2（setup store） | `stationStore` / `sectionStore` / `ratingStore` / `workSideStore`（当前侧别） |
| 路由 | Vue Router 4（history 模式） | 路径稳定，外业 / 站上按侧别分流，支持深链刷新 |
| 持久化 | Dexie 4（IndexedDB，库名 `gbhydrogaug`） | 结构版本 v3 + v1→v3 升级迁移 + 交回状态机 + 定线版本表 + liveQuery 订阅 |
| 容器 | node:20-alpine 构建 → nginx:alpine 运行 | 多阶段构建，运行阶段 `chmod -R a+rX` |

## 三、路由与功能模块

| 路由 | 页面 | 侧别 | 主要交互 |
| --- | --- | --- | --- |
| `/stations` | 测站台账 | 共用（站上维护） | 新建/编辑/删除测站，按河名与集水面积分档筛选，卡片回显测次数、最新水位与比测合格率 |
| `/stations/:id/sections` | 断面测次列表（外业） | 外业 | 新增测次（测次号、起点距、水位、现场测法、拟并定线）、交回/重新交回、申请修订；状态与外业流量快照回显 |
| `/sections/:id/verticals` | 垂线布设与测深 | 外业 | 起点距排序校验、按测点数生成测点行、部分面积法流量；已交回测次外业只读 |
| `/verticals/:id/points` | 流速测点录入 | 外业 | 逐点录流速、批量粘贴、批量改写、权重归一；改动实时回刷外业流量快照，交回后冻结 |
| `/review` | 交回复核与测法认定 | 站上 | 待复核队列、测法认定、并入全线拟合预览、复核通过发布新版 / 退回外业重试、批量通过 |
| `/ratings` | 定线发布与版本 | 站上 | 当前发布版曲线与残差、版本历史抽屉（各版参数/点据快照可查）、补录无测次的历史遗留点 |
| `/export` | 比测偏差分析与导出 | 站上 | 按测站出检测结论（取当前发布版参数）、七表全量 JSON 导入导出、清空重建演示数据 |

带 `:id` 的层级路由在直接深链访问时同样可用：若 IndexedDB 中查不到该 id，页面渲染 `<RouteMissingPanel>` 友好空态（含返回入口与可用 id 快捷跳转），不会白屏。

## 四、目录结构

```
sologsb101-1011/
├── README.md
├── docker-compose.yml          # name: gbhydrogaug，不写 version
├── Dockerfile                  # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
├── nginx.conf                  # try_files $uri $uri/ /index.html; + gzip
├── .env / .env.example         # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 前端独立构建用（同样多阶段 + chmod -R a+rX）
    ├── nginx.conf              # 前端独立托管用
    ├── .dockerignore
    ├── package.json            # build = vue-tsc --noEmit && vite build
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 挂载 Pinia / Router / Element Plus，并打开并播种数据库
        ├── App.vue             # 顶部导航 + 上下文快捷入口 + 页脚数据概览
        ├── env.d.ts
        ├── types/              # station / section / vertical / point / rating / ratingVersion / compare / side / handoff / filter
        ├── stores/             # stationStore / sectionStore / ratingStore / workSideStore
        ├── components/common/  # DeviationTag / FilterBar / StatBadge / EmptyPanel / RouteMissingPanel
        ├── hooks/              # useIdbTable / useRatingFit
        ├── pages/              # StationList / SectionList / VerticalBoard / PointEntry / ReviewDesk / RatingChart / ExportView
        ├── router/index.ts     # 路由表（/review 为站上复核台）
        ├── styles/main.css
        └── utils/              # flow.ts（外业流量）/ handoff.ts（交回状态机+发布编排）/ ratingPublish.ts（版本冻结组装）/ db.ts / export.ts
```

## 五、本地开发

```bash
cd frontend
npm install
npm run dev        # http://localhost:22811
npm run build      # 类型检查 + 生产构建
npm run preview    # 预览构建产物
```

## 六、数据存储说明

- **存储位置**：浏览器 IndexedDB，库名 `gbhydrogaug`，当前结构版本 `v3`。页面侧由 `frontend/src/utils/db.ts` 统一封装，页面组件不直接触碰 Dexie 实例。
- **数据表（7 张）**：`stations`（测站）、`sections`（断面测次，含交回状态机与两侧字段）、`verticals`（垂线）、`points`（流速测点）、`ratings`（关系点据）、`compares`（比测记录）、`ratingVersions`（定线版本快照）。
- **两侧分写**：所有业务记录带 `side`（`field` 外业 / `station` 站上）；`utils/handoff.ts` 用字段白名单（`FIELD_SECTION_KEYS` / `STATION_SECTION_KEYS`）保证两侧互不覆盖，交回状态迁移经 `assertTransition` 校验。
- **升级迁移**：`v1 → v2` 补齐索引与默认字段；`v2 → v3` 按两侧补 `side`、测次补交回状态与外业流量快照、为既有定线补发首版 `ratingVersions` 并按版本参数重建比测；调整字段结构时递增 `DB_VERSION` 并在 `upgrade` 中补迁移。
- **首屏播种**：`initDatabase()` 在 `stations` 表为空时执行幂等播种（3 测站 / 7 测次，覆盖 编辑中·待复核·退回·已采用 四态 / 10 垂线 / 28 测点 / 12 点据 / A·B·C 三线 v1，C 线含超限点据），其中已采用测次的点据流量直接取自外业部分面积法实算成果。
- **实时同步**：`utils/db.ts` 的 `watchTable()` 基于 Dexie `liveQuery` 订阅表变化，store 里的列表自动刷新。
- **备份与恢复**：`/export` 页导出包含七张表（含定线版本快照）的 JSON，支持「覆盖导入」与「追加导入（重新分配 id 并重映射版本引用）」；备份时间写入 `localStorage`。
- **离线可用**：应用为纯静态资源，无任何网络请求；换浏览器 / 清空站点数据后数据不会跟随，需通过 JSON 备份迁移。
