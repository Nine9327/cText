# cText

本地优先、可接入网络书源的 Windows 桌面小说阅读器。把散落在多个硬盘 / 移动硬盘里的 TXT、EPUB 收进统一书库，像管理音乐一样管理小说，并支持导入「阅读 3.0」书源搜索网络小说。

> **当前状态**：M0 骨架阶段。窗口外壳、侧栏、数据库层、IPC 框架、Python 桥接已完成；列表数据仍来自 `src/renderer/mock/library.ts`，文件导入与阅读器未实现。

## 平台

- 仅 **Windows 10 1809+ / Windows 11 x64**（不做 Win7/8，不做 macOS / Linux）
- Electron 32 + TypeScript strict + Vue 3 + Vite

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 22.x | electron-vite 与工具链基线 |
| pnpm | 12.x | 锁定版本，勿混用 npm / yarn |
| VS Build Tools 2022 | 含 VCTools 工作负载 | **硬依赖**：pnpm 的依赖构建校验不允许跳过原生模块编译 |
| uv | 任意较新版本 | 仅 M0-05 起需要，用于管理仓库内 Python 3.11 |
| Python | 3.11 | 由 `pnpm setup:python` 装进仓库 `.python/`，不使用系统 Python |

## 首次准备

```bash
pnpm install        # postinstall 会自动按 Electron ABI 重建 better-sqlite3
pnpm check:env      # Node 侧环境自检（6 项）
pnpm check:env:electron   # Electron 运行时自检（4 项，验证原生模块能加载）
```

Python 环境（做 M0-05 之前执行即可）：

```bash
pnpm setup:python   # 建立 .python/ 解释器与 .venv/，均留在仓库内且有 gitignore
uv pip install -r python/ctext_worker/requirements.txt --python .venv/Scripts/python.exe
```

第二条命令装解析依赖（ebooklib / lxml / pdfminer.six / charset-normalizer / Pillow）。M0-05 的 worker 骨架只用标准库，但 `health.ping` 会报告这些依赖是否就位，缺了会在 `pnpm verify:bridge` 里显红。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发主力：启动 Electron 窗口，改前端有 HMR，改主进程自动重启 |
| `pnpm dev:web` | 只跑渲染层，用浏览器调试 UI（不启 Electron，秒开） |
| `pnpm build` | 构建到 `out/` |
| `pnpm start` | 以构建产物启动（不是开发模式，改代码不会热更） |
| `pnpm typecheck` | 主进程 + 渲染层类型检查 |
| `pnpm verify:shell` | M0-02 窗口外壳验收（构建 + 冒烟断言 + 单实例锁） |
| `pnpm verify:db` | M0-03 数据库验收（建库、迁移幂等、约束、FTS 触发器） |
| `pnpm verify:ipc` | M0-04 IPC 验收（白名单、zod 校验、未实现占位、异常映射） |
| `pnpm verify:bridge` | M0-05 Python 桥验收（帧解码、超时、杀进程自恢复、重启上限） |
| `pnpm check:env` / `pnpm check:env:electron` | 环境自检 |
| `pnpm rebuild:native` | 手动按 Electron ABI 重建原生模块 |
| `pnpm setup:python` | 建立仓库内 Python 3.11 与虚拟环境 |
| `pnpm dev:raw` | 绕过包装器直接跑 `electron-vite dev`（排障用） |

## 目录结构

```
src/
├─ main/               主进程
│  ├─ index.ts         app 生命周期、单实例锁、窗口创建
│  ├─ ipc/             通道注册（registry / system / window）+ 冒烟
│  ├─ db/              连接、PRAGMA、版本化迁移、DDL
│  ├─ bridge/          Python worker：进程管理、NDJSON 协议、定位启动命令
│  └─ utils/           作用域日志（M0-06 换成结构化日志）
├─ preload/            contextBridge 白名单，渲染层唯一入口
├─ renderer/           Vue 3 渲染层
│  └─ api/             IPC 调用的类型化封装（组件唯一出口）
└─ shared/             主进程与渲染层共享的类型与常量
   ├─ dto.ts           跨进程 DTO（字段含义的单一真相）
   ├─ errors.ts        错误码 + IpcResult 信封
   └─ ipc/             contract（契约）/ channels（白名单）/ schemas（zod）
python/ctext_worker/   Python 解析侧车（stdin/stdout NDJSON，只解析本地文件，不联网不碰 DB）
scripts/               环境自检、验收与本机环境适配脚本
docs/                  产品文档 / 开发计划 / MVP 范围
```

