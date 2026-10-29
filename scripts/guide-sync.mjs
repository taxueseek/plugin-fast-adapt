#!/usr/bin/env node
// guide-sync.mjs —— 第 2、3 步：定版本 + 取官方升级指南。
//
// 两件事：
//   A. 从 npm registry 读 @deepseek-ai/dsh 的 dist-tags，启发式判断本机该跟哪个版本。
//   B. 取该版本的官方 upgrade-guide（权威破坏性变更清单），缓存到本地。
//
// 启发式（不盲目取 latest）：
//   本机版本可能跑在 next/alpha 线上，比 latest 还新。
//   所以先判断本机在官方通道里的位置，再决定有没有「下一个」可跟。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { printJson, compareVersions } from './lib/scanner.mjs'
import { listGuideVersions } from './lib/guide-parser.mjs'
import { findGlobalDsh } from './env-doctor.mjs'

// dist-tags 专用端点只回标签对象（实测 67 字节）；全量包文档是 267KB，
// 而这里只用到 dist-tags，网络、解析、缓存落盘全是白付的。
const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags'
const HARNESS_REPO = 'https://github.com/deepseek-ai/deepseek-harness.git'
const CACHE_ROOT =
  process.env.DSH_CACHE_DIR ||
  (process.env.XDG_CACHE_HOME
    ? path.join(process.env.XDG_CACHE_HOME, 'dsh-plugin-fast-adapt')
    : path.join(os.homedir(), '.cache', 'dsh-plugin-fast-adapt'))
// tag 是冻结快照，官方在发版后还会把同版本的指南补全到默认分支
// （2026-10-27 实测：dsh-v0.2.1-rc.3 tag 里 v0.2.1-rc.2 只有 1 条变更，
// 默认分支同一目录 23 条；tag 之后新增的 rc.3 指南只存在于分支上）。
// 默认克隆远端 HEAD 指向的分支（上游是 master，不写死）；需要固定分支时用
// DSH_HARNESS_BRANCH 指定。
const GUIDES_BRANCH = process.env.DSH_HARNESS_BRANCH || null

// ── A. 版本解析 ────────────────────────────────────────────────────────────

// dist-tags 数天才变一次，没必要每次都打网络。缓存 1 小时；
// 网络失败时有过期缓存也降级用，明确标 stale，绝不静默装作新鲜。
const METADATA_CACHE = path.join(CACHE_ROOT, 'npm-metadata.json')
const METADATA_TTL_MS = 60 * 60 * 1000

export async function fetchNpmMetadata({ fetcher = null, maxAgeMs = METADATA_TTL_MS, cachePath = METADATA_CACHE } = {}) {
  const cached = readCachedMetadata(cachePath)
  if (cached && Date.now() - cached.fetchedAt < maxAgeMs) {
    return { ...cached.data, _metadataSource: 'cache' }
  }

  const doFetch = fetcher || ((url, init) => fetch(url, init))
  try {
    const res = await doFetch(DIST_TAGS_URL, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`npm registry 返回 ${res.status}`)
    const tags = await res.json()
    if (!tags || typeof tags !== 'object' || !Object.keys(tags).length) {
      throw new Error('dist-tags 响应为空')
    }
    // 缓存仍存 {'dist-tags': {...}} 形状，旧版全量文档缓存可直接续用
    const data = { 'dist-tags': tags }
    writeCachedMetadata(cachePath, { fetchedAt: Date.now(), data })
    return { ...data, _metadataSource: 'network' }
  } catch (err) {
    if (cached) return { ...cached.data, _metadataSource: 'stale-cache' }
    throw err
  }
}

function readCachedMetadata(cachePath = METADATA_CACHE) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (typeof raw.fetchedAt === 'number' && raw.data?.['dist-tags']) return raw
  } catch {}
  return null
}

function writeCachedMetadata(cachePath, entry) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(cachePath, JSON.stringify(entry))
  } catch {
    // 缓存写不进去不影响主流程，下次再试
  }
}

