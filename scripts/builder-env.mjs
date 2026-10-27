/**
 * electron-builder 的构建环境（M0-07）。
 *
 * electron-builder 出 Windows 包时要额外下载三类二进制：
 *   - electron 发行版（解压成 win-unpacked 的那份）
 *   - winCodeSign（签名工具链）
 *   - nsis（做安装包的编译器）
 * 后两者走 GitHub Releases，本机网络会 502；npmmirror 有完整镜像。
 * electron 的 headers 只能用 artifacts.electronjs.org（npmmirror 没有 headers 包，
 * GitHub 被代理挡），那部分由 scripts/rebuild-native 处理，与这里无关。
 *
 * 优先级：用户显式设置的环境变量 > 本项目默认镜像 > electron-builder 默认值。
 * 想走官方源：CTEXT_NO_MIRROR=1。
 */
const MIRRORS = {
  ELECTRON_MIRROR: 'https://registry.npmmirror.com/-/binary/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
}

export const BUILDER_CLI = 'node_modules/electron-builder/cli.js'

export function builderEnv(base = process.env) {
  const env = { ...base }

  // 宿主机 IDE 会预注入两类东西，构建时都要摘掉：
  //   ELECTRON_RUN_AS_NODE —— 会让 electron 相关子进程退化成纯 Node
  //   NODE_OPTIONS（--require ...shim）—— 宿主的文件操作守卫会拦 electron-builder
  //   解压 electron 时的批量删除（SAFE_DELETE_BULK_CONFIRM_REQUIRED），构建直接失败
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS

  if (env.CTEXT_NO_MIRROR === '1') return env

  for (const [key, value] of Object.entries(MIRRORS)) {
    if (!env[key]) env[key] = value
  }
  return env
}
