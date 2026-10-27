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

第二条命令装解析依赖（lxml / charset-normalizer / Pillow）。M0-05 的 worker 骨架只用标准库，但 `health.ping` 会报告这些依赖是否就位，缺了会在 `pnpm verify:bridge` 里显红。EPUB 解析自 M1-05 起改用标准库 `zipfile` + `lxml`，不再依赖 ebooklib。

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
| `pnpm verify:roots` | M1-01 根目录验收（登记查重、掉线与恢复、事件广播、重定位、移除不删书） |
| `pnpm verify:scan` | M1-02 扫描器验收（白名单、忽略、深度、符号链接防环、截断、取消、1000 文件性能） |
| `pnpm verify:dedupe` | M1-03 指纹去重验收（指纹一致性、已知盲区、四类重复分流、跨根去重、批量查询） |
| `pnpm verify:txt` | M1-04 TXT 解析验收（20 个编码样本识别率、章节分级、元数据、bridge 链路） |
| `pnpm verify:epub` | M1-05 EPUB 解析验收（26 个结构样本的目录层级、封面提取率、DRM/损坏识别、bridge 链路） |
| `pnpm verify:import` | M1-06 导入队列验收（预览分类、首次/重复导入、覆盖、失败隔离、取消一致性、子目录归属） |
| `pnpm verify:import:ui` | M1-07 导入交互验收（真实拖放 → 预览分类 → 导入 → 结果 → 重复不脏 → 取消） |
| `pnpm verify:list` | M1-08 万本压测（books:list P95、虚拟 DOM 有界、滚动帧率、触底分页） |
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
│  ├─ ipc/             通道注册（registry / system / window / log / roots）+ 冒烟
│  ├─ db/              连接、PRAGMA、版本化迁移、DDL；repositories/ 是各表的 SQL 封装
│  ├─ library/         书库业务：根目录探测与状态监测（roots-monitor）、目录扫描（scanner）、指纹去重、解析链路 + 各自自检
│  ├─ bridge/          Python worker：进程管理、NDJSON 协议、定位启动命令
│  ├─ log/             结构化日志：JSON Lines 落盘、按天滚动、级别过滤、计时
│  ├─ errors/          全局异常兜底（uncaughtException / 渲染进程退出 / preload 失败…）
│  └─ utils/           脱敏（redact）、错误码映射（to-app-error）、toast 推送（notify）、ULID（id）
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

## 书库根目录（M1-01）

多根目录是本产品的核心结构：`D:\books` 与 `F:\移动硬盘\小说` 可同时登记，拔盘不影响任何数据。

| 通道 | 说明 |
| --- | --- |
| `roots:list` | 只读库，不探测。带 `bookCount` 子查询 |
| `roots:add` | 规范化路径 → 探测可读 → 查重 → 登记；`label` 取目录名 |
| `roots:check` | 全量探测并落 `state`，状态变化的广播 `roots:changed` |
| `roots:relocate` | 换路径；返回 `{ matched, missing }` 供 UI 提示「42 本里 3 本没找到」 |
| `roots:remove` | 仅解除登记，书籍解绑 `root_id`（变 NULL）后仍可见 |

几条必须记住的约定：

- **检测时机是「启动 + 主窗口重新获得焦点（节流 30s）+ 手动检测」，没有常驻轮询**。常驻轮询会在移动硬盘休眠时反复唤醒它，而切回窗口就会触发一次检测，实时性已够。
- **状态没变时也更新 `last_check_at`（节流 60s）**，否则「上次检测」会永远停在最后一次状态变化那一刻。
- **只有状态变化才广播**，且事件在全部落库之后才发 —— 订阅方收到事件立刻回查 `roots:list` 能读到新状态。
- **`roots:remove` 不删书**：`books.root_id` 外键没有 `ON DELETE`，所以仓储在同一事务里先 `UPDATE books SET root_id = NULL` 再删根目录。解绑后的书 `root_id` 为 NULL，与网络书共用同一表示，靠 `source_type` 区分。
- **路径查重靠 `lower(path)`**：SQLite 是字节级比较，而 Windows 大小写不敏感，不折叠 `D:\Books` 与 `d:\books` 会被登记成两条。
- 验收命令 `pnpm verify:roots`（40 项，用删除临时目录模拟拔盘）。**必须带 `--user-data-dir`**：自检会往库里写测试根目录。

## 目录扫描器（M1-02）