// 本机版本 → 官方通道位置 → 建议目标
export function resolveTargetVersion(localVersion, distTags) {
  const channels = ['latest', 'next', 'alpha'].filter((c) => distTags?.[c])
  const channelEntries = channels.map((c) => ({ channel: c, version: distTags[c] }))

  if (!localVersion) {
    return {
      verdict: 'unknown-local',
      localVersion: null,
      channels: channelEntries,
      target: distTags?.latest || null,
      reason: '未检测到本机 DSH 版本，默认跟随 latest。',
    }
  }

  const newer = channelEntries
    .filter((c) => compareVersions(c.version, localVersion) > 0)
    .sort((a, b) => compareVersions(a.version, b.version))

  const onChannel = channelEntries.find((c) => compareVersions(c.version, localVersion) === 0)

  if (onChannel) {
    return {
      verdict: 'up-to-date-on-channel',
      localVersion,
      channels: channelEntries,
      currentChannel: onChannel.channel,
      target: null,
      reason: `本机 ${localVersion} 已是官方 ${onChannel.channel} 通道的最新版，官方无更高版本可跟。`,
    }
  }

  if (!newer.length) {
    const maxChannel = [...channelEntries].sort((a, b) => compareVersions(b.version, a.version))[0]
    return {
      verdict: 'ahead-of-upstream',
      localVersion,
      channels: channelEntries,
      target: null,
      reason: `本机 ${localVersion} 高于官方所有通道（最高 ${maxChannel?.version}），无需升级。`,
    }
  }

  // target 取官方所有通道的最高版本，不是「比本机新的最低一个」：
  // 后者在多通道场景会选中 alpha 这类低质量通道（实测 0.1.0-rc.6 → alpha.5，
  // 而宿主实际跑的是 next 的 rc.3），适配目标跟着宿主真实版本走才有意义。
  const target = [...channelEntries].sort((a, b) => compareVersions(b.version, a.version))[0]
  return {
    verdict: 'upgrade-available',
    localVersion,
    channels: channelEntries,
    target: target.version,
    targetChannel: target.channel,
    reason: `本机 ${localVersion} → 官方最高 ${target.channel} 通道的 ${target.version}。`,
  }
}

// ── B. 指南获取 ────────────────────────────────────────────────────────────

function cacheDirFor(version, cacheRoot = CACHE_ROOT) {
  return path.join(cacheRoot, `harness-dsh-v${version}`)
}

// 本机可能已有 harness clone，优先复用，省一次网络
// 覆盖：环境变量、当前工作区同级/子级、常见开发者根（workspace/projects）与 Documents
function findLocalClone(startDir = process.cwd()) {
  const candidates = []
  const envClone = process.env.DSH_HARNESS_CLONE
  if (envClone) candidates.push(envClone)

  // 1. 当前工作区周边（同级/下级）
  candidates.push(path.resolve(startDir, 'deepseek-harness'))
  candidates.push(path.resolve(startDir, '..', 'deepseek-harness'))
  candidates.push(path.resolve(startDir, '..', '..', 'deepseek-harness'))

  // 2. 常见开发根目录（Linux/macOS/容器通用）
  const home = os.homedir()
  candidates.push(path.join(home, 'deepseek-harness'))
  candidates.push(path.join(home, 'workspace', 'deepseek-harness'))
  candidates.push(path.join(home, 'projects', 'deepseek-harness'))

  // 3. Documents 子目录兜底
  try {
    const docs = path.join(home, 'Documents')
    if (fs.existsSync(docs)) {
      for (const entry of fs.readdirSync(docs, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(docs, entry.name, 'deepseek-harness'))
      }
    }
  } catch {}

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'docs', 'upgrade-guide'))) return dir
  }
  return null
}

export function syncGuides(targetVersion, { localClone = null, cacheRoot = CACHE_ROOT } = {}) {
  const cacheDir = cacheDirFor(targetVersion, cacheRoot)

  if (fs.existsSync(path.join(cacheDir, 'docs', 'upgrade-guide'))) {
    return {
      source: 'cache',
      root: path.join(cacheDir, 'docs', 'upgrade-guide'),
      versions: listGuideVersions(path.join(cacheDir, 'docs', 'upgrade-guide')),
    }
  }

  if (localClone) {
    const root = path.join(localClone, 'docs', 'upgrade-guide')
    if (fs.existsSync(root)) {
      return { source: 'local-clone', root, versions: listGuideVersions(root) }
    }
  }

  return { source: 'unavailable', root: null, versions: [] }
}

// 分支快照：默认分支的 docs/upgrade-guide 是持续生长的权威树，tag 只是冻结切片。
// 受管 clone 按 TTL 刷新（git fetch + reset，实测约 1 秒；冷拉约 4.8 秒），
// 刷新失败时明确标 stale 继续用旧快照，不静默假装新鲜，也不退回 tag 的缺页版本。
const SNAPSHOT_DIR = 'harness-guides-branch'
const SNAPSHOT_META = '.pfa-snapshot.json'
const SNAPSHOT_TTL_MS = METADATA_TTL_MS

