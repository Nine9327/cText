# cText

> 本地优先的 Windows 桌面小说阅读器：把散落在多个硬盘、移动硬盘里的 TXT / EPUB 收进一个统一书库，像管理音乐一样管理小说。

cText 不提供、不内置、不分发任何电子书或书源。它只读取**你自己机器上已有的文件**，把它们整理成一个能搜索、能分组、能记住读到哪里的书库。

<!-- 项目仍在开发中：v1.0 范围里 M0–M3 已完成，M4 网络书源尚未开始。 -->

## 它现在能做什么

**书库管理**

- 多个书库根目录（本地盘、移动硬盘、网络位置），启动时与窗口回到前台时检测掉线，恢复后自动回来
- 导入 TXT / EPUB：拖进窗口或选目录，先给预览（新增 / 重复 / 不支持 / 跳过），再决定导入
- 内容指纹去重：同一本书换个文件名再导入不会变成两条记录；同名不同内容会被区分
- 三种视图（网格 / 详情 / 列表），五种排序（最近阅读、导入时间、书名、作者、进度）
- 全文搜索：标题 / 作者 / 简介，FTS5 前缀匹配，中文可用

**阅读器**

- 分页与滚动两种模式，随时切换且**不丢位置**
- 五套主题（日间 / 夜间 / 护眼绿 / 纸张黄 / 跟随系统）+ 自定义前景与背景色
- 字号、行高、字距、段间距、页边距、字体全部可调，即时生效
- 目录抽屉（虚拟滚动，上千章也不卡）、章节间跳转、`?chapter=&offset=` 直达任意位置
- 阅读进度自动保存（含字符级偏移），关掉再打开接着读
- 书签、文本划线、笔记，可导出
- 快捷键可自定义（主键位 + 内置备选），冲突时拒绝写入

**组织**

- 收藏（一个开关）、我的书架（多对多分组，可拖拽排序、同一本书可进多个书架）、分类（题材标签，可多选筛选）
- 书籍详情页：元信息行内编辑、章节列表、书签汇总、文件来源
- 批量操作：多选后批量收藏 / 加书架 / 打标签 / 移出书库，**都带撤销**
- 重新识别：按磁盘文件重跑解析，覆盖元信息与目录，保留进度、收藏、书架、分类

**平台边界（刻意不做）**

- 仅 Windows 10 1809+ / Windows 11 x64
- 不做 MOBI / AZW3 / PDF
- 不做「追更」：不轮询章节更新、没有「有更新」角标，目录只能手动刷新

## 技术栈

| 层 | 选型 |
| --- | --- |
| 外壳 | Electron 32 |
| 主进程 / 渲染层 | TypeScript strict、Vue 3 `<script setup>`、Pinia、vue-router（hash） |
| 样式 | Tailwind CSS + Reka UI |
| 数据库 | SQLite（better-sqlite3，WAL），主进程是唯一写入方 |
| 本地解析 | Python 3.11 sidecar（TXT / EPUB 编码、目录、封面），不联网、不碰数据库 |
| 进程间 | IPC 五步契约 + zod 校验；TS ↔ Python 走 stdio NDJSON JSON-RPC |
| 构建 | electron-vite、electron-builder（NSIS / portable / zip） |

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 20+（推荐 22.x） | 工具链基线 |
| pnpm | 12.x | 锁定版本，勿混用 npm / yarn |
| VS Build Tools 2022 | 含「使用 C++ 的桌面开发」 | **硬依赖**：`better-sqlite3` 要按 Electron ABI 现场编译 |
| uv | 较新版本 | 用于把 Python 3.11 装进仓库内 `.python/` |
| Python | 3.11 | 由脚本管理，不使用系统 Python |

`better-sqlite3` 必须锁在 11.x：13.x 在编译期要求 N-API 10（Node ≥ 22.14），而 Electron 32 内置 Node 只有 N-API 9，加载即静默崩溃。

## 快速开始

