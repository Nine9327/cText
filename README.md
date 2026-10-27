# cText

本地优先、可接入网络书源的 Windows 桌面小说阅读器。把散落在多个硬盘 / 移动硬盘里的 TXT、EPUB 收进统一书库，像管理音乐一样管理小说，并支持导入「阅读 3.0」书源搜索网络小说。

> **当前状态**：M0 骨架**已收口**（M0-00 ~ M0-08 全部完成）。窗口外壳、侧栏五入口、数据库层、IPC 框架、Python 桥接、日志/错误处理、打包流水线均已落地，安装包可装可用；列表与侧栏数据仍来自 `src/renderer/mock/library.ts`，文件导入与阅读器未实现（M1 / M2）。

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
| `pnpm verify:log` | M0-06 日志验收（落盘、脱敏、级别、耗时、错误码映射、全局兜底 + toast） |
| `pnpm verify:ui` | M0-08 侧栏验收（五入口切换、选中态唯一、书库过滤与离线态、两级折叠、空页面） |
| `pnpm verify:package` | M0-07 打包验收（构建 → 解包目录 → 真跑一次自检）；加 `--installer` 连安装/卸载一起验 |
| `pnpm build:worker` | 用 PyInstaller 把 Python worker 打成 `resources/python/ctext-worker/` |
| `pnpm check:env` / `pnpm check:env:electron` | 环境自检 |
| `pnpm rebuild:native` | 手动按 Electron ABI 重建原生模块 |
| `pnpm setup:python` | 建立仓库内 Python 3.11 与虚拟环境 |
| `pnpm dist:dir` | 只出 `release/win-unpacked/`（调试打包问题用，约 40s） |
| `pnpm dist` | 出完整产物：NSIS 安装包 + portable + zip（约 4 分钟） |
| `pnpm make:icons` | 重新生成 `resources/icons/icon.ico`（改配色/字形时用） |
| `pnpm dev:raw` | 绕过包装器直接跑 `electron-vite dev`（排障用） |

## 目录结构

```
src/
├─ main/               主进程
│  ├─ index.ts         app 生命周期、单实例锁、窗口创建、日志/兜底初始化
│  ├─ ipc/             通道注册（registry / system / window / log）+ 冒烟
│  ├─ db/              连接、PRAGMA、版本化迁移、DDL
│  ├─ bridge/          Python worker：进程管理、NDJSON 协议、定位启动命令
│  ├─ log/             结构化日志：JSON Lines 落盘、按天滚动、级别过滤、计时
│  ├─ errors/          全局异常兜底（uncaughtException / 渲染进程退出 / preload 失败…）
│  └─ utils/           脱敏（redact）、错误码映射（to-app-error）、toast 推送（notify）
├─ preload/            contextBridge 白名单，渲染层唯一入口
├─ renderer/           Vue 3 渲染层
│  ├─ api/             IPC 调用的类型化封装（组件唯一出口）
│  ├─ views/           页面：LibraryView（书库/收藏/书架共用）/ ShelvesView / SourcesView
│  ├─ stores/          Pinia：library（根目录过滤与各入口集合）/ ui（折叠偏好）
│  ├─ lib/             toast 状态、渲染层异常上报（log:renderer）
│  └─ components/      layout（TitleBar / Sidebar / LibrarySwitcher / SidebarSection）/ book / common
└─ shared/             主进程与渲染层共享的类型与常量
   ├─ dto.ts           跨进程 DTO（字段含义的单一真相）
   ├─ errors.ts        错误码 + 默认文案 + IpcResult 信封
   └─ ipc/             contract（契约）/ channels（白名单）/ schemas（zod）
python/ctext_worker/   Python 解析侧车（stdin/stdout NDJSON，只解析本地文件，不联网不碰 DB）
resources/
├─ icons/              应用图标（icon.ico 由 scripts/make-icons.py 生成）
└─ python/             PyInstaller 产物（gitignore，pnpm build:worker 生成）
release/               electron-builder 产物（gitignore）
scripts/               环境自检、验收、打包封装与本机环境适配脚本
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

## 界面骨架（M0-08）

侧栏五个入口，全部可在折叠态以图标形式使用：

| 入口 | 路由 | 说明 |
| --- | --- | --- |
| 书库切换器 | —（不跳转） | 下拉选根目录：全部书库 / 本地书库 `D://books` / 移动硬盘 `F://novels`（离线）。切换后侧栏计数、列表、收藏同时收敛 |
| 全部书籍 | `/library` | 受当前根目录过滤；根目录离线时顶部出现离线横幅，书籍保留只变灰 |
| 收藏的书籍 | `/favorites` | `books.favorite` 布尔，不是分组 |
| 我的书架 | `/shelves` → `/shelves/:shelfId` | 多对多分组；分区标题可点，右侧箭头折叠 |
| 网络小说 | `/sources` → `/sources/:sourceId` | 书源列表；页面明示「不内置、不分发任何书源」 |

