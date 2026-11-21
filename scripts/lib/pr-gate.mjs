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
import { cacheRoot } from './cache-root.mjs'

export const PR_BASELINE_STATES = Object.freeze({
  READY: 'ready',
  READY_WITH_LOCAL_CHANGES: 'ready-with-local-changes',
  OFFLINE_CLEAN: 'offline-clean',
  BEHIND_UPSTREAM: 'behind-upstream',
  DIRTY: 'dirty',
  NPM_AHEAD: 'npm-ahead',
  NO_REMOTE: 'no-remote',
  REMOTE_UNREACHABLE: 'remote-unreachable',
})

const SPAWN_SHELL = process.platform === 'win32'
const NPM_PKG_TTL_MS = 60 * 60 * 1000

function npmPkgCachePath() {
  return path.join(cacheRoot(), 'npm-pkg-versions.json')
}

function readCachedPkgVersion(pkgName, maxAgeMs = NPM_PKG_TTL_MS) {
  try {
    const all = JSON.parse(fs.readFileSync(npmPkgCachePath(), 'utf8'))
    const entry = all?.[pkgName]
    if (entry && typeof entry.at === 'number' && Date.now() - entry.at < maxAgeMs) {
      return { hit: true, version: entry.version ?? null }
    }
  } catch {}
  return { hit: false, version: null }
}

function writeCachedPkgVersion(pkgName, version) {
  try {
    const file = npmPkgCachePath()
    let all = {}
    try {
      all = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {}
    all[pkgName] = { version: version ?? null, at: Date.now() }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(all))
  } catch {}
}

