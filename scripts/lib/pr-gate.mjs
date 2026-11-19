// pr-gate.mjs —— 向其他插件提 PR 前的基线真源守卫（Git origin/HEAD + npm 最新版 + 工作区干净度）。
//
// 第一性原理：向外部仓库提 PR 只有一个前提——本地代码与上游最新基线一致，
// 且在该基线上复测问题仍然存在。基于过期本地副本建分支必导致上游分叉。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gitChildEnv } from './proc-env.mjs'
import { readPackageJson } from './package-json.mjs'
import { compareVersions } from './scanner.mjs'

export const PR_BASELINE_STATES = Object.freeze({
  READY: 'ready',
  BEHIND_UPSTREAM: 'behind-upstream',
  DIRTY: 'dirty',
  NPM_AHEAD: 'npm-ahead',
  NO_REMOTE: 'no-remote',
  REMOTE_UNREACHABLE: 'remote-unreachable',
})

const SPAWN_SHELL = process.platform === 'win32'

function runGit(dir, args, timeout = 5000) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: gitChildEnv().env,
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function fetchNpmLatestVersion(pkgName) {
  try {
    const out = execFileSync('npm', ['view', pkgName, 'version'], {
      encoding: 'utf8',
      shell: SPAWN_SHELL,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/**
 * 核查插件目录是否满足「可向原仓提 PR」的基线前提（只读，不修改目标仓库）。
 * @param {string} pluginDir
 * @param {{ offline?: boolean, checkNpm?: boolean, npmVersionFetcher?: (name: string) => string|null }} [opts]
 */
export function checkPrBaseline(pluginDir, { offline = false, checkNpm = true, npmVersionFetcher = null } = {}) {
  if (!pluginDir || !fs.existsSync(path.join(pluginDir, '.git'))) {
    return {
      status: PR_BASELINE_STATES.NO_REMOTE,
      ready: false,
      reason: '目标目录不是 Git 仓库',
      action: null,
    }
  }

  let remote = null
  let localHead = null
  try {
    remote = runGit(pluginDir, ['remote', 'get-url', 'origin'], 3000)
    localHead = runGit(pluginDir, ['rev-parse', 'HEAD'], 3000)
  } catch {
    return {
      status: PR_BASELINE_STATES.NO_REMOTE,
      ready: false,
      reason: '缺少 origin 远端或无法解析 HEAD',
      action: null,
    }
  }

  let dirty = false
  try {
    const st = runGit(pluginDir, ['status', '--porcelain'], 3000)
    dirty = st.length > 0
  } catch {}

  let remoteHead = null
  if (!offline) {
    try {
      const out = runGit(pluginDir, ['ls-remote', 'origin', 'HEAD'], 6000)
      remoteHead = out.split(/\s+/)[0] || null
    } catch {
      return {
        status: PR_BASELINE_STATES.REMOTE_UNREACHABLE,
        ready: false,
        remote,
        localHead,
        reason: '无法访问 origin 远端（网络不可达或无权限），无法确认是否最新',
        action: null,
      }
    }

    if (remoteHead && localHead !== remoteHead) {
      let aheadOnly = false
      try {
        runGit(pluginDir, ['merge-base', '--is-ancestor', remoteHead, 'HEAD'], 3000)
        aheadOnly = true
      } catch {}
      if (!aheadOnly) {
        return {
          status: PR_BASELINE_STATES.BEHIND_UPSTREAM,
          ready: false,
          remote,
          localHead,
          remoteHead,
          reason: `本地 HEAD (${localHead.slice(0, 7)}) 落后于上游 origin/HEAD (${remoteHead.slice(0, 7)})`,
          action: 'git pull --ff-only',
        }
      }
    }
  }

  const pkg = readPackageJson(pluginDir)
  let npmVersion = null
  if (!offline && checkNpm && pkg?.name && pkg?.version) {
    npmVersion = npmVersionFetcher ? npmVersionFetcher(pkg.name) : fetchNpmLatestVersion(pkg.name)
    if (npmVersion && compareVersions(npmVersion, pkg.version) > 0) {
      return {
        status: PR_BASELINE_STATES.NPM_AHEAD,
        ready: false,
        remote,
        localHead,
        remoteHead,
        localVersion: pkg.version,
        npmVersion,
        reason: `npm 最新版 (${npmVersion}) 高于本地 (${pkg.version})，上游可能已发新版修复`,
        action: 'git pull --ff-only',
      }
    }
  }

  if (dirty) {
    return {
      status: PR_BASELINE_STATES.DIRTY,
      ready: false,
      remote,
      localHead,
      remoteHead,
      localVersion: pkg?.version ?? null,
      npmVersion,
      reason: '工作区存在未提交改动，请先清理或暂存后再基于干净基线建 PR 分支',
      action: 'git status',
    }
  }

  return {
    status: PR_BASELINE_STATES.READY,
    ready: true,
    remote,
    localHead,
    remoteHead,
    localVersion: pkg?.version ?? null,
    npmVersion,
    reason: offline ? '工作区干净（离线模式，未核对远端）' : '本地与上游 origin/HEAD 一致且工作区干净',
    action: null,
  }
}