几条约定：

- **选中态唯一**：三类样式 `.ct-nav-item-active`（展开）/ `.ct-rail-item-active`（折叠）/ `.ct-section-active`（分区首页标题），任何路由下有且只有一个。`pnpm verify:ui` 会逐个入口断言。
- **侧栏 240px ↔ 64px**：折叠按钮在底部（展开态是左侧箭头，折叠态在最下方）。折叠态不隐藏入口，只是变成图标 + `title` 提示。
- **折叠偏好存 localStorage**（`ctext.ui.v1`），不写库：它不是业务数据，写库要走 IPC 往返。
- **当前根目录不持久化**：每次启动都是「全部书库」。避免"上次选了移动硬盘，这次拔盘开机看到空列表"。
- **所有数据仍是 mock**（`src/renderer/mock/library.ts`，16 本书 / 3 个根目录 / 2 个书架 / 3 个书源）。M1-01 起换成 `roots:*` 与 `library:list`，侧栏组件不用动。
- **未实现动作给 toast**，不假装成功：新建书架 → M3-02、导入书籍 → M1-06、导入书源 → M4-07、重新指定目录 → M1-01。

## 日志与错误处理（M0-06）

**日志落在** `%APPDATA%\ctext\logs\ctext-YYYY-MM-DD.log`（即 `userData/logs`，`system:info` 的 `logDir` 字段也能取到）。按天滚动，保留 7 天，单文件 16MB 上限。

**格式**：JSON Lines，一行一条。固定字段 `ts / level / scope / msg / pid / seq / session`，其余统一进 `fields`：

```jsonc
{"ts":"2026-10-27T10:29:46.939Z","level":"error","scope":"worker","msg":"worker 不可用","pid":12456,"seq":28,"session":"85d2cbb3","fields":{"reason":"…","restarts":3}}
```

**级别**：`CTEXT_LOG_LEVEL=debug|info|warn|error`，默认 `info`。`debug` 含每条 IPC 的耗时，排障时才开。

**脱敏在写入点做**，不是导出时才做：`C:\Users\<用户名>` → `C:\Users\~`、`/home|/Users/<用户名>` 同理、`Bearer xxx` 与 `?token=/key=/secret=/password=` → `***`。控制台回声与文件内容同步脱敏，所以贴日志到 issue 不会泄漏用户名。

**写文件是同步的**（`fs.writeSync`）。这样 `app.exit()` 与未捕获异常两条路径都不会丢掉最后几行——而这恰恰是最需要的那几行。

**错误与提示**：
- 7 个错误码（`E_INVALID_ARGUMENT` / `E_NOT_FOUND` / `E_NOT_IMPLEMENTED` / `E_CONFLICT` / `E_IO` / `E_TIMEOUT` / `E_INTERNAL`），底层 errno / `SQLITE_*` / zod 由 `src/main/utils/to-app-error.ts` 统一映射，文案单一来源在 `shared/errors.ts` 的 `ERROR_MESSAGES`。
- 未捕获异常（主进程或渲染层）都会落日志 + 弹右下角 toast；渲染层的异常经 `log:renderer` 通道转发到**同一个**日志文件。
- 主进程不会因为单个 `uncaughtException` 退出；但 10 秒内超过 5 次会判定状态不可信并主动退出。

