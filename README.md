# cText

本地优先、可接入网络书源的 Windows 桌面小说阅读器。把散落在多个硬盘 / 移动硬盘里的 TXT、EPUB 收进统一书库，像管理音乐一样管理小说，并支持导入「阅读 3.0」书源搜索网络小说。

> **当前状态**：M0 骨架阶段。窗口外壳与侧栏已完成，列表数据来自 `src/renderer/mock/library.ts`，数据库、文件导入、阅读器均未实现。

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
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发主力：启动 Electron 窗口，改前端有 HMR，改主进程自动重启 |
| `pnpm dev:web` | 只跑渲染层，用浏览器调试 UI（不启 Electron，秒开） |
| `pnpm build` | 构建到 `out/` |
| `pnpm start` | 以构建产物启动（不是开发模式，改代码不会热更） |
| `pnpm typecheck` | 主进程 + 渲染层类型检查 |
| `pnpm verify:shell` | M0-02 窗口外壳验收（构建 + 冒烟断言 + 单实例锁） |
| `pnpm check:env` / `pnpm check:env:electron` | 环境自检 |
| `pnpm rebuild:native` | 手动按 Electron ABI 重建原生模块 |
| `pnpm setup:python` | 建立仓库内 Python 3.11 与虚拟环境 |
| `pnpm dev:raw` | 绕过包装器直接跑 `electron-vite dev`（排障用） |

## 目录结构

```
src/
├─ main/        主进程：窗口外壳、IPC、（后续）DB 与解析调度
├─ preload/     contextBridge 白名单，渲染层唯一入口
├─ renderer/    Vue 3 渲染层（views / components / router / mock）
└─ shared/      主进程与渲染层共享的类型与常量
scripts/        环境自检、验收与本机环境适配脚本
docs/           产品文档 / 开发计划 / MVP 范围
```

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