function runGit(dir, args, timeout = 5000) {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: gitChildEnv().env,
    timeout,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function isInsideGitWorkTree(dir) {
  if (!dir || !fs.existsSync(dir)) return false
  if (fs.existsSync(path.join(dir, '.git'))) return true
  try {
    return runGit(dir, ['rev-parse', '--is-inside-work-tree'], 2000) === 'true'
  } catch {
    return false
  }
}

function fetchNpmLatestVersion(pkgName) {
  const cached = readCachedPkgVersion(pkgName)
  if (cached.hit) return cached.version
  try {
    const out = execFileSync('npm', ['view', pkgName, 'version'], {
      encoding: 'utf8',
      shell: SPAWN_SHELL,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const version = out || null
    writeCachedPkgVersion(pkgName, version)
    return version
  } catch {
    return null
  }
}

/**
 * 异步原生 fetch 查询 npm 最新版（带 1h 缓存，避免同步 spawn npm view ~1s/次）。
 * @param {string} pkgName
 * @param {{ fetcher?: typeof fetch }} [opts]
 */
export async function fetchNpmLatestVersionAsync(pkgName, { fetcher = null } = {}) {
  const cached = readCachedPkgVersion(pkgName)
  if (cached.hit) return cached.version
  const doFetch = fetcher || ((url, init) => fetch(url, init))
  try {
    const encoded = encodeURIComponent(pkgName).replace('%40', '@')
    const res = await doFetch(`https://registry.npmjs.org/${encoded}/latest`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) {
      if (res.status === 404) writeCachedPkgVersion(pkgName, null)
      return null
    }
    const data = await res.json()
    const version = typeof data?.version === 'string' ? data.version : null
    writeCachedPkgVersion(pkgName, version)
    return version
  } catch {
    return null
  }
}

function readDiffStat(dir) {
  try {
    return runGit(dir, ['diff', '--stat'], 3000) || null
  } catch {
    return null
  }
}

function finalizeBaseline({ pluginDir, offline, dirty, remote, localHead, remoteHead, pkg, npmVersion, allowDirtyOnHead }) {
  if (!offline && npmVersion && pkg?.version && compareVersions(npmVersion, pkg.version) > 0) {
    return {
      status: PR_BASELINE_STATES.NPM_AHEAD,
      ready: false,
      upstreamUpdated: true,
      remote,
      localHead,
      remoteHead,
      localVersion: pkg.version,
      npmVersion,
      reason: `npm 最新版 (${npmVersion}) 高于本地 (${pkg.version})，上游可能已发新版修复`,
      action: 'git pull --ff-only',
    }
  }

  if (dirty) {
    if (allowDirtyOnHead) {
      return {
        status: PR_BASELINE_STATES.READY_WITH_LOCAL_CHANGES,
        ready: true,
        dirty: true,
        verifiedRemote: !offline,
        diffStat: readDiffStat(pluginDir),
        remote,
        localHead,
        remoteHead,
        localVersion: pkg?.version ?? null,
        npmVersion,
        reason: offline
          ? '本地存在未提交适配改动（离线模式，未核对远端）'
          : '本地基线与上游 origin/HEAD 一致，当前工作区含待提交的本地适配改动',
        action: null,
      }
    }
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

  if (offline) {
    return {
      status: PR_BASELINE_STATES.OFFLINE_CLEAN,
      ready: true,
      verifiedRemote: false,
      remote,
      localHead,
      remoteHead,
      localVersion: pkg?.version ?? null,
      npmVersion,
      reason: '工作区干净（离线模式，未核对远端）',
      action: null,
    }
  }

  return {
    status: PR_BASELINE_STATES.READY,
    ready: true,
    verifiedRemote: true,
    remote,
    localHead,
    remoteHead,
    localVersion: pkg?.version ?? null,
    npmVersion,
    reason: '本地与上游 origin/HEAD 一致且工作区干净',
    action: null,
  }
}

function inspectGitState(pluginDir, { offline = false } = {}) {
  if (!isInsideGitWorkTree(pluginDir)) {
    return {
      earlyReturn: {
        status: PR_BASELINE_STATES.NO_REMOTE,
        ready: false,
        reason: '目标目录不是 Git 仓库',
        action: null,
      },
    }
  }

  let remote = null
  let localHead = null
  try {
    remote = runGit(pluginDir, ['remote', 'get-url', 'origin'], 3000)
    localHead = runGit(pluginDir, ['rev-parse', 'HEAD'], 3000)
  } catch {
    return {
      earlyReturn: {
        status: PR_BASELINE_STATES.NO_REMOTE,
        ready: false,
        reason: '缺少 origin 远端或无法解析 HEAD',
        action: null,
      },
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
        earlyReturn: {
          status: PR_BASELINE_STATES.REMOTE_UNREACHABLE,
          ready: false,
          remote,
          localHead,
          reason: '无法访问 origin 远端（网络不可达或无权限），无法确认是否最新',
          action: null,
        },
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
          earlyReturn: {
            status: PR_BASELINE_STATES.BEHIND_UPSTREAM,
            ready: false,
            upstreamUpdated: true,
            remote,
            localHead,
            remoteHead,
            reason: `本地 HEAD (${localHead.slice(0, 7)}) 落后于上游 origin/HEAD (${remoteHead.slice(0, 7)})`,
            action: 'git pull --ff-only',
          },
        }
      }
    }
  }

  return { earlyReturn: null, remote, localHead, remoteHead, dirty }
}

/**
 * 核查插件目录是否满足「可向原仓提 PR」的基线前提（只读，不修改目标仓库）。
 * @param {string} pluginDir
 * @param {{ offline?: boolean, checkNpm?: boolean, allowDirtyOnHead?: boolean, npmVersionFetcher?: (name: string) => string|null }} [opts]
 */
export function checkPrBaseline(
  pluginDir,
  { offline = false, checkNpm = true, allowDirtyOnHead = false, npmVersionFetcher = null } = {},
) {
  const gitState = inspectGitState(pluginDir, { offline })
  if (gitState.earlyReturn) return gitState.earlyReturn

  const pkg = readPackageJson(pluginDir)
  let npmVersion = null
  if (!offline && checkNpm && pkg?.name && pkg?.version) {
    npmVersion = npmVersionFetcher ? npmVersionFetcher(pkg.name) : fetchNpmLatestVersion(pkg.name)
  }

  return finalizeBaseline({
    pluginDir,
    offline,
    dirty: gitState.dirty,
    remote: gitState.remote,
    localHead: gitState.localHead,
    remoteHead: gitState.remoteHead,
    pkg,
    npmVersion,
    allowDirtyOnHead,
  })
}

/**
 * 异步版基线核查：npm 查询走原生 fetch + 1h 缓存，供 fleet-sweep --pr-ready 与 run.mjs --check-upstream 并发调用。
 */
export async function checkPrBaselineAsync(
  pluginDir,
  { offline = false, checkNpm = true, allowDirtyOnHead = false, fetcher = null } = {},
) {
  const gitState = inspectGitState(pluginDir, { offline })
  if (gitState.earlyReturn) return gitState.earlyReturn

  const pkg = readPackageJson(pluginDir)
  let npmVersion = null
  if (!offline && checkNpm && pkg?.name && pkg?.version) {
    npmVersion = await fetchNpmLatestVersionAsync(pkg.name, { fetcher })
  }

  return finalizeBaseline({
    pluginDir,
    offline,
    dirty: gitState.dirty,
    remote: gitState.remote,
    localHead: gitState.localHead,
    remoteHead: gitState.remoteHead,
    pkg,
    npmVersion,
    allowDirtyOnHead,
  })
}