## 新增一个 IPC 通道

固定五步，漏一步编译期就报错（这是刻意的）：

1. `src/shared/dto.ts` — 定义入参 / 返回值类型
2. `src/shared/ipc/contract.ts` — 在 `IpcMap` 里加 `{ input, output }`
3. `src/shared/ipc/channels.ts` — 把通道名加进 `INVOKE_CHANNELS`（漏了会提示「漏掉了通道: xxx」）
4. `src/shared/ipc/schemas.ts` — 加 zod schema（缺了 `registerHandler` 编译不过）
5. `src/main/ipc/<域>.ts` — `registerHandler(...)`；渲染层走 `src/renderer/api/` 封装，不要直接 `window.api`


## Python worker

主进程用 `python/ctext_worker/main.py` 拉起一个常驻侧车进程，stdin/stdout 走 NDJSON：

```jsonc
{"id":"r-1","method":"health.ping","params":{}}      // 请求
{"id":"r-1","ok":true,"result":{"pid":1234}}         // 响应
{"event":"worker.ready","data":{"version":"0.1.0"}}  // 事件（无 id）
```

- **stdout 只允许协议帧**。任何 `print` 都会变成坏帧（桥接层会跳过并记 warn）；诊断输出走 stderr，主进程按行转发到日志。
- 崩溃自动重启，5 分钟内最多 3 次，超过进 `failed` 并拒绝后续请求（`retry()` 可手动恢复）。
- 主进程被强杀时管道关闭，worker 读到 stdin EOF 自行退出，不留孤儿进程。
- worker 内部是 4 线程池，响应顺序不保证，靠 `id` 匹配。
- **新增方法**：在 `python/ctext_worker/methods/` 下写 `@method("parse.txt.outline")` 函数，再到 `main.py` 里 `import` 该模块即可。

健康状态可从渲染层读：`window.api.invoke('system:worker-health')`（永抛不错，未就绪时 `worker` 为 `null`）。

## 已知环境问题

这几条是本机实测踩出来的，改动前先读，避免重复排障。

**1. 终端里的 `ELECTRON_RUN_AS_NODE=1`**
WorkBuddy / VS Code 等 IDE 的终端会预设该变量，Electron 读到后退化成纯 Node 运行 `main/index.js`，窗口不出现且报 `Cannot find module`。
→ `pnpm dev` / `pnpm start` 已由 `scripts/dev.mjs` 在派生子进程前清除。用 `pnpm dev:raw` 时需自己 `unset`。

**2. Chromium 子进程沙箱在本机不可用**
本机存在 MuMu / GameViewer 等虚拟显示适配器时：GPU 进程反复 `0xC0000005` 崩溃并 FATAL 拖死主进程；Network service 起不来导致页面永远空白。
→ 开发态在 `src/main/index.ts` 关闭 `disable-gpu-sandbox` 与 `no-sandbox`。**生产包的沙箱策略需在 M0-07 重新决策**。极端情况可用 `CTEXT_DISABLE_GPU=1` 强制软件渲染。

**3. better-sqlite3 必须锁在 11.x**
13.x 编译期写死 `NAPI_VERSION=10`（需 Node ≥22.14），而 Electron 32 内置 Node 20.18 只有 N-API 9，加载即静默崩溃。升级到 Electron 35+ 后才可再评估。
重装依赖时 `postinstall` 会用 `electron-rebuild --build-from-source` 按 ABI 128 重建；headers 只有 `https://artifacts.electronjs.org/headers/dist` 可用（npmmirror 无 headers，GitHub 被代理挡）。

## 文档

- [`docs/产品文档.md`](docs/产品文档.md) — 需求、数据表设计、架构决策
- [`docs/开发计划.md`](docs/开发计划.md) — 54 个任务、里程碑与实施记录
- [`docs/MVP范围.md`](docs/MVP范围.md) — MVP 裁剪口径

## 约定

- 产品名固定 **cText**。
- 不做追更：不轮询章节更新、不做「有更新」角标，目录只能手动刷新。
- 三者语义不可混：收藏（`books.favorite` 布尔）/ 我的书架（多对多分组）/ 分类（题材标签）。
- 任何自动流程不得删除用户文件；删除类操作必须二次确认且只删库记录。
- 书籍只存 `root_id + rel_path`，绝不写绝对路径。