```bash
pnpm install              # postinstall 会按 Electron ABI 重建 better-sqlite3
pnpm check:env            # Node 侧环境自检
pnpm check:env:electron   # Electron 运行时自检（验证原生模块能加载）

pnpm setup:python         # 建立仓库内 .python/ 与 .venv/（首次即可）
uv pip install -r python/ctext_worker/requirements.txt --python .venv/Scripts/python.exe

pnpm dev                  # 启动窗口；改前端 HMR，改主进程自动重启
```

只想调界面时可以 `pnpm dev:web`：只跑渲染层，用浏览器打开，秒开。

打包：

```bash
pnpm dist:dir   # 只出 release/win-unpacked/（调试打包问题，约 40s）
pnpm dist       # NSIS 安装包 + portable + zip（约 4 分钟）
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 开发主力 |
| `pnpm dev:web` | 只跑渲染层（浏览器调试 UI） |
| `pnpm build` / `pnpm start` | 构建到 `out/` / 以构建产物启动 |
| `pnpm typecheck` | 主进程 + 渲染层类型检查 |
| `pnpm build:worker` | 用 PyInstaller 打包 Python worker 到 `resources/python/` |
| `pnpm make:icons` | 重新生成应用图标 |
| `pnpm dist` / `pnpm dist:dir` | 出安装包 / 只出解包目录 |

## 测试

项目不用单元测试框架，而是**每个模块配一套端到端验收脚本**：真起 Electron、真建库、真导入文件、真点击界面，最后打印 `N/N 项通过`。

```bash
pnpm verify:shell      # 窗口外壳、单实例锁
pnpm verify:db         # 建库、迁移幂等、约束、FTS 触发器
pnpm verify:ipc        # 白名单、zod 校验、异常映射
pnpm verify:bridge     # Python 桥：帧解码、超时、崩溃自恢复
pnpm verify:epub       # EPUB：目录层级、封面、DRM/损坏识别
pnpm verify:import     # 导入队列：去重、覆盖、失败隔离、取消
pnpm verify:list       # 万本压测：列表 P95、虚拟 DOM 有界、帧间隔
pnpm verify:reader     # 分页 / 滚动 / 目录 / 进度 / 书签
pnpm verify:reader:big # 200MB 大文件不 OOM
pnpm verify:m2         # M2 出口：首屏预算、主题对比度、拔插硬盘无损
pnpm verify:m3         # M3 出口：三者语义不混淆、删除只删库记录
```

全部 29 套、956 条断言，一条命令串起来跑：

```bash
for s in import import:ui epub txt bridge roots scan dedupe db ipc log shell ui list search \
         favorite shelf category detail batch rematch m1 reader reader:big reader:ui \
         settings progress m2 m3; do pnpm verify:$s; done