function snapshotDirFor(cacheRoot) {
  return path.join(cacheRoot, SNAPSHOT_DIR)
}

function snapshotMetaPath(dir) {
  return path.join(dir, SNAPSHOT_META)
}

export function readSnapshotMeta(dir) {
  try {
    const meta = JSON.parse(fs.readFileSync(snapshotMetaPath(dir), 'utf8'))
    return typeof meta?.fetchedAt === 'number' ? meta : null
  } catch {
    return null
  }
}

function writeSnapshotMeta(dir, meta) {
  fs.writeFileSync(snapshotMetaPath(dir), JSON.stringify(meta))
}

function headCommit(dir) {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: 'pipe', timeout: 20000 }).trim()
}

function headBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: 'pipe', timeout: 20000 }).trim()
  } catch {
    return null
  }
}

function snapshotResult(dir, source, meta = readSnapshotMeta(dir)) {
  const root = path.join(dir, 'docs', 'upgrade-guide')
  return {
    source,
    root,
    versions: listGuideVersions(root),
    commit: meta?.commit ?? null,
    fetchedAt: meta?.fetchedAt ?? null,
    branch: meta?.branch ?? GUIDES_BRANCH,
    stale: source === 'branch-snapshot-stale',
  }
}

// 返回的 source 四态：
//   branch-snapshot        命中 TTL 内的快照
//   branch-snapshot-refresh 刷新成功
//   branch-snapshot-stale   刷新失败，用旧快照并标 stale
//   unavailable            没有快照且拉取失败（error 带原文）
export function syncBranchSnapshot({
  cacheRoot = CACHE_ROOT,
  branch = GUIDES_BRANCH,
  maxAgeMs = SNAPSHOT_TTL_MS,
  now = Date.now(),
  allowRefresh = true,
} = {}) {
  const dir = snapshotDirFor(cacheRoot)
  const root = path.join(dir, 'docs', 'upgrade-guide')
  const meta = readSnapshotMeta(dir)
  // branch=null 表示跟远端 HEAD 的默认分支；只在显式指定时才校验分支名
  const fresh = meta && (!branch || meta.branch === branch) && now - meta.fetchedAt < maxAgeMs

  if (fs.existsSync(root) && fresh) return snapshotResult(dir, 'branch-snapshot', meta)

  if (fs.existsSync(root)) {
    if (!allowRefresh) {
      return { ...snapshotResult(dir, 'branch-snapshot-stale', meta), error: '快照已过期且本轮不允许刷新' }
    }
    try {
      const fetchArgs = ['-C', dir, 'fetch', '--depth', '1', 'origin']
      if (branch) fetchArgs.push(branch)
      execFileSync('git', fetchArgs, { stdio: 'pipe', timeout: 120000 })
      execFileSync('git', ['-C', dir, 'reset', '--hard', 'FETCH_HEAD'], { stdio: 'pipe', timeout: 60000 })
      const refreshed = { commit: headCommit(dir), fetchedAt: now, branch: headBranch(dir) }
      writeSnapshotMeta(dir, refreshed)
      return snapshotResult(dir, 'branch-snapshot-refresh', refreshed)
    } catch (err) {
      return {
        ...snapshotResult(dir, 'branch-snapshot-stale', meta),
        error: `分支快照刷新失败，继续用 ${meta?.commit ?? '未知提交'}：${err.message}`,
      }
    }
  }

  if (!allowRefresh) {
    return { source: 'unavailable', root: null, versions: [], error: '无本地分支快照且本轮不允许联网' }
  }

  // 上次中断可能留下没有 docs/upgrade-guide 的半成品目录，rename 还会撞名；
  // 受管缓存可再生，先清掉再拉，避免一次失败把后续分支快照永久卡死。
  if (fs.existsSync(dir) && !fs.existsSync(root)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  fs.mkdirSync(path.dirname(dir), { recursive: true })
  const tmp = `${dir}.tmp-${process.pid}`
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
    const cloneArgs = ['clone', '--depth', '1', '--filter=blob:none', '--sparse']
    if (branch) cloneArgs.push('--branch', branch)
    cloneArgs.push(HARNESS_REPO, tmp)
    execFileSync('git', cloneArgs, { stdio: 'pipe', timeout: 120000 })
    // HEAD 被稀疏克隆后是 detached；记实际分支名只用于排查
    const created = { commit: headCommit(tmp), fetchedAt: now, branch: headBranch(tmp) }
    execFileSync('git', ['sparse-checkout', 'set', 'docs/upgrade-guide'], { cwd: tmp, stdio: 'pipe', timeout: 120000 })
    writeSnapshotMeta(tmp, created)
    try {
      fs.renameSync(tmp, dir)
    } catch (err) {
      // 并发进程先一步建好了同名快照：删掉自己的临时目录，直接用现成的
      if (!fs.existsSync(root)) throw err
      fs.rmSync(tmp, { recursive: true, force: true })
      return snapshotResult(dir, 'branch-snapshot')
    }
    return snapshotResult(dir, 'branch-snapshot', created)
  } catch (err) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    return { source: 'unavailable', root: null, versions: [], error: `拉取分支指南失败（${branch || '默认分支'}）：${err.message}` }
  }
}

