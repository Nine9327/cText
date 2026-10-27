/**
 * 打包验收（M0-07）。
 *
 * 分级执行，越往后越贵：
 *   pnpm verify:package              构建 + builder --dir + 跑 release/win-unpacked 里的 exe
 *   pnpm verify:package --installer  再加：出 NSIS 安装包 → 静默安装到临时目录 → 从安装目录跑 → 静默卸载
 *   pnpm verify:package --skip-build 跳过 electron-vite build（只改 Python 产物时用）
 *   pnpm verify:package --rebuild-worker 强制重打 PyInstaller 产物
 *
 * 断言主要来自应用自己写的 JSON 报告（src/main/package/smoke.ts）：
 * 打包后的 Electron 在 Windows 上是 GUI 子系统程序，stdout 不保证接得到，
 * 所以脚本以报告文件为准，stdout 只作为诊断信息打印。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILDER_CLI, builderEnv } from './builder-env.mjs'
import { listPackage } from '@electron/asar'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const flag = (name) => process.argv.includes(name)
const skipBuild = flag('--skip-build')
const withInstaller = flag('--installer')
const rebuildWorker = flag('--rebuild-worker')

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version
const releaseDir = join(root, 'release')
const unpackedDir = join(releaseDir, 'win-unpacked')
const workerExe = join(root, 'resources', 'python', 'ctext-worker', 'ctext-worker.exe')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail: String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`)
}
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

function fail(message, hint = '') {
  console.error(`\n✗ ${message}`)
  if (hint) console.error(`  ${hint}`)
  summary()
  process.exit(1)
}

function summary() {
  const failed = results.filter((r) => !r.ok)
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length}`)
}

async function run(cmd, argv, opts = {}) {
  console.log(`\n$ ${cmd} ${argv.join(' ')}`)
  // 用 node 直接跑脚本时不能套 shell：路径里有中文/空格会被重新拆分
  const shell = cmd === process.execPath ? false : process.platform === 'win32'
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, argv, {
      cwd: root,
      stdio: 'inherit',
      shell,
      ...opts
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${cmd} 退出码 ${code}`))
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待某个路径消失（NSIS 卸载是异步的：主进程退出后临时副本继续删文件） */
async function waitGone(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!existsSync(target)) return true
    await sleep(400)
  }
  return !existsSync(target)
}

/**
 * 删除临时目录。
 * 宿主的 safe-delete 守卫会拦"单次批量删除 50+ 个文件"，这里全部容错：
 * 删不掉只是留点临时文件，不该让验收失败。构建产物目录本来也不需要我们先清
 * （electron-builder 会自己覆盖）。
 */
function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    console.log(`  · 临时目录未清理（可手动删）：${dir}`)
  }
}

function dirSize(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) total += dirSize(p)
    else if (entry.isFile()) total += statSync(p).size
  }
  return total
}

/**
 * 启动打包后的应用跑自检，等它把 JSON 报告写出来。
 *
 * 注意等待逻辑：安全模式回退会在**同一次启动内** relaunch（父进程先退、子进程继续），
 * 所以不能以"父进程退出且没有报告"判定失败，必须一直轮询报告文件。
 */