```

实测数字（本机，Windows 11 / 单 SSD）：

| 场景 | 结果 | 预算 |
| --- | --- | --- |
| 20MB / 200 章 TXT 首屏 | 85 ms | 1500 ms |
| 1 万本书库列表查询 P95 | 5.7 ms | 200 ms |
| 列表滚动帧间隔（中位） | 6 ms | 16.7 ms |
| 500 本批量收藏 / 打标签 | 4 ms / 1 ms | 2 s |
| 200MB 单文件打开 | 不 OOM | — |

## 项目结构

```
src/
├─ main/               主进程
│  ├─ ipc/             通道注册（registry / 各业务域 handler）
│  ├─ db/              连接、PRAGMA、版本化迁移、repositories/
│  ├─ library/         根目录探测、扫描、指纹去重、导入队列、重定位、重新识别
│  ├─ reader/          TXT / EPUB 内容定位与分段读取
│  ├─ bridge/          Python worker 进程管理 + NDJSON 协议
│  ├─ log/ errors/     结构化日志、全局异常兜底
│  └─ milestone/       各里程碑出口验收
├─ preload/            contextBridge 白名单，渲染层唯一入口
├─ renderer/           Vue 3：views / components / stores / reader（分页与滚动引擎）
└─ shared/             跨进程 DTO、错误码、IPC 契约（contract / channels / schemas）
python/ctext_worker/   Python 侧车：只解析本地文件，不联网、不碰 DB
scripts/               环境自检、验收、打包脚本
resources/             图标与应用资源
```

### 加一个 IPC 通道

固定五步，漏一步编译期就报错（刻意的）：

1. `src/shared/dto.ts` — 入参 / 返回值类型
2. `src/shared/ipc/contract.ts` — 在 `IpcMap` 里加 `{ input, output }`
3. `src/shared/ipc/channels.ts` — 加进 `INVOKE_CHANNELS` 白名单
4. `src/shared/ipc/schemas.ts` — 加 zod schema
5. `src/main/ipc/<域>.ts` — `registerHandler(...)`；渲染层通过 `src/renderer/api/` 调用，不要直接碰 `window.api`

跨进程不抛异常：主进程返回 `IpcResult<T>`，渲染层统一解包抛 `ApiError`。

## 路线图

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 工程骨架：窗口、数据库、IPC、Python 桥、日志、打包 | ✅ |
| M1 | 本地书库：多根目录、扫描去重、TXT/EPUB 解析、导入、三视图、搜索 | ✅ |
| M2 | 阅读器：分页与滚动、目录、排版主题、进度、书签划线 | ✅ |
| M3 | 组织：收藏、书架、分类、详情页、批量与右键菜单、重新识别 | ✅ |
| M4 | 网络书源：「阅读 3.0」规则解析、搜索、详情、下载 | 🚧 |
| M5 | 打磨：设置中心、快捷键总览、封面缓存、可用性 | 待开始 |
| M6 | 定时抓取、自定义爬取脚本（QuickJS 沙箱 + 配额） | 待开始 |

## 已知问题

**终端里的 `ELECTRON_RUN_AS_NODE=1`** — 部分 IDE 终端会预设该变量，Electron 读到后变成纯 Node 跑 `main/index.js`，窗口不出现。`pnpm dev` / `pnpm start` 已在派生子进程前清除，用 `pnpm dev:raw` 时需自己 `unset`。

**Chromium 子进程沙箱在虚拟显示适配器下不可用** — 装了 MuMu / GameViewer 之类时，GPU 进程会反复崩溃。开发态关闭相关沙箱；**生产包默认带沙箱**，只在检测到异常启动时自动回退到安全模式（`src/main/platform/safe-mode.ts`），状态可从 `system:info` 读到。

**中文搜索只做前缀匹配** — 分词器为 `unicode61`，书名中间词搜不到是已知限制。

## 许可

**源码公开，禁止商用。** 本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)：

- ✅ 个人学习、研究、实验、私人娱乐、业余项目
- ✅ 慈善机构、教育机构、公共研究机构、政府机构使用
- ✅ 阅读、修改、分发（须保留同样的许可与声明）
- ❌ 任何商业用途，包括在公司业务中使用、销售、作为商业产品的一部分分发

> 严格来说这不是 OSI 定义上的「开源」（它限制了使用领域），GitHub 会将许可证标为 **Other**。这个词上的差别不影响你阅读和改动代码，只影响你能拿它做什么。

商用授权请联系仓库作者。

## 免责声明

- 本仓库**不包含、不提供、不推荐任何书源**，也不分发任何电子书内容。
- 软件只解析你本地已有的文件；解析结果与阅读内容由你自行负责。
- 请遵守你所在地区关于著作权与网络内容的法律法规，不要用它获取或传播侵权内容。
- 软件按「现状」提供，不附带任何担保。

## 贡献

Issue 与 PR 都欢迎。提交前请确认：

- `pnpm typecheck` 通过；
- 改动涉及的 `pnpm verify:*` 全部通过（新增功能请补一套验收脚本，参照 `scripts/verify-*.mjs` 与 `src/main/ui/*-smoke.ts`）；
- 提交信息用 `feat(模块):` / `fix(模块):` / `docs:` 前缀。

按本项目的许可证，贡献的代码同样以 PolyForm Noncommercial 1.0.0 授权。
