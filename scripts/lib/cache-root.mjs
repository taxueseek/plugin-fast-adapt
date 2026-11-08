// lib/cache-root.mjs —— 缓存根的唯一真源。
//
// 为什么单独成层：缓存根此前在四个文件里各写一遍（types-diff、guide-sync、
// seams、guide-parser），其中只有 guide-sync 支持环境变量覆盖。后果是自检
// 无法把 types-diff 的签名缓存隔离到临时目录——`签名本地缓存存取闭环` 这条
// 用例会去写真实 ~/.cache，在只读 HOME 或沙箱里直接 EPERM 失败，而同一份
// 自检里 runlog 早已支持 DSH_PFA_RUNS_DIR 注入。同一个仓两套隔离标准，
// 自检结果就依赖机器状态。
//
// 优先级：DSH_PFA_CACHE_DIR（本工具专用，自检与容器用）> DSH_CACHE_DIR（旧名，
// 保持兼容）> XDG_CACHE_HOME > ~/.cache。

import os from 'node:os'
import path from 'node:path'

/**
 * 缓存根目录。每次调用时求值，自检可以在用例里改环境变量后立即生效。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function cacheRoot(env = process.env) {
  if (env.DSH_PFA_CACHE_DIR) return env.DSH_PFA_CACHE_DIR
  if (env.DSH_CACHE_DIR) return env.DSH_CACHE_DIR
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'dsh-plugin-fast-adapt')
  return path.join(os.homedir(), '.cache', 'dsh-plugin-fast-adapt')
}

/**
 * 缓存根下的子目录。
 * @param {string} name 子目录名
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function cacheSubdir(name, env = process.env) {
  return path.join(cacheRoot(env), name)
}
