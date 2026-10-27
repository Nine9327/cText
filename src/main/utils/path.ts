/**
 * 用户手输/粘贴路径的清洗（M1-07 排查修复）。
 *
 * 资源管理器「复制文件地址」给出的是 `"D:\books"`——**带引号**。
 * 引号只被 `trim()` 碰不到，而以引号开头的东西在 Windows 上不是合法的
 * 路径根，`path.resolve` 会把它当**相对路径**拼到应用自己的目录上
 * （比如 `D:\project\cText\"D:\books"`）。用户看到的报错是
 * 「目录不存在、不是文件夹，或当前无法访问」，完全无法联想到是引号的锅。
 *
 * 所以引号必须在这里剥掉。这是粘贴路径最常见的形态，拖放进来的路径
 * 不带引号，不受影响。
 */
export function sanitizeInputPath(input: string): string {
  const trimmed = input.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}
