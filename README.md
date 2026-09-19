# 序流 Xuliu · 持续集成系统

面向研发团队的轻量 CI 系统：把「人肉串流程」变成可视化的流水线编排与一屏掌控的运行仪表盘。

- **流水线编排**：三端布局（流水线列表 / DAG 画布 / 阶段属性），画布支持**真实拖拽连线**建立依赖，不是下拉框选依赖
- **DAG 强校验**：阶段依赖支持并行分支、串行、失败中止；保存与触发时双重拦截环形依赖，并明确返回**那条环**（如 `构建 → 镜像 → 构建`），画布红色虚线高亮
- **阶段模型**：5 种类型（构建 / 单测 / 镜像 / 部署 / 人工卡点）、超时时间、3 种失败策略（失败中止 / 失败继续 / 失败重试）
- **人工卡点**：运行到卡点自动挂起，审批通过继续、驳回中止；仪表盘对等待超 N 小时的卡点亮红灯
- **仪表盘**：今日运行次数、成功率、平均时长、卡点超时红灯，加近 7 天运行次数与成功率图表
- **初始数据**：3 条流水线、24 条执行记录（含成功/失败/重试/取消/驳回/等待中的各种形态）

## 快速启动（Docker Compose，端口 8130）

```bash
docker compose up --build
```

启动后访问：

- 应用首页：http://localhost:8130
- 健康检查：http://localhost:8130/api/health

compose 包含两个服务：`db`（postgres:16-alpine，带健康检查）与 `app`（Node 22）。app 会等待数据库就绪、幂等写入初始数据后再启动。

> 想重置初始数据：`docker compose down -v`（删除数据卷）后重新 `up`。

### 不用 Docker 的本地运行

需要一个可连接的 PostgreSQL 13+：

```bash
createdb xuliu
export PGHOST=127.0.0.1 PGUSER=xuliu PGPASSWORD=xuliu123 PGDATABASE=xuliu
npm install
psql "$DATABASE_URL" -f db/init.sql    # 或让应用自动建表
node db/seed.js                        # 写入初始数据（幂等，表非空时跳过）
npm start
```

开发/无数据库环境下可用内存数据库在 8130 端口起一个带数据的演示服务：

```bash
npm install
node smoke-server.js
```

## 页面操作说明

### 流水线编排（三端）

| 区域 | 能做什么 |
|---|---|
| 左端 | 流水线列表：名称、阶段数、累计运行次数、最近状态；底部「＋ 新建」 |
| 中间 | DAG 画布：**按住节点拖动**移动位置；**从节点右侧圆点拖到另一节点左侧圆点**建立依赖连线；点击连线后按 `Delete` 或点中点 × 删除；「自动排版」按拓扑层级分列；「▶ 触发运行」；「保存编排」 |
| 右端 | 阶段属性：名称、类型、超时时间、失败策略、重试次数（仅重试策略）、卡点负责人（仅人工卡点）；底部删除阶段 |

- 连线在前端会即时做一次环检测；保存时后端在事务内再校验，**先拦截、不落任何脏数据**，并把环上的节点与边红色虚线高亮，顶部给出完整环路径。

### 仪表盘