// 取版锚点：显式窗口目标优先（run.mjs 扫的是「窗口终点」不是「官方最新」），
// 其次官方目标版本；本机已在官方通道最新版时退回本机版本。
// 旧实现只按官方目标取指南：npm 刚发版、上游 tag 还没打时，明明本机宿主有可用的
// 指南快照，也会去拉一个不存在的 tag，整段扫描静默跳过（2026-10-27 rc.4 实录）。
export function guideVersionFor(resolution, localVersion, distTags, targetVersion = null) {
  return targetVersion || resolution?.target || localVersion || distTags?.latest || null
}

// 本机 clone 只要有 docs/upgrade-guide 就当语料（只读，不 fetch）。
// 它可能落后于目标版本，但覆盖度由上层按版本算，落后会显式报 incomplete；
// 这里不再用「覆盖到目标」当准入门槛——那会把用户手里最新的一份 clone 浪费掉。
function localCloneGuides(localClone) {
  if (!localClone) return null
  const root = path.join(localClone, 'docs', 'upgrade-guide')
  if (!fs.existsSync(root)) return null
  return { source: 'local-clone', root, versions: listGuideVersions(root) }
}

// 真正拉取（需要网络）。用 sparse clone 只取 docs/upgrade-guide。
export function cloneGuides(targetVersion, { cacheRoot = CACHE_ROOT } = {}) {
  const tag = `dsh-v${targetVersion}`
  const dest = cacheDirFor(targetVersion, cacheRoot)

  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp-${process.pid}`

  try {
    execFileSync('git', ['clone', '--depth', '1', '--branch', tag, '--filter=blob:none', '--sparse', HARNESS_REPO, tmp], {
      stdio: 'pipe',
      timeout: 120000,
    })
    execFileSync('git', ['sparse-checkout', 'set', 'docs/upgrade-guide'], { cwd: tmp, stdio: 'pipe' })
    fs.renameSync(tmp, dest)
  } catch (err) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
    throw new Error(`拉取官方指南失败（tag ${tag}）：${err.message}`)
  }

  return { source: 'clone', root: path.join(dest, 'docs', 'upgrade-guide'), versions: listGuideVersions(path.join(dest, 'docs', 'upgrade-guide')) }
}

// 否定缓存：npm 发版先于 harness 打 tag（2026-10-27 实测 rc.4 已上 npm 20 多小时，
// tag 仍不存在），这期间每次 run 都重试一次注定失败的 clone，白花约 0.9s。
// 只记「远端没有这个 tag」，网络类失败不记；TTL 与 dist-tags 缓存相同，
// dist-tags 变了也立即作废（上游可能刚补了 tag 又发了新版）。
const MISSING_TAG_RE = /Remote branch \S+ not found/

function missingTagCachePath(cacheRoot) {
  return path.join(cacheRoot, 'missing-tags.json')
}

export function readMissingTag(tag, distTags, { cacheRoot = CACHE_ROOT, maxAgeMs = METADATA_TTL_MS } = {}) {
  try {
    const entry = JSON.parse(fs.readFileSync(missingTagCachePath(cacheRoot), 'utf8'))[tag]
    if (!entry || Date.now() - entry.at >= maxAgeMs) return null
    if (JSON.stringify(entry.distTags) !== JSON.stringify(distTags ?? null)) return null
    return entry
  } catch {
    return null
  }
}

export function recordMissingTag(tag, distTags, error, { cacheRoot = CACHE_ROOT } = {}) {
  if (!MISSING_TAG_RE.test(error)) return false
  const file = missingTagCachePath(cacheRoot)
  let all = {}
  try {
    all = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  all[tag] = { at: Date.now(), distTags: distTags ?? null, error }
  try {
    fs.mkdirSync(cacheRoot, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(all))
    return true
  } catch {
    return false
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

// 盯梢退出码（--check 模式）：1=上游有新版（cron/launchd/agent 轮询的非零信号，
// 此时新版指南已顺手预取进缓存）；0=无需动作（up-to-date/ahead/unknown-local）。
// 判定失败（网络挂且无缓存）走 CLI catch 的 2，不与「有动作」混淆。
export function upstreamCheckExit(resolution) {
  return resolution?.verdict === 'upgrade-available' ? 1 : 0
}

// 靶向获取 Release Note 补全指南真空期
export function fetchReleaseNoteIfMissing(targetVersion, { cacheRoot = CACHE_ROOT } = {}) {
  if (!targetVersion) return null
  const bare = targetVersion.replace(/^v/, '')
  const relDir = path.join(cacheRoot, 'releases')
  const relFile = path.join(relDir, `${bare}.json`)
  if (fs.existsSync(relFile)) {
    try {
      return JSON.parse(fs.readFileSync(relFile, 'utf8'))
    } catch {}
  }
  // 靶向获取：优先 gh cli，零配置认证
  try {
    fs.mkdirSync(relDir, { recursive: true })
    const out = execFileSync('gh', ['release', 'view', `dsh-v${bare}`, '--repo', 'deepseek-ai/deepseek-harness', '--json', 'body,tagName,publishedAt'], {
      encoding: 'utf8',
      timeout: 10000,
    })
    const data = JSON.parse(out)
    fs.writeFileSync(relFile, JSON.stringify(data, null, 2))
    return data
  } catch {
    return null
  }
}

// cacheRoot 可注入（默认真实缓存根）：与 runlog 的 DSH_PFA_RUNS_DIR 同一条纪律——
// 自检直调本函数时不许碰真实用户缓存（2026-10-26 实录：合成 dist-tags 落进真实
// 缓存，真实 run.mjs 在 1h TTL 内读到的是自检刷进去的版本数据）。
export async function runGuideSync(localVersion, { clone = false, fetcher = null, localClone = null, cacheRoot = CACHE_ROOT, targetVersion = null, branchSnapshot = false } = {}) {
  const metadata = await fetchNpmMetadata({ fetcher, cachePath: path.join(cacheRoot, 'npm-metadata.json') })
  const resolution = resolveTargetVersion(localVersion, metadata['dist-tags'], Object.keys(metadata.versions || {}))
  const guideVersion = guideVersionFor(resolution, localVersion, metadata['dist-tags'], targetVersion)

  let guides = { source: 'unavailable', root: null, versions: [] }
  let snapshotError = null
  if (guideVersion) {
    // 1. 本机 clone（只读，不 fetch）
    guides = localCloneGuides(localClone ?? findLocalClone()) ?? { source: 'unavailable', root: null, versions: [] }

    // 2. 受管分支快照：官方在发版后才补全同版本指南，tag 快照会缺页。
    // 这是网络动作，默认关；CLI 与 run.mjs 显式开启，自检直调时不会打网络。
    // clone=false 时仍可读 TTL 内的本地快照，只是不刷新。
    if (guides.source === 'unavailable' && branchSnapshot) {
      const snapshot = syncBranchSnapshot({ cacheRoot, allowRefresh: clone })
      if (snapshot.root) guides = snapshot
      else snapshotError = snapshot.error
    }

    // 3. tag 缓存兜底：标 frozen，让上层知道这是冻结快照（可能缺新补的条目）
    if (guides.source === 'unavailable') {
      const cached = syncGuides(guideVersion, { cacheRoot })
      if (cached.root) guides = { ...cached, frozen: true, warning: snapshotError }
    }

    // 4. tag clone（网络）：只在上面的路径都不可用时才走，受否定缓存保护
    if (guides.source === 'unavailable' && clone) {
      const tag = `dsh-v${guideVersion}`
      const distTags = metadata['dist-tags']
      const known = readMissingTag(tag, distTags, { cacheRoot })
      if (known) {
        guides = { source: 'error', root: null, versions: [], error: known.error, negativeCache: true }
      } else {
        try {
          guides = { ...cloneGuides(guideVersion, { cacheRoot }), frozen: true }
        } catch (err) {
          recordMissingTag(tag, distTags, err.message, { cacheRoot })
          guides = { source: 'error', root: null, versions: [], error: err.message }
        }
      }
    }

    // 5. 靶向抓取：若指南根目录缺失目标版本的指南，尝试靶向获取该版本 Release Note 填补真空期
    if (guides.root && guideVersion) {
      const hasVer = (guides.versions || []).some((v) => v.replace(/^v/, '') === guideVersion.replace(/^v/, ''))
      if (!hasVer) {
        fetchReleaseNoteIfMissing(guideVersion, { cacheRoot })
        guides.versions = listGuideVersions(guides.root)
      }
    }

    if (guides.source === 'unavailable' && snapshotError) {
      guides = { source: 'error', root: null, versions: [], error: snapshotError }
    }
  }

  return { resolution, guides, guideVersion, metadataSource: metadata._metadataSource || 'network' }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  // --check：盯梢模式。退出码给 cron/agent 轮询用（1=有新版，0=无需动作，2=判定失败），
  // 有新版时顺手预取该版指南进缓存（clone=true），下次 run.mjs 零等待。
  // 版本参数缺省时自动探测本机宿主版本，零参数可直接接定时器。
  // 参数：<本机版本> [--target <扫描目标>] [--clone] [--check]
  // --target 让调用方指定「本轮实际要扫到的版本」；不传才跟官方最新。
  const argv = process.argv.slice(2)
  const checkMode = argv.includes('--check')
  let targetVersion = null
  let positional = null
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check' || arg === '--clone') continue
    if (arg === '--target') {
      targetVersion = argv[++i] ?? null
      continue
    }
    if (arg === '--help' || arg === '-h') {
      process.stderr.write('用法: node scripts/guide-sync.mjs [<本机版本>] [--target <扫描目标>] [--clone] [--check]\n')
      process.exit(0)
    }
    if (arg.startsWith('--')) {
      process.stderr.write(`未知参数「${arg}」\n用法: node scripts/guide-sync.mjs [<本机版本>] [--target <扫描目标>] [--clone] [--check]\n`)
      process.exit(2)
    }
    if (!positional) positional = arg
  }
  const local = positional || (checkMode ? findGlobalDsh()?.version ?? null : null)
  const allowClone = argv.includes('--clone') || checkMode

  runGuideSync(local, { clone: allowClone, targetVersion, branchSnapshot: true })
    .then((result) => {
      printJson(result)
      const r = result.resolution
      process.stderr.write(`\n本机版本: ${r.localVersion || '未检测到'}\n`)
      process.stderr.write(`判定: ${r.verdict}\n`)
      process.stderr.write(`理由: ${r.reason}\n`)
      process.stderr.write(`版本数据来源: ${result.metadataSource}${result.metadataSource === 'stale-cache' ? '（网络失败，降级用过期缓存）' : ''}\n`)
      process.stderr.write(`取版锚点: ${result.guideVersion || '无'}\n`)
      if (result.guides.root) {
        const flags = [result.guides.stale ? 'stale' : null, result.guides.frozen ? 'frozen' : null].filter(Boolean)
        const commit = result.guides.commit ? ` @${String(result.guides.commit).slice(0, 7)}` : ''
        process.stderr.write(`指南来源: ${result.guides.source}${flags.length ? `（${flags.join(',')}）` : ''}${commit} (${result.guides.versions.length} 个版本)\n`)
        if (result.guides.warning) process.stderr.write(`提示: ${result.guides.warning}\n`)
      } else if (result.guides.error) {
        process.stderr.write(`指南获取失败${result.guides.negativeCache ? '（否定缓存命中，1 小时内或 dist-tags 变化前不重试）' : ''}: ${result.guides.error}\n`)
      } else {
        process.stderr.write('指南来源: 无（无目标版本或未拉取）\n')
      }
      if (checkMode) {
        const code = upstreamCheckExit(result.resolution)
        if (code === 1) {
          const prefetched = result.guides.root ? '目录已就绪' : '预取失败（下次 run.mjs --clone 会补）'
          process.stderr.write(`盯梢: 上游有新版 ${result.resolution.target}（${prefetched}）——逐插件跑 run.mjs 适配\n`)
        } else {
          process.stderr.write('盯梢: 无需动作\n')
        }
        process.exit(code)
      }
    })
    .catch((err) => {
      process.stderr.write(`失败: ${err.message}\n`)
      process.exit(checkMode ? 2 : 1)
    })
}
