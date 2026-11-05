// lib/peer-fix.mjs —— 机械可判的包面修补：把宿主核心包从 dependencies 挪进 peerDependencies。
//
// 为什么这类修补敢自动做：判据是纯机械的，且失败方向是「报错」而不是「静默改坏」。
// 上游常设规则把 cordis / schemastery / @deepseek-ai/dsh 这类宿主核心包限定在
// peerDependencies 或仅 devDependencies——写进 dependencies 会产生 vendored 多实例
// 污染（两个副本的 instanceof 互不认识）。这条不需要人的意图判断，照规则搬即可。
//
// 与 peerPatch / compatPatch 的分工：
//   peerPatch   改的是**已声明的 peer 范围**，让它覆盖目标宿主
//   compatPatch 改的是**准入账本**（dsh.compatibility / engines.dsh）
//   本模块改的是**字段位置**（dependencies → peerDependencies）
// 三者互不重叠，都是纯函数；落盘由调用方负责，默认 dry-run。

/** 只应出现在 peer/dev 里的宿主核心包。 */
export const PEER_ONLY_PACKAGES = [
  'cordis',
  'schemastery',
  'cosmokit',
  '@deepseek-ai/dsh',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/cosmokit',
]

/** 上游 docs/rescope.zh.md 官方 vendored 包改名映射表。 */
export const VENDOR_RESCOPE_MAP = {
  'cordis': '@deepseek-ai/cordis',
  'cosmokit': '@deepseek-ai/cosmokit',
  'schemastery': '@deepseek-ai/schemastery',
  '@cordisjs/plugin-loader': '@deepseek-ai/cordis-plugin-loader',
  '@cordisjs/plugin-include': '@deepseek-ai/cordis-plugin-include',
  '@cordisjs/plugin-group': '@deepseek-ai/cordis-plugin-group',
  '@cordisjs/plugin-timer': '@deepseek-ai/cordis-plugin-timer',
  '@cordisjs/plugin-hmr': '@deepseek-ai/cordis-plugin-hmr',
  '@cordisjs/plugin-logger-console': '@deepseek-ai/cordis-plugin-logger-console',
}

/** 本仓内部包的版本写法（上游按包族规定：宿主包 workspace:*，其余 workspace:~）。 */
function isHostScopePackage(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * 生成一次包面修补计划（纯函数，不碰磁盘）。
 * @param {object} pkg 解析后的 package.json 对象
 * @returns {{ moves: Array<object>, files: object, description: string }} 计划
 */
export function planPeerFix(pkg) {
  const deps = pkg?.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const moves = []
  for (const name of Object.keys(deps)) {
    if (!PEER_ONLY_PACKAGES.includes(name)) continue
    const range = String(deps[name])
    // 宿主套件子包用 workspace 写法，其余按原范围搬——搬位置不改范围，
    // 范围是否覆盖目标宿主是 peerPatch 的事，两件事不混在一起做
    const peerRange = range
    moves.push({
      package: name,
      from: `dependencies.${name} @ ${range}`,
      to: `peerDependencies.${name} @ ${peerRange}`,
      why: '宿主核心包写进 dependencies 会产生 vendored 多实例污染（两份副本的 instanceof 互不认识）',
    })
  }
  if (moves.length === 0) return { moves: [], files: {}, description: '无需修补' }

  const next = JSON.parse(JSON.stringify(pkg))
  next.peerDependencies = { ...(next.peerDependencies || {}) }
  next.devDependencies = { ...(next.devDependencies || {}) }
  for (const m of moves) {
    const range = next.dependencies[m.package]
    delete next.dependencies[m.package]
    // peer 已声明同版本时不覆盖；devDependencies 保留开发期类型支持
    if (next.peerDependencies[m.package] === undefined) next.peerDependencies[m.package] = range
    if (next.devDependencies[m.package] === undefined) next.devDependencies[m.package] = range
  }
  // 空对象就别留在包面里
  if (Object.keys(next.dependencies).length === 0) delete next.dependencies

  return {
    moves,
    files: { 'package.json': `${JSON.stringify(next, null, 2)}\n` },
    description: `把 ${moves.length} 个宿主核心包从 dependencies 挪进 peerDependencies（devDependencies 保留开发期类型支持）`,
  }
}

/**
 * 这个包名是否属于宿主套件（用于判断 peer 范围该用什么写法）。
 * @param {string} name 包名
 * @returns {boolean} 是否宿主套件
 */
export function isHostSuitePackage(name) {
  return isHostScopePackage(name)
}