## 打包与分发（M0-07）

`pnpm dist` 产出在 `release/`：

| 文件 | 说明 | 体积 |
| --- | --- | --- |
| `cText-<ver>-setup.exe` | NSIS 安装包，per-user 安装（不需要管理员权限），可选安装目录 | 109 MB |
| `cText-<ver>-portable.exe` | 单文件免安装（自解压到临时目录运行） | 96 MB |
| `cText-<ver>-x64.zip` | 解压即用，送测/救急 | 139 MB |

几条固定约定：

- **Python 产物必须在 asar 外面**。asar 里的 `.exe` 无法执行，所以 PyInstaller 的 `--onedir` 产物走 `extraResources` 落到 `resources/python/ctext-worker/`，运行时按 `process.resourcesPath` 拼接（`src/main/bridge/launch.ts`）。
- **userData 固定在 `%APPDATA%\ctext`**：来自 `package.json` 的 `name`，不是 `electron-builder.yml` 的 `productName`。开发态与安装版共用同一目录，因此没有历史数据迁移；卸载也不会删它（`deleteAppDataOnUninstall: false`）。
- **不做代码签名（D5 已定）**：首次运行会有 SmartScreen 提示，属预期；用发布页 SHA256 + 图文指引对冲，W19 视内测安装放弃率再评估证书。
- **二进制下载走 npmmirror**：electron / NSIS / winCodeSign 的官方源在本机会 502，`scripts/builder-env.mjs` 统一注入镜像；想走官方源用 `CTEXT_NO_MIRROR=1 pnpm dist`。
- 改了 Python 代码要先 `pnpm build:worker`（`pnpm verify:package` 会在产物缺失时自动构建）。

打包验收：

```bash
pnpm verify:package              # 构建 → release/win-unpacked → 真跑一次应用自检
pnpm verify:package --installer  # 再加：出 NSIS → 静默安装到临时目录 → 从安装目录启动 → 静默卸载
```

它断言的是**只有真包才成立**的东西：asar 内不含 `.exe`/sourcemap、含 `better-sqlite3` 原生模块、worker 来自 `resources/python`、`health.ping` 通、数据库与日志落在 userData、渲染层真的挂上了 Vue、安全模式决策自洽。

## 已知环境问题

这几条是本机实测踩出来的，改动前先读，避免重复排障。

**1. 终端里的 `ELECTRON_RUN_AS_NODE=1`**
WorkBuddy / VS Code 等 IDE 的终端会预设该变量，Electron 读到后退化成纯 Node 运行 `main/index.js`，窗口不出现且报 `Cannot find module`。
→ `pnpm dev` / `pnpm start` 已由 `scripts/dev.mjs` 在派生子进程前清除。用 `pnpm dev:raw` 时需自己 `unset`。

**2. Chromium 子进程沙箱在本机不可用**
本机存在 MuMu / GameViewer 等虚拟显示适配器时：GPU 进程反复 `0xC0000005` 崩溃并 FATAL 拖死主进程；Network service 起不来导致页面永远空白。
→ 开发态固定关闭 `disable-gpu-sandbox` 与 `no-sandbox`。
→ **生产包默认带沙箱**（不牺牲别人的安全边界），只在检测到异常时自动回退：上次启动没画完第一帧就没了 / GPU 或 Network 子进程崩溃 / 首帧 20s 超时 → 写标记 + 带 `--safe-mode` 自动重启一次，之后启动直接沿用。实现见 `src/main/platform/safe-mode.ts`，状态在 `userData/boot-state.json`，可从 `system:info` 的 `safeMode` / `safeModeSource` 读到。
→ 想恢复默认沙箱：删掉 `boot-state.json`，或用 `CTEXT_SAFE_MODE=0` / `--no-safe-mode` 启动一次。极端情况仍可用 `CTEXT_DISABLE_GPU=1` 强制软件渲染。

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
