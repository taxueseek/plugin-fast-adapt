// lib/host-discovery.mjs —— 本机 DSH 宿主发现（唯一真源）。
//
// 为什么单独成层：这段逻辑有 10 个消费方，其中 lib/host-modules.mjs 住在 lib/ 里。
// 放在 env-doctor.mjs（CLI 入口）时，lib/ 不得不反向 import ../env-doctor.mjs，
// 把「lib 不依赖 CLI 入口」这条分层规矩撕开一个口子，且顺带把 935 行的 CLI 模块
// 拽进依赖图。探测逻辑本身与任何 CLI 输出无关，收进 lib/ 后：
//   - lib/ 内部恢复成纯 DAG（不再有 ../ 向上边）；
//   - env-doctor.mjs 只做编排与输出，发现能力从这里 re-export，十个调用方零改动。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { readPackageJson } from './package-json.mjs'

// readPackageJson 的唯一真源在 lib/package-json.mjs（剥 BOM、三态探测都在那里）。
// 这里 re-export 是为了让既有调用方（env-doctor 及其十个消费方）继续从本模块取。
export { readPackageJson }

const HOME = os.homedir()
const SPAWN_SHELL = process.platform === 'win32'

let globalRootsCache = null

// platform/env 可注入，供自检做 Windows 模拟；带注入的调用不写缓存，
// 模拟结果不会污染本进程后续的真实探测。
export function candidateGlobalRoots({ platform = process.platform, env = process.env } = {}) {
  const simulated = platform !== process.platform || env !== process.env
  if (globalRootsCache && !simulated) return globalRootsCache
  const roots = [
    path.join(HOME, '.local', 'lib', 'node_modules'),
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
  ]
  // Android / Termux 移动端环境：$PREFIX 通常为 /data/data/com.termux/files/usr
  if (env.PREFIX) {
    roots.push(path.join(env.PREFIX, 'lib', 'node_modules'))
  }
  // 自定义 npm prefix (npm_config_prefix)
  if (env.npm_config_prefix) {
    roots.push(path.join(env.npm_config_prefix, 'lib', 'node_modules'))
    roots.push(path.join(env.npm_config_prefix, 'node_modules'))
  }
  // Windows npm 默认前缀是 %APPDATA%\npm，node_modules 在其下；
  // 先探这里可以免掉一次 npm spawn
  if (platform === 'win32' && env.APPDATA) {
    roots.push(path.join(env.APPDATA, 'npm', 'node_modules'))
  }
  try {
    const nvmDir = env.NVM_DIR || path.join(HOME, '.nvm')
    const versions = path.join(nvmDir, 'versions', 'node')
    if (fs.existsSync(versions)) {
      for (const v of fs.readdirSync(versions)) {
        roots.push(path.join(versions, v, 'lib', 'node_modules'))
      }
    }
  } catch {}
  if (!roots.some((r) => fs.existsSync(path.join(r, '@deepseek-ai')))) {
    try {
      const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', shell: SPAWN_SHELL }).trim()
      if (npmRoot) roots.push(npmRoot)
    } catch {}
  }
  const result = [...new Set(roots.filter(Boolean))]
  if (!simulated) globalRootsCache = result
  return result
}

// 向上查找局部 node_modules 中的宿主（适应 monorepo、独立工作区或本地依赖场景）
function findLocalDshInAncestors(startDir) {
  if (!startDir) return null
  let cur = path.resolve(startDir)
  for (let i = 0; i < 5; i++) {
    const cand = path.join(cur, 'node_modules', '@deepseek-ai', 'dsh')
    const pkg = readPackageJson(cand)
    if (pkg?.version) return { version: pkg.version, location: cand, source: 'local-ancestor-node_modules' }
    const parent = path.dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return null
}

// 导出供 code-scan 的宿主实测核查复用：guide 是二手语义，
// 目标宿主的 node_modules 是一手事实——包到底还在不在，stat 一次就知道。
// 支持环境变量注入 (DSH_HOST_PATH/DSH_LOCATION) 与从工作区向上回溯本地宿主。
export function findGlobalDsh(startDir = null) {
  // 1. 显式环境变量覆盖（CI、Docker、远程服务器与非标环境直接注入）
  const envPath = process.env.DSH_HOST_PATH || process.env.DSH_LOCATION
  if (envPath) {
    const pkg = readPackageJson(envPath)
    if (pkg?.version) return { version: pkg.version, location: path.resolve(envPath), source: 'env-override' }
  }

  // 2. 当前工作区及其父目录探测（局部安装、monorepo、无全局安装形态）
  const localHost = findLocalDshInAncestors(startDir || process.cwd())
  if (localHost) return localHost

  // 3. 全局 node_modules 候选根
  for (const root of candidateGlobalRoots()) {
    const pkg = readPackageJson(path.join(root, '@deepseek-ai', 'dsh'))
    if (pkg?.version) {
      return { version: pkg.version, location: path.join(root, '@deepseek-ai', 'dsh'), source: 'node_modules' }
    }
  }

  // 4. PATH 中的 CLI 兜底
  try {
    const out = execFileSync('dsh', ['--version'], { encoding: 'utf8', shell: SPAWN_SHELL }).trim()
    const m = out.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)
    if (m) return { version: m[1], location: null, source: 'dsh --version' }
  } catch {}
  return null
}