async function runPackagedSmoke(exePath, cwd, label, reuseUserData) {
  const scratch = mkdtempSync(join(tmpdir(), 'ctext-pkg-'))
  const out = join(scratch, 'report.json')
  // 用独立的 userData 跑验收：不碰用户真实的库/日志/启动状态，
  // 也保证每次都是「干净机器首次启动」的路径（否则上一轮的粘性安全模式会影响结论）。
  // reuseUserData 用于跨启动验证"粘性安全模式"。
  const userData = reuseUserData ?? join(scratch, 'userData')
  const env = { ...process.env, CTEXT_PACKAGE_SMOKE: '1', CTEXT_SMOKE_OUT: out }
  // 宿主机 IDE 会预设 ELECTRON_RUN_AS_NODE，不清掉 Electron 会退化成纯 Node
  delete env.ELECTRON_RUN_AS_NODE
  // 不让上一次实验残留的强制安全模式影响"真实决策"的测量
  delete env.CTEXT_SAFE_MODE
  // 宿主的 NODE_OPTIONS shim 会让打包后的 Electron 打一条无意义的报错
  delete env.NODE_OPTIONS

  console.log(`\n$ ${exePath} --user-data-dir=<tmp>  （${label}）`)
  const child = spawn(exePath, [`--user-data-dir=${userData}`], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const stdout = []
  const stderr = []
  child.stdout?.on('data', (b) => stdout.push(b.toString()))
  child.stderr?.on('data', (b) => stderr.push(b.toString()))

  let exitedAt = 0
  child.on('exit', () => {
    exitedAt = Date.now()
  })

  const deadline = Date.now() + 90_000
  let report = null
  while (Date.now() < deadline) {
    if (existsSync(out)) {
      try {
        report = JSON.parse(readFileSync(out, 'utf8'))
        break
      } catch {
        // 正在写，下个 tick 再读
      }
    }
    // 进程已退出且迟迟没有报告 = 起不来；不必等满 90s。
    // 留 8s 余量是为了让 `app.relaunch` 拉起的子进程有机会写报告。
    if (exitedAt > 0 && Date.now() - exitedAt > 8000) break
    await sleep(250)
  }

  // 让画面与子进程收尾，避免影响后续安装/卸载
  await sleep(1500)

  if (!report) {
    const tail = (stderr.join('') || stdout.join('')).split('\n').slice(-12).join('\n')
    console.log(`  ✗ ${label}：没有产出报告（进程未成功画完第一帧）`)
    if (tail.trim()) console.log(`    输出尾部：\n${tail}`)
    const stateFile = join(userData, 'boot-state.json')
    if (existsSync(stateFile)) {
      console.log(`    boot-state：${readFileSync(stateFile, 'utf8').replace(/\s+/g, ' ')}`)
    }
  } else {
    for (const c of report.checks) {
      if (!c.ok) console.log(`  ✗ ${c.name} (${c.detail})`)
    }
  }

  cleanup(scratch)
  return report
}

/**
 * 跑一次自检；首次起不来时允许按设计自动回退再跑一次。
 *
 * 这是真实世界的行为：沙箱不可用的机器上第一次启动会崩在画第一帧之前，
 * 主进程可能来不及 relaunch，于是下次启动才进安全模式。脚本如实记录这次重试。
 */
async function runPackagedSmokeWithRetry(exePath, cwd, label) {
  const first = await runPackagedSmoke(exePath, cwd, label)
  if (first) return { report: first, attempts: 1 }

  console.log(`\n  首次启动未起来，按安全模式回退机制重试一次（${label}）`)
  const second = await runPackagedSmoke(exePath, cwd, `${label} · 第二次`)
  if (!second) fail(`${label}：连续两次启动都没有产出报告，打包产物不可用`)
  record(`${label}：首次失败后自动回退成功`, true, `safeMode=${second.info.safeMode}`)
  return { report: second, attempts: 2 }
}

// ---------------------------------------------------------------- 1. 前置
console.log('\n=== 1. 前置检查 ===')
if (rebuildWorker || !existsSync(workerExe)) {
  await run('node', ['scripts/build-worker.mjs'])
}
record('Python worker 产物存在', existsSync(workerExe), workerExe)
record('图标资源存在', existsSync(join(root, 'resources', 'icons', 'icon.ico')))
record('electron-builder 配置存在', existsSync(join(root, 'electron-builder.yml')))

// ---------------------------------------------------------------- 2. 构建
console.log('\n=== 2. 构建渲染层与主进程 ===')
if (skipBuild) {
  console.log('跳过（--skip-build）')
  record('out/main/index.js 存在', existsSync(join(root, 'out', 'main', 'index.js')))
} else {
  await run(process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
  record('out/main/index.js 存在', existsSync(join(root, 'out', 'main', 'index.js')))
}
if (!results.every((r) => r.ok)) fail('构建阶段失败')

// ---------------------------------------------------------------- 3. 打包（目录）
console.log('\n=== 3. electron-builder --dir ===')
// 不预先删 win-unpacked：electron-builder 会自己覆盖；手工递归删除几百个文件
// 反而会被宿主的 safe-delete 守卫拦下来
await run(process.execPath, [BUILDER_CLI, '--win', '--dir'], { env: builderEnv() })

const packagedExe = join(unpackedDir, 'cText.exe')
const asar = join(unpackedDir, 'resources', 'app.asar')
const packagedWorker = join(unpackedDir, 'resources', 'python', 'ctext-worker', 'ctext-worker.exe')
record('产出 cText.exe', existsSync(packagedExe))
record('产出 app.asar', existsSync(asar), existsSync(asar) ? mb(statSync(asar).size) : '')
record('worker 在 asar 外的 resources/python 下', existsSync(packagedWorker))
record(
  'PyInstaller _internal 齐全',
  existsSync(join(unpackedDir, 'resources', 'python', 'ctext-worker', '_internal'))
)

// asar 里绝不能出现 Python 产物（exe 无法从 asar 执行），也不该夹带 sourcemap。
// 用 asar 的文件清单判断，而不是在字节流里找字符串——字符串会在 bundle 里
// 以路径字面量的形式出现（launch.ts 的 'ctext-worker.exe'），会误报。
const asarFiles = existsSync(asar) ? listPackage(asar) : []
record('asar 内容可列举', asarFiles.length > 0, `${asarFiles.length} 个条目`)
record('asar 内不含 .exe', !asarFiles.some((f) => f.toLowerCase().endsWith('.exe')))
record('asar 内不含 sourcemap', !asarFiles.some((f) => f.endsWith('.map')))
record('asar 内不含根级 python/ 目录', !asarFiles.some((f) => f.startsWith('\\python')))
record(
  'asar 含主进程与渲染层产物',
  asarFiles.includes('\\out\\main\\index.js') && asarFiles.some((f) => f.startsWith('\\out\\renderer')),
  `main=${asarFiles.includes('\\out\\main\\index.js')}`
)
record(
  'asar 含原生模块 better-sqlite3',
  asarFiles.some((f) => f.includes('better-sqlite3')),
  asarFiles.filter((f) => f.includes('better_sqlite3.node')).join(',') || '未找到 .node'
)

// ---------------------------------------------------------------- 4. 未打包目录冒烟
console.log('\n=== 4. 从 win-unpacked 启动并自检 ===')
const { report: dirReport } = await runPackagedSmokeWithRetry(packagedExe, unpackedDir, 'win-unpacked')
record('未打包目录：应用自检全通过', dirReport.ok, `${dirReport.checks.filter((c) => c.ok).length}/${dirReport.checks.length}`)
record(
  'worker 路径解析到包内 resources',
  String(dirReport.info.workerExe ?? '').replace(/\\/g, '/').includes('/win-unpacked/resources/python/'),
  dirReport.info.workerExe
)
record('版本号与 package.json 一致', dirReport.info.version === version, `${dirReport.info.version}/${version}`)
record('安全模式决策已上报', typeof dirReport.info.safeMode === 'boolean', String(dirReport.info.safeMode))
console.log(
  `\n  安全模式：${dirReport.info.safeMode ? '开启' : '关闭'}（来源 ${dirReport.info.safeModeSource}，` +
    `开关 ${JSON.stringify(dirReport.info.switches)}，连续失败 ${dirReport.info.crashStreak}）`
)

// ---------------------------------------------------------------- 4b. 安全模式粘性
// 只在"本机确实需要回退"时有意义：干净 userData 首次启动若自动切到安全模式，
// 那第二次启动（同一 userData）必须直接沿用，不能每次都先崩一遍。
console.log('\n=== 4b. 安全模式是否可沿用 ===')
const stickyUserData = join(mkdtempSync(join(tmpdir(), 'ctext-sticky-')), 'userData')
const firstBoot = await runPackagedSmoke(packagedExe, unpackedDir, '干净 userData 首次启动', stickyUserData)
if (!firstBoot) {
  record('干净 userData 首次启动', false, '没有产出报告')
} else if (!firstBoot.info.safeMode) {
  record('本机沙箱可用，无需安全模式回退', true, '跳过粘性验证')
} else {
  const relaunchedArgs = (firstBoot.info.argv ?? []).slice(1)
  record(
    '首次启动即进入安全模式',
    firstBoot.ok && firstBoot.info.safeMode === true,
    `source=${firstBoot.info.safeModeSource} args=${relaunchedArgs.join(' ') || '(无)'}`
  )
  const secondBoot = await runPackagedSmoke(packagedExe, unpackedDir, '同一 userData 第二次启动', stickyUserData)
  record(
    '第二次启动沿用安全模式（source=fallback）',
    !!secondBoot && secondBoot.info.safeMode === true && secondBoot.info.safeModeSource === 'fallback',
    secondBoot ? `${secondBoot.info.safeMode}/${secondBoot.info.safeModeSource}` : '无报告'
  )
  record(
    '第二次启动不再 relaunch（无 --safe-mode 参数）',
    !!secondBoot && !(secondBoot.info.argv ?? []).includes('--safe-mode'),
    secondBoot ? (secondBoot.info.argv ?? []).slice(1).join(' ') || '(无参数)' : '无报告'
  )
}
cleanup(dirname(stickyUserData))

// ---------------------------------------------------------------- 5. 安装包
if (withInstaller) {
  console.log('\n=== 5. 出 NSIS / portable / zip ===')
  const started = Date.now()
  await run(process.execPath, [BUILDER_CLI, '--win'], { env: builderEnv() })

  const artifacts = readdirSync(releaseDir).filter((f) => /\.(exe|zip)$/.test(f))
  console.log(`\n  产物（${((Date.now() - started) / 1000).toFixed(0)}s）：`)
  for (const f of artifacts) console.log(`    ${f}  ${mb(statSync(join(releaseDir, f)).size)}`)

  const setup = artifacts.find((f) => f.includes('setup') && f.endsWith('.exe'))
  const portable = artifacts.find((f) => f.includes('portable') && f.endsWith('.exe'))
  const zip = artifacts.find((f) => f.endsWith('.zip'))
  record('产出 NSIS 安装包', !!setup, setup ?? '未找到')
  record('产出 portable 单文件', !!portable, portable ?? '未找到')
  record('产出 zip 免安装包', !!zip, zip ?? '未找到')
  if (!setup) fail('没有安装包，无法继续安装验收')

  // ------------------------------------------------------------ 6. 静默安装
  console.log('\n=== 6. 静默安装到临时目录 ===')
  const installDir = join(mkdtempSync(join(tmpdir(), 'ctext-inst-')), 'cText')
  console.log(`  安装目录：${installDir}`)
  // NSIS：/S 静默，/D 指定目录（必须是最后一个参数且不能加引号）
  // shell: false —— 安装/卸载程序文件名里有空格（"Uninstall cText.exe"），
  // 走 shell 会被 cmd 按空格拆开。NSIS 的 /D= 必须是不带引号的绝对路径且放最后
  await run(resolve(releaseDir, setup), ['/S', `/D=${installDir}`], { shell: false })
  const installedExe = join(installDir, 'cText.exe')
  await sleep(2000)
  record('安装目录里出现 cText.exe', existsSync(installedExe), installedExe)
  record('安装目录里有 Python 产物', existsSync(join(installDir, 'resources', 'python', 'ctext-worker', 'ctext-worker.exe')))
  record('安装体积合理（≥80MB）', existsSync(installDir) && dirSize(installDir) >= 80 * 1024 * 1024, existsSync(installDir) ? mb(dirSize(installDir)) : '')

  // ------------------------------------------------------------ 7. 从安装目录启动
  console.log('\n=== 7. 从安装目录启动并自检 ===')
  const { report: instReport } = await runPackagedSmokeWithRetry(installedExe, installDir, 'installed')
  record('安装版：应用自检全通过', instReport.ok, `${instReport.checks.filter((c) => c.ok).length}/${instReport.checks.length}`)
  record(
    '安装版：worker 来自安装目录',
    String(instReport.info.workerExe ?? '').replace(/\\/g, '/').includes(installDir.replace(/\\/g, '/')),
    instReport.info.workerExe
  )
  record(
    '安装版：userData 不在安装目录内',
    !String(instReport.info.userData ?? '').startsWith(installDir),
    instReport.info.userData
  )

  // ------------------------------------------------------------ 8. 静默卸载
  console.log('\n=== 8. 静默卸载 ===')
  const uninstaller = readdirSync(installDir).find((f) => f.startsWith('Uninstall') && f.endsWith('.exe'))
  if (!uninstaller) {
    record('找到卸载程序', false, '安装目录里没有 Uninstall*.exe')
  } else {
    await run(join(installDir, uninstaller), ['/S'], { shell: false })
    // NSIS 卸载器会把自己复制到 %TEMP% 再执行，父进程立刻返回 0，
    // 真正的删除是异步的（实测 4~12s），所以必须轮询而不是 sleep 一个固定值
    const gone = await waitGone(installedExe, 30_000)
    record('卸载后 cText.exe 已移除', gone, gone ? '' : '30s 内仍在')
    const leftovers = existsSync(installDir) ? readdirSync(installDir).length : 0
    record('卸载后安装目录基本清空', leftovers <= 2, `${leftovers} 项残留`)
    cleanup(dirname(installDir))
  }
}

summary()
const failed = results.filter((r) => !r.ok)
process.exit(failed.length === 0 ? 0 : 1)
