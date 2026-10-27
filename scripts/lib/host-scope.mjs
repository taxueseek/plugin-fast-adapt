// lib/host-scope.mjs —— 宿主安装位的路径解析（code-scan 与 seams 共用）。
//
// 为什么单独一个模块：宿主套件子包（dsh-*）的实际位置在宿主主包内部
//   <nm>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*
// 而不是 npm 全局根的下一级。旧实现取 dirname(dirname(location)) 落在
// <nm>，查 dsh-api-gateway / dsh-client-ui-settings / dsh-client-ui-renderer
// 这类真实存在的套件包全部报 absent，结论退化成「本来就不存在，或名字拼写
// 有误」——假阴性。2026-10-27 本机实测（宿主 0.2.1-rc.3，305 个套件子包）。
//
// 判据用「目录存在」而不是「包名推导」：套件子包名不总是 dsh-*（如
// @deepseek-ai/cordis、cosmokit），推导会漏；目录存在是唯一一手事实。

import fs from 'node:fs'
import path from 'node:path'

// 候选作用域按优先级返回（都已是 @deepseek-ai 目录，调用方直接拼包名）：
//   1. 宿主主包内部套件目录（真实位置，npm 全局安装与 pnpm 都成立）
//   2. 全局 node_modules 的 @deepseek-ai 目录（兜住把套件包平铺安装的宿主形态）
export function hostScopes(hostInfo) {
  if (!hostInfo?.location) return []
  const pkgDir = hostInfo.location
  const scope = path.dirname(path.dirname(pkgDir)) // …/node_modules/@deepseek-ai/dsh → …/node_modules
  const candidates = [
    path.join(pkgDir, 'node_modules', '@deepseek-ai'),
    path.join(scope, '@deepseek-ai'),
  ]
  const seen = new Set()
  return candidates.filter((dir) => {
    if (seen.has(dir)) return false
    seen.add(dir)
    return fs.existsSync(dir)
  })
}

// 包是否还在目标宿主的安装目录里。命中第一个存在的作用域，checkedWhere
// 记实际解析到的位置（不是候选拼接路径）——结论可回溯到磁盘。
// pkgName 收裸名（dsh-api-gateway）或 @scope/name 全写：作用域目录已是
// @deepseek-ai，全写形式要先剥掉 scope 前缀，否则会拼出
// …/@deepseek-ai/@deepseek-ai/dsh-api-gateway 这种假路径。
export function packageOnHost(pkgName, hostInfo) {
  const scopes = hostScopes(hostInfo)
  if (!scopes.length) return { status: 'unknown', checkedWhere: null }
  const bare = String(pkgName).replace(/^@deepseek-ai\//, '')
  for (const scope of scopes) {
    const dir = path.join(scope, bare)
    if (fs.existsSync(path.join(dir, 'package.json'))) return { status: 'present', checkedWhere: dir }
  }
  return { status: 'absent', checkedWhere: path.join(scopes[0], bare) }
}

// 符号在宿主套件源码里的文本搜索根。返回数组：主包自身 + 每个套件作用域。
// 旧实现只搜 dirname(location)（= @deepseek-ai 目录），套件子包在嵌套
// node_modules 下时搜不到，零命中被当成「不存在」的弱证据。
export function symbolSearchRoots(hostInfo) {
  if (!hostInfo?.location) return []
  const roots = [hostInfo.location]
  for (const scope of hostScopes(hostInfo)) roots.push(scope)
  return roots
}