`scanDirectory(root, options)` 只做一件事：**递归找出所有可导入的文件，不读内容、不碰数据库**。指纹、解析、入库都在下游，所以它能在无窗口、无 DB 的环境里跑（`pnpm verify:scan` 全程约 10s）。

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `maxDepth` | 8 | **root 是第 0 层**，8 表示最多进到第 8 层子目录 |
| `extensions` | `.txt` / `.epub` | 大小写不敏感（D1：不做 MOBI/AZW3/PDF） |
| `ignore` | `node_modules` / `.git` / `.svn` / `.hg` / `$RECYCLE.BIN` / `System Volume Information` | 正则源码，对 `/` 分隔的 `rel_path` 匹配 |
| `maxFiles` | 50000 | 超过标记 `truncated` 并停止入队；防用户误选 `C:\` |
| `concurrency` | 8 | 并发目录数 |
| `signal` | — | `AbortSignal`，M1-06 的任务取消用 |

几条必须记住的约定：

- **`rel_path` 一律 `/` 分隔**，落盘前必须过 `resolveRelPath()`。库里存的是相对路径，混用系统分隔符会在「父目录判断」「字符串前缀比较」这类地方出问题。
- **符号链接一律不跟随**（`stats.skippedSymlink` 计数）。跟随就要 realpath 去环，每条目多一次 IO；而「防环」最彻底的实现是根本不进去。根目录本身是链接没问题，只是内部的链接不展开。
- **不可读目录只记录不中断**：错误进 `stats.unreadable`，一个目录 EACCES 不该让整次扫描失败。
- **结果按 `relPath` 升序**，导入流程依赖稳定顺序做进度估算。
- **`ignore` 正则写错时静默跳过**，不让扫描崩；设置页（M5-01）必须在输入时校验能否编译。

## 内容指纹与去重（M1-03）

跨根目录判重靠 `books.file_hash`，算法是 **size + 首末 4KB 的 sha1**，不是全文哈希——200MB 的 TXT 全文哈希要读满 200MB，而首末各 4KB 只读 8KB，恒定耗时。450 个文件去重实测 66ms。

```ts
fingerprintFile(path)  // → { hash: 40位hex, size, algorithm: 'size+head4k+tail4k' }
fullSha1(path)         // 兜底全文摘要，只在「疑似重复但用户要确认」时调
dedupeFiles(rootId, files, { db })  // → { entries, unique, duplicates, stats }
```

四类重复必须分清，UI 文案各不相同：

| kind | 含义 | 提示 |
| --- | --- | --- |
| `existing-path` | 同根目录同 `rel_path` 已有记录 | 这本书已在书库中（路径未变） |
| `duplicate-in-db` | 内容指纹命中**别的**路径的书 | 书库里已有同一本（`D:\books\xx.txt`） |
| `duplicate-in-batch` | 本批次内重复 | 本批次内重复（`duplicateOf` 给出首次出现的 relPath） |
| `empty` | 0 字节 | 空文件，已跳过 |

几条必须记住的约定：

- **判定顺序是先 path 后 hash**。同 path 命中说明文件就在原地，此时报「书库里已有同一本书（另一个路径）」会让用户困惑。
- **size ≤ 4KB 时首末块重叠，等价全文哈希**，没有盲区；只有 >8KB 才有理论盲区（首末相同、size 相同、中间不同会碰撞）。这是刻意取舍，`pnpm verify:dedupe` 里有一条断言专门记录它。**「仍要导入」必须先 `fullSha1` 复检**。
- **去重只判定不写库**，UPSERT 在 M1-06。这样预览面板能反复跑去重而不产生副作用。
- **软删除的书不参与去重**（`deleted_at IS NOT NULL` 落在部分索引之外），删了又放回来能重新入库。
- **批量查 hash 按 400 一批切**：SQLite 的绑定参数有上限（旧版 999）。自检用 450 个文件覆盖跨批边界。

## TXT 解析（M1-04）

三个方法，全部在 Python 侧（`python/ctext_worker/methods/parse_txt.py`），经 bridge 调用：

| 方法 | 返回 |
| --- | --- |
| `parse.detect` | `{ format, encoding, size }` |
| `parse.meta` | `{ title, author, intro, coverPath, lang, encoding }` |
| `parse.txt.outline` | `{ encoding, detectedEncoding, chapters: [{idx, title, level, offset, length}] }` |

**编码探测链**（`textenc.py`，顺序不可调换）：

1. **BOM** — 有 BOM 就没有歧义。注意 UTF-32 LE 的 BOM 是 UTF-16 LE 的超集，必须排前面。
2. **严格 UTF-8** — 「能否解码」是确定性判据，比统计模型的 chaos 分数可信。中文 UTF-8 与 GBK 的字节特征互斥。
3. **UTF-16 启发式** — 纯中文的 UTF-16 没有 NUL 字节，靠「CJK 高字节（0x4E~0x9F）在奇/偶位」判断。
4. **候选排名** — 取 charset-normalizer 的前 4 个候选 + `gb18030`，按 `(替换字符数, 谚文+假名数, 是否 gb18030, -汉字数)` 排序。**这一步是关键**：短 GBK 文本模型会给 `cp949`，短样本上 `euc-jis-2004` 甚至能赢过 `gb18030`——中日韩共用汉字区，字节层面分不出来，但解出来的字符类别分得出来。
5. **gb18030 兜底** — GBK/GB2312 的超集。

**章节识别**分强弱两档：强档（`第X卷/部/篇/集` → level 0；`第X章/回/节/话`、`楔子`/`序章`/`尾声`/`番外`、英文 `Chapter`/`Part` → level 1）默认启用；弱档（`1. 标题` 这类纯数字行）**只在强档命中少于 3 条时**才启用——正文里的编号列表太多，无条件启用会把目录炸成几百条垃圾。标题行长超过 50 字不算标题。

几条必须记住的约定：

- **`offset` 是字节偏移**（`chapters.anchor` 的约定），不是字符偏移。**带 BOM 的文件必须跳过 BOM**，否则第一章偏 3 字节，切出来的正文开头带不可见字符。
- **`level` 语义：0 = 卷/部（上层），1 = 章/回，2 = 更细层级**。数字越小越靠近目录树根。早期 `ChapterDTO` 注释写成「0 为章、1 为卷」是笔误，M1-04 已改正。
- **一章都没识别出来时返回单章「全文」**。不是所有 TXT 都有章节标记，没有兜底阅读器会拿到空目录。
- **元数据优先级：书名看文件名，作者看正文**（「作者：」在正文里比文件名可靠）。
- 验收 `pnpm verify:txt` 分两段：`python/smoke_parse.py` 测算法（能在 Python 侧造 GBK/UTF-16 样本），`parse-bridge-smoke.ts` 测链路。

## EPUB 解析（M1-05）

实现在 `python/ctext_worker/epub.py`（底层）+ `methods/parse_epub.py`（契约）：

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `parse.epub.toc` | `path` | `{ chapters: [{idx, title, level, href}], chapterCount, source, spineCount, version }` |
| `parse.meta` | `path`, `format: "epub"` | `{ title, author, intro, lang, publisher, pubDate, coverHref, coverSource, coverPath: null }` |
| `cover.extract` | `path`, `destDir`（绝对路径） | `{ coverPath, coverFile, bytes, width, height, source }` |

**没有用 ebooklib**，直接 `zipfile` + `lxml`：它会把全部文档读进内存，且失败时只抛 `BadZipFile`，无法区分「包坏了 / 不是 EPUB / 受 DRM 保护」——而导入结果面板必须按原因分类。

几个必须记住的约定：

- **`href` 是 zip 内完整路径**（如 `OEBPS/Text/ch1.xhtml`），已做 URL 解码、`..` 折叠、去 fragment。M2-03 拿到就能 `zip.read()`。
- **`level` 由目录树深度决定，不靠标题文字猜**：树只有一层 → 顶层 `level = 1`（章）；两层及以上 → 顶层 `level = 0`（卷），往下 +1，超过 2 压到 2。与 TXT 语义完全一致。
- **包装层只按标题拆**（`目录`/`正文`/`Contents`/`TOC`）。`目录 > 章` 与 `第一部 > 第一卷 > 章` 形状相同，按形状拆会吃掉真正的分部标题。
- **非链接的分卷标题保留，anchor 继承首个子节点的 href**。否则那一级会消失，或者 M2 拿到一个打不开的章节。
- **目录来源优先级 nav（EPUB3）→ ncx（EPUB2）→ spine 兜底**。`source` 字段如实回传用了哪条。
- **`parse.meta` 不写文件**。它回传 `coverHref` / `coverSource` 提示，真正落盘只在 `cover.extract`。封面文件名是内容 sha1，天然幂等。
- **封面按魔数判格式，不信清单声明**：有大量 EPUB 把 `cover.xhtml` 声明成 `image/jpeg`。内容以 `<` 开头时只认 SVG，不再退回扩展名。
- **DRM 判定逐条 `EncryptedData`**，且**字体混淆（IDPF/Adobe）不算 DRM**——那是 OCF 标准做法，误判会拒掉一大片正规出版书。
- 失败统一报 `E_PARSE_FAILED`（`文件解析失败，可能已损坏或加密`），不与 `E_IO` / `E_INVALID_ARGUMENT` 混用。

验收 `pnpm verify:epub` 分三段：构建 → `python/smoke_epub.py --emit <dir>`（26 个按结构生成的样本，82 项断言，封面提取率 5/5）→ `epub-smoke.ts` 走真实链路（25 项，含封面跨进程落盘与错误码透传），共 **107/107**。样本生成器是 `python/make_epub.py`，按结构参数化，需要新的 EPUB 变体时加一条用例即可。

## 导入任务队列（M1-06）

一次导入的完整生命周期：**解析目标根目录 → 扫描 → 去重 → 逐本解析 → 分批落库**。四件事必须同时成立：

1. **单本失败不中断**。一本加密 EPUB 不能让 500 本导入整体失败。
2. **每本书是原子的**。书行与它的章节行在同一个事务里，否则取消/崩溃会留下一本没有目录的书——阅读器点进去就是空白，比导入失败更难排查。
3. **事务粒度是一批 50 本**。逐本提交在 WAL 下每本一次 fsync，500 本要多花十几秒；整批提交则内存与回滚代价过高。**整批失败时退化成逐本写入**，既保住其余 49 本又能定位坏的那本。
4. **取消要留干净的中间态**。取消后不再取新任务，在途的几本跑完，缓冲区一次性落库——已入库的每本都完整，且不浪费已完成的解析。

几个容易搞错的点：

- **`onDuplicate: 'overwrite'` 只在内容真的变了时才覆盖**，判定靠 `file_hash` 比对。否则「重新导入」会把整库重解析一遍，而用户只是想补进新增的那几本。
- **扫描器新增 `relBase`**：导入根目录下的子目录时扫描从子目录开始（更省），但 `rel_path` 仍相对根目录。否则同一个文件会以两种 `rel_path` 入库两次。
- **忽略正则在 `startImport` 里同步校验**。放在异步任务里会先返回 `taskId` 再异步失败，UI 拿到的是一个永远不动的任务。
- **`parse.detect` 只探测一次编码**，结果传给 `parse.meta` / `parse.txt.outline`（M1-04 遗留，本节点闭环）。EPUB 的 `parse.detect` 直接回 `encoding: null`。
- `import:commit` 只返回 `taskId`，进度全部走 `import:progress` 事件。

验收 `pnpm verify:import` 分三段：构建 → 生成 EPUB 样本（复用 M1-05 的 `smoke_epub.py --emit`）→ `import-smoke.ts` 在真实主进程里跑（独立临时库 + 临时目录，不碰真实书库），共 **60/60**，覆盖预览分类、首次/重复导入、overwrite 覆盖、单本失败隔离、60 本中途取消的数据一致性、子目录归属与参数校验。

## 导入交互（M1-07）

四段式面板：**选目录 → 预览分类 → 导入中 → 结果**。入口有三个：工具栏按钮、空状态按钮、拖放。

几个容易做错的点：

- **预览必须能扫未登记的目录**。产品文档 §2.4 的「是否同时登记为根目录」是在**导入时**才问的，而预览在导入之前。实现上给 `resolveImportTarget` 加了 `mode.allowUnregistered`（预览专用），未登记时 `rootId` 返回空串；登记仍然只发生在导入时。
- **`dragleave` 的处理器不能判断「是否拖的是文件」**——该事件的 `dataTransfer` 常常是空的，加了判断就永远退不出高亮态。另外兜一层 `dragend`（按 Esc 取消拖放时不一定有 dragleave）。
- **`File.path` 已废弃**，改用 `webUtils.getPathForFile`，只能在 preload 里调，所以 preload 新增 `getFilePath(file)`。只接受 File 实例，不接受路径字符串。
- **目录与文件靠 `webkitGetAsEntry().isDirectory` 区分**；拿不到 entry 时退回「没有扩展名就当目录」。拖进来的文件会定位到所在文件夹，并在面板顶部如实说明（单文件导入尚未实现，不能假装只导入了那几个文件）。
- **关闭面板不取消任务**。误关面板不该丢掉一次几十秒的导入；进度订阅挂在应用生命周期上，关掉面板也能收到完成提示。
- **预览把坏 EPUB 算进「新增」，导入时才落到失败清单**。预览只算指纹不做解析，无法预知解析失败。副作用是失败项天然可重试。
- **「不支持」与「跳过」是两个页签**：PDF 是格式不要，空文件是没内容，混在一起会误导。

验收 `pnpm verify:import:ui` 分三段：构建 → 造两个样本目录 → `import-ui-smoke.ts` 在真实窗口里跑，**30/30**。拖放用 CDP 的 `Input.dispatchDragEvent` 派发真实拖放事件（合成 DOM 事件拿不到磁盘路径，`webUtils.getPathForFile` 会抛，等于没测拖放）；CDP 没有 `dragLeave` 类型，「拖出窗口」这一支改为直接派发 `dragleave` 验证。

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
- **渲染层仍用 mock 数据**（`src/renderer/mock/library.ts`，16 本书 / 3 个根目录 / 2 个书架 / 3 个书源）。`roots:*` 后端已在 M1-01 完成，但界面还没接，换成真实查询是 M1-08 的事，届时侧栏组件不用动。
- **未实现动作给 toast**，不假装成功：新建书架 → M3-02、导入书籍 → M1-06、导入书源 → M4-07、重新指定目录 → M1-07（后端 `roots:relocate` 已可用）。

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