- 4 个 KPI：今日运行次数、今日成功率（含进度条）、今日平均时长、卡点超时红灯数
- 右上可调整红灯阈值 N（小时），列表实时变化；等待超过 2N 小时的项标为更紧急的深红
- 两张近 7 天图：运行次数柱状图、成功率折线图（鼠标悬停有详情）
- 最近执行记录表：点任意一行打开执行详情，可对等待中的人工卡点**审批通过 / 驳回**，也可取消运行中的执行

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/pipelines` | 流水线列表（含阶段数、运行数、最近状态） |
| POST | `/api/pipelines` | 新建流水线 |
| PUT/DELETE | `/api/pipelines/:id` | 编辑 / 删除 |
| GET | `/api/pipelines/:id/graph` | 取整张图（阶段、边、拓扑分层） |
| **PUT** | `/api/pipelines/:id/graph` | **整图保存（事务内校验环，422 + cycle 返回那条环）** |
| POST | `/api/pipelines/:id/run` | 触发运行 |
| GET | `/api/runs` / `/api/runs/:id` | 执行列表 / 执行详情（含各阶段状态） |
| POST | `/api/runs/:id/cancel` | 取消运行 |
| POST | `/api/runs/:id/gate/:stageId` | 人工卡点审批 `{approved, reason, approver}` |
| GET | `/api/dashboard?gateHours=4` | 仪表盘汇总数据 |
| GET | `/api/health` | 健康检查 |

### 环拦截响应示例

```json
HTTP/1.1 422 Unprocessable Entity
{
  "error": "检测到环形依赖，请断开环路上的一条连线：构建 → 镜像 → 部署 → 构建",
  "code": "CYCLE_DETECTED",
  "cycle": [
    {"id": 3, "name": "构建"},
    {"id": 4, "name": "镜像"},
    {"id": 5, "name": "部署"},
    {"id": 3, "name": "构建"}
  ]
}
```

## 阶段语义

| 类型 | 说明 |
|---|---|
| 构建 build / 单测 unit_test / 镜像 image / 部署 deploy | 模拟执行，生成耗时并落库 |
| 人工卡点 manual_gate | 进入 `waiting_gate` 挂起，等待审批；通过继续、驳回中止 |

| 失败策略 | 行为 |
|---|---|
| abort 失败中止 | 该阶段失败后所有下游阶段跳过，整线失败 |
| continue 失败继续 | 不阻断下游，下游照常执行；整线仍记失败 |
| retry 失败重试 | 失败后按「重试次数」自动重试；耗尽仍失败按中止处理 |

## 工程结构

```
.
├── docker-compose.yml         # db + app，app 映射 8130
├── Dockerfile
├── db/
│   ├── init.sql               # 建表（pipeline/stage/edge/run/stage_run）
│   └── seed.js                # 3 条流水线 + 24 条执行记录（幂等）
├── src/
│   ├── server.js              # Express 入口
│   ├── routes.js              # API + 仪表盘聚合
│   ├── db.js                  # pg 连接池/建表/重试等待
│   ├── dag.js                 # 环检测（返回那条环）+ Kahn 拓扑分层
│   └── engine.js              # 可重入的模拟执行引擎/失败策略/卡点
├── public/                    # 原生前端（无构建步骤）
│   ├── index.html
│   ├── css/app.css
│   └── js/
│       ├── api.js             # fetch 封装/常量/格式化
│       ├── canvas.js          # 纯 SVG DAG 画布：拖拽移动、端口拉线、选边删除
│       ├── orchestration.js   # 三端编排视图 + 前端即时环检测
│       ├── dashboard.js       # KPI/红灯/SVG 图表/执行表
│       └── app.js             # 视图切换/执行详情弹层/卡点审批
└── tests/
    ├── run-tests.js           # 21 项单元+集成测试（pg-mem）
    └── smoke.js               # 对 8130 的 HTTP 端到端冒烟
```

## 测试

```bash
npm install
npm test                 # 21 项：DAG 算法 / 引擎语义 / HTTP 环拦截 / 种子完整性
node smoke-server.js &   # 另开终端
node tests/smoke.js      # 完整 HTTP 流程（触发→挂起→审批→成功/驳回/环拦截）
```

## 设计说明

- 执行引擎是**可重入的纯状态推进**：根据各阶段当前状态与依赖边决定下一步，因此人工卡点审批、进程重启后都能正确续跑；同一次运行的推进用 Promise 链串行化。
- 环检测采用 DFS 三色标记，发现回边时从 DFS 栈切出完整环节点序列；调度分层用 Kahn 算法，同层即无依赖、可并行。
- 仪表盘的今日边界与 7 天窗口在应用层计算后参数化查询，聚合在 JS 完成，避免数据库方言差异。
- 前端零构建、零框架依赖，画布为手写 SVG + 指针事件。
