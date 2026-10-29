#!/usr/bin/env node
// fleet-sweep.mjs —— DSH 插件集群批量治理与全域巡检入口。
//
// 职责：
//   全自动识别工作区源码插件与已安装环境插件，按平台（Web、APP 桌面端、核心服务端）
//   与生命周期状态（运行中、已启用、已禁用、工作区源码）分门别类梳理；
//   批量分析各分类下的关键问题（未构建、契约接缝断裂、Bundle 阴影、Peer 冲突、幽灵代际），
//   输出多维治理看板与结构化 JSON 报告，方便作者极速完成适配。
//
// 用法：
//   node scripts/fleet-sweep.mjs [目录...] [--installed] [--workspace] [--web] [--app] [--running] [--disabled] [--json] [--strict] [--target <版本>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson, isPluginForm } from './lib/scanner.mjs'
import { findGlobalDsh, listInstalledPlugins, probeEnvironment } from './env-doctor.mjs'
import { auditPlugin, peerPatchFor, compatPatchFor } from './plugin-audit.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const dirs = []
  let installed = false
  let workspaceOnly = false
  let json = false
  let strict = false
  let target = null
  let filterWeb = false
  let filterApp = false
  let filterRunning = false
  let filterDisabled = false
  let adapt = false
  let applyCompat = false
  let includeOfficial = false

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--installed') installed = true
    else if (a === '--workspace') workspaceOnly = true
    else if (a === '--web') filterWeb = true
    else if (a === '--app' || a === '--desktop') filterApp = true
    else if (a === '--running') filterRunning = true
    else if (a === '--disabled') filterDisabled = true
    else if (a === '--adapt') adapt = true
    else if (a === '--apply-compat') {
      adapt = true
      applyCompat = true
    } else if (a === '--include-official') includeOfficial = true
    else if (a === '--json') json = true
    else if (a === '--strict') strict = true
    else if (a === '--target') target = argv[++i] ?? null
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node scripts/fleet-sweep.mjs [目录...] [选项]\n\n' +
          '选项:\n' +
          '  [目录...]          扫描指定工作区目录（默认同时扫描当前工作区与安装环境）\n' +
          '  --installed        仅扫描本机 DSH profiles 中已安装的插件\n' +
          '  --workspace        仅扫描本地工作区源码插件\n' +
          '  --web              仅筛选 Web 平台插件\n' +
          '  --app / --desktop  仅筛选 Desktop (APP) 桌面端插件\n' +
          '  --running          仅筛选当前正在活跃运行中的插件\n' +
          '  --disabled         仅筛选已禁用或未启用的插件\n' +
          '  --adapt            批量评估目标版本准入账本与 Peer 修补建议\n' +
          '  --apply-compat     对 0 代码破坏性命中的插件自动写入 package.json 兼容账本与 Peer 范围\n' +
          '  --include-official 包含宿主官方内置 @deepseek-ai/dsh-* 组件\n' +
          '  --json             输出完整结构化分类 JSON 报告\n' +
          '  --strict           存在任何 warning 或 broken 时以退出码 2 退出\n' +
          '  --target <版本>    指定目标宿主版本（默认取本机当前宿主）\n',
      )
      process.exit(0)
    } else if (!a.startsWith('--')) {
      dirs.push(path.resolve(a))
    }
  }

  return {
    dirs,
    installed,
    workspaceOnly,
    json,
    strict,
    target,
    filterWeb,
    filterApp,
    filterRunning,
    filterDisabled,
    adapt,
    applyCompat,
    includeOfficial,
  }
}

export { discoverWorkspacePlugins as discoverPlugins, inspectPluginItem as inspectPlugin }

export function checkBuild(pluginRoot) {
  const pkgPath = path.join(pluginRoot, 'package.json')
  if (!fs.existsSync(pkgPath)) return { ok: true, status: 'N/A' }
  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {
    return { ok: false, status: 'CORRUPTED', reason: 'package.json 解析失败' }
  }
  const hasTsConfig = fs.existsSync(path.join(pluginRoot, 'tsconfig.json'))
  const hasSrc = fs.existsSync(path.join(pluginRoot, 'src'))
  if (!hasTsConfig && !hasSrc) return { ok: true, status: 'OK' }

  const entryRel =
    pkg.exports?.['.']?.default ||
    (typeof pkg.exports?.['.'] === 'string' ? pkg.exports['.'] : null) ||
    pkg.main ||
    'lib/index.js'
  const entryPath = path.resolve(pluginRoot, entryRel)
  if (!fs.existsSync(entryPath)) {
    return { ok: false, status: 'UNBUILT', entryRel, reason: `产物缺失: ${entryRel}` }
  }
  return { ok: true, status: 'OK', entryRel }
}

// 探测工作区候选插件
export function discoverWorkspacePlugins(roots = [process.cwd()]) {
  const candidates = new Set()
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const rootPkg = path.join(root, 'package.json')
    if (fs.existsSync(rootPkg)) {
      candidates.add(root)
    }

    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue
        const sub = path.join(root, e.name)
        const subPkg = path.join(sub, 'package.json')
        if (fs.existsSync(subPkg)) {
          try {
            const pkg = JSON.parse(fs.readFileSync(subPkg, 'utf8'))
            if (isPluginForm(pkg)) candidates.add(sub)
          } catch {}
        }
        if (e.name === 'packages' || e.name === 'plugins') {
          for (const subEntry of fs.readdirSync(sub, { withFileTypes: true })) {
            if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue
            const leaf = path.join(sub, subEntry.name)
            if (fs.existsSync(path.join(leaf, 'package.json'))) candidates.add(leaf)
          }
        }
      }
    } catch {}
  }
  return [...candidates].sort()
}

// 解析已安装插件在磁盘上的真实目录（支持软链回溯到源码仓）
export function resolveInstalledPluginDir(pkgName, profile, dshHome = null) {
  if (!pkgName) return null
  const baseHome = dshHome || process.env.DSH_PFA_DSH_HOME || path.join(os.homedir(), '.dsh')
  const parts = pkgName.split('/')
  const candidates = [
    profile ? path.join(baseHome, 'profiles', profile, 'node_modules', ...parts) : null,
    path.join(baseHome, 'profiles', 'node_modules', ...parts),
  ].filter(Boolean)

  for (const cand of candidates) {
    try {
      if (fs.existsSync(path.join(cand, 'package.json'))) {
        try {
          return fs.realpathSync(cand)
        } catch {
          return cand
        }
      }
    } catch {}
  }
  return null
}

// 批量应用 package.json 准入账本与 Peer 范围修补（仅用于 0 代码破坏性命中的插件）
export function applyCompatAndPeerPatch(pluginDir, { targetVersion = null, peerPatch = null, compatPatch = null } = {}) {
  const pkgPath = path.join(path.resolve(pluginDir), 'package.json')
  if (!fs.existsSync(pkgPath)) return { updated: false, changes: [] }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  const resolvedPeers = peerPatch ?? (targetVersion ? peerPatchFor(pkg, targetVersion) : [])
  const resolvedCompat = compatPatch ?? (targetVersion ? compatPatchFor(pkg, targetVersion) : [])
  const changes = []

  if (resolvedPeers.length > 0 && pkg.peerDependencies) {
    for (const p of resolvedPeers) {
      if (pkg.peerDependencies[p.package] !== undefined && pkg.peerDependencies[p.package] !== p.to) {
        pkg.peerDependencies[p.package] = p.to
        changes.push({ kind: 'peer', field: `peerDependencies.${p.package}`, from: p.from, to: p.to })
      }
    }
  }

  if (resolvedCompat.length > 0) {
    for (const c of resolvedCompat) {
      if (c.field === 'dsh.compatibility.dsh') {
        pkg.dsh = pkg.dsh || {}
        pkg.dsh.compatibility = pkg.dsh.compatibility || {}
        pkg.dsh.compatibility.dsh = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      } else if (c.field.startsWith('dsh.compatibility.dshReleases.')) {
        const ver = c.field.slice('dsh.compatibility.dshReleases.'.length)
        pkg.dsh = pkg.dsh || {}
        pkg.dsh.compatibility = pkg.dsh.compatibility || {}
        pkg.dsh.compatibility.dshReleases = pkg.dsh.compatibility.dshReleases || {}
        pkg.dsh.compatibility.dshReleases[ver] = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      } else if (c.field === 'engines.dsh') {
        pkg.engines = pkg.engines || {}
        pkg.engines.dsh = c.to
        changes.push({ kind: 'compat', field: c.field, from: c.from, to: c.to })
      }
    }
  }

  if (changes.length > 0) {
    fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
  }
  return { updated: changes.length > 0, changes }
}

// 全域发现：区分来源、平台形态与挂载配置
export function discoverAllPlugins(
  targetDirs = [],
  { scanInstalled = true, scanWorkspace = true, envData = null, includeOfficial = false } = {},
) {
  const list = []
  const seenPaths = new Set()
  const dshHome = envData?.dshDir || process.env.DSH_PFA_DSH_HOME || null
  const hostLoc = envData?.globalDsh?.location ? path.resolve(envData.globalDsh.location) : null

  // 1. 扫描安装环境中的插件
  if (scanInstalled && envData) {
    const installedProfiles = envData.installedPlugins || []
    // 找出当前活跃的 profile（如运行了 dsh web，则 runningProfile = 'web'）
    const runningProfiles = new Set()
    for (const proc of envData.runningProcesses || []) {
      const m = proc.command?.match(/\bdsh\s+(web|desktop|serve|tui|headless)\b/)
      if (m) runningProfiles.add(m[1])
    }

    for (const group of installedProfiles) {
      const prof = group.profile
      const patchEntries = group.patchEntries || []
      const isRunningHost = runningProfiles.has(prof)
      const seenInProfile = new Set()

      for (const entry of patchEntries) {
        const m = entry.match(/^-\s+([^\s]+)/)
        if (!m) continue
        const pkgName = m[1]
        // 排除非插件的内部指令或服务别名
        if (pkgName.startsWith('-') || pkgName.includes(' ') || pkgName === 'insert:') continue
        if (seenInProfile.has(pkgName)) continue

        const resolvedDir = resolveInstalledPluginDir(pkgName, prof, dshHome)
        // 默认过滤官方内置 @deepseek-ai/dsh-* 服务条目（它们是宿主自带模块，除非用户显式 --include-official）
        if (!includeOfficial && pkgName.startsWith('@deepseek-ai/dsh-')) {
          const isHostBuiltin =
            !resolvedDir || (hostLoc && (resolvedDir === hostLoc || resolvedDir.startsWith(hostLoc + path.sep)))
          if (isHostBuiltin) continue
        }

        seenInProfile.add(pkgName)

        let platform = 'core'
        if (prof === 'web') platform = 'web'
        else if (prof.includes('desktop')) platform = 'app'

        const isDisabled =
          entry.includes('disabled: true') ||
          group.globalPatchEntries?.some((e) => e.includes(pkgName) && e.includes('disabled: true'))

        let state = 'ENABLED'
        if (isDisabled) state = 'DISABLED'
        else if (isRunningHost) state = 'RUNNING'

        list.push({
          sourceType: 'INSTALLED',
          name: pkgName,
          dir: resolvedDir,
          profile: prof,
          platform,
          state,
          installed: true,
        })
      }
    }
  }

  // 2. 扫描工作区源码插件
  if (scanWorkspace) {
    const wsDirs = discoverWorkspacePlugins(targetDirs.length > 0 ? targetDirs : [process.cwd()])
    for (const dir of wsDirs) {
      seenPaths.add(dir)
      let pkg = null
      try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      } catch {}

      let platform = 'core'
      if (pkg?.dsh?.client?.platform === 'web' || fs.existsSync(path.join(dir, 'client'))) {
        platform = 'web'
      } else if (String(pkg?.name).includes('desktop') || fs.existsSync(path.join(dir, 'desktop'))) {
        platform = 'app'
      }

      list.push({
        sourceType: 'WORKSPACE',
        name: pkg?.name || path.basename(dir),
        dir,
        profile: 'workspace',
        platform,
        state: 'WORKSPACE',
        installed: false,
      })
    }
  }

  return list
}

// 统一巡检与问题诊断
export function inspectPluginItem(
  rawItem,
  { hostInfo = null, targetVersion = null, envData = null, applyCompat = false } = {},
) {
  const item = typeof rawItem === 'string'
    ? {
        name: path.basename(rawItem),
        dir: rawItem,
        profile: 'workspace',
        platform: 'core',
        state: 'WORKSPACE',
        installed: false,
        sourceType: 'WORKSPACE',
      }
    : rawItem

  const dir = item.dir
  const effectiveTarget = targetVersion || hostInfo?.version || null
  let pkg = { name: item.name, version: '0.0.0' }
  if (dir) {
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    } catch {}
  }

  const build = dir ? checkBuild(dir) : { ok: true, status: 'N/A' }
  let audit = null
  if (dir) {
    try {
      audit = auditPlugin(dir, {
        hostInfo,
        targetVersion: effectiveTarget,
      })
    } catch (err) {
      audit = { overallScore: 0, scores: {}, findings: [{ severity: 'CRITICAL', title: err.message }] }
    }
  } else {
    audit = {
      overallScore: 100,
      scores: { performance: 100, resilience: 100, contextBudget: 100, lifecycle: 100 },
      findings: [],
      peerPatch: [],
      compatPatch: [],
    }
  }

  let findings = audit.findings || []
  let criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
  let highCount = findings.filter((f) => f.severity === 'HIGH').length
  let mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length
  let appliedPatches = null

  // 批量自适应修补：仅当无代码级 CRITICAL/HIGH 阻断且用户开启 applyCompat 时写入 package.json
  if (
    applyCompat &&
    dir &&
    criticalCount === 0 &&
    highCount === 0 &&
    ((audit.peerPatch?.length ?? 0) > 0 || (audit.compatPatch?.length ?? 0) > 0)
  ) {
    appliedPatches = applyCompatAndPeerPatch(dir, {
      targetVersion: effectiveTarget,
      peerPatch: audit.peerPatch,
      compatPatch: audit.compatPatch,
    })
    if (appliedPatches.updated) {
      // 重跑一次轻量审计，刷新准入账本与 Peer 得分
      try {
        audit = auditPlugin(dir, { hostInfo, targetVersion: effectiveTarget })
        findings = audit.findings || []
        criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
        highCount = findings.filter((f) => f.severity === 'HIGH').length
        mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length
      } catch {}
    }
  }

  let healthStatus = 'healthy'
  const issues = []

  if (!build.ok) {
    healthStatus = 'broken'
    issues.push(build.reason || '未构建')
  }

  if (criticalCount > 0 || highCount > 0) {
    healthStatus = 'broken'
    const highTitles = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => f.title)
    issues.push(...highTitles)
  } else if (mediumCount > 0 || audit.overallScore < 85) {
    if (healthStatus !== 'broken') healthStatus = 'warning'
    const medTitles = findings.filter((f) => f.severity === 'MEDIUM').map((f) => f.title)
    issues.push(...medTitles)
  }

  // 运行中幽灵代际关联
  if (item.state === 'RUNNING' && envData?.ghostHost?.verdict === 'stale') {
    issues.push(`幽灵代际风险: ${envData.ghostHost.reason}`)
    if (healthStatus === 'healthy') healthStatus = 'warning'
  }

  return {
    ...item,
    name: pkg.name || item.name,
    version: pkg.version || '0.0.0',
    buildStatus: build.status,
    score: audit.overallScore,
    status: healthStatus,
    healthStatus,
    criticalCount,
    highCount,
    mediumCount,
    issues,
    findingsCount: findings.length,
    peerPatch: audit.peerPatch || [],
    compatPatch: audit.compatPatch || [],
    ...(appliedPatches ? { appliedPatches } : {}),
  }
}

export function runFleetSweep(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const envData = probeEnvironment(process.cwd())
  const hostInfo = findGlobalDsh()
  const targetVer = args.target || hostInfo?.version || '0.2.1'

  // 判定扫描范围：默认工作区 + 安装环境全域梳理；若显式指定了目录且未加 --installed 则只扫描指定目录
  const scanInstalled = args.installed || (!args.workspaceOnly && args.dirs.length === 0)
  const scanWorkspace = !args.installed

  const rawList = discoverAllPlugins(args.dirs, {
    scanInstalled,
    scanWorkspace,
    envData,
    includeOfficial: args.includeOfficial,
  })
  let items = rawList.map((item) =>
    inspectPluginItem(item, {
      hostInfo,
      targetVersion: targetVer,
      envData,
      applyCompat: args.applyCompat,
    }),
  )

  // 条件筛选过滤
  if (args.filterWeb) items = items.filter((x) => x.platform === 'web')
  if (args.filterApp) items = items.filter((x) => x.platform === 'app')
  if (args.filterRunning) items = items.filter((x) => x.state === 'RUNNING')
  if (args.filterDisabled) items = items.filter((x) => x.state === 'DISABLED')
  if (args.workspaceOnly) items = items.filter((x) => x.sourceType === 'WORKSPACE')

  // 分类统计
  const total = items.length
  const healthy = items.filter((r) => r.healthStatus === 'healthy').length
  const warning = items.filter((r) => r.healthStatus === 'warning').length
  const broken = items.filter((r) => r.healthStatus === 'broken').length

  const byPlatform = {
    web: items.filter((x) => x.platform === 'web'),
    app: items.filter((x) => x.platform === 'app'),
    core: items.filter((x) => x.platform === 'core'),
  }

  const byState = {
    running: items.filter((x) => x.state === 'RUNNING'),
    enabled: items.filter((x) => x.state === 'ENABLED'),
    disabled: items.filter((x) => x.state === 'DISABLED'),
    workspace: items.filter((x) => x.sourceType === 'WORKSPACE'),
  }

  const summary = {
    total,
    healthy,
    warning,
    broken,
    hostVersion: hostInfo?.version || null,
    targetVersion: targetVer,
    activeHostProcesses: (envData.runningProcesses || []).length,
    byPlatform: {
      webCount: byPlatform.web.length,
      appCount: byPlatform.app.length,
      coreCount: byPlatform.core.length,
    },
    byState: {
      runningCount: byState.running.length,
      enabledCount: byState.enabled.length,
      disabledCount: byState.disabled.length,
      workspaceCount: byState.workspace.length,
    },
    plugins: items,
  }

  if (args.json) {
    printJson(summary)
    const exitCode = broken > 0 || (args.strict && warning > 0) ? 2 : 0
    process.exit(exitCode)
  }

  // 格式化看板呈现
  process.stdout.write(`\n================================================================================\n`)
  process.stdout.write(`             DSH 插件全域集群治理看板 (目标宿主: ${targetVer})\n`)
  process.stdout.write(`================================================================================\n`)
  process.stdout.write(
    `【宿主状态】全局 DSH: ${hostInfo?.version || '未知'} | 活跃进程: ${(envData.runningProcesses || []).length} 个 | 幽灵代际: ${envData.ghostHost?.verdict || 'unknown'}\n\n`,
  )

  const printSection = (title, list) => {
    if (!list.length) return
    process.stdout.write(`\n┌─ ${title} (共 ${list.length} 个) ${'─'.repeat(Math.max(0, 70 - title.length))}\n`)
    process.stdout.write(
      `│ ${'插件名称'.padEnd(28)} ${'平台'.padEnd(8)} ${'状态'.padEnd(10)} ${'构建'.padEnd(8)} ${'评分'.padEnd(6)} 关键问题诊断\n`,
    )
    process.stdout.write(`├${'─'.repeat(78)}\n`)
    for (const r of list) {
      const issueText = r.issues.length > 0 ? r.issues[0].slice(0, 26) : '正常健康'
      const statusTag = r.healthStatus === 'healthy' ? '健康' : r.healthStatus === 'warning' ? '警告' : '高危'
      process.stdout.write(
        `│ ${r.name.slice(0, 26).padEnd(28)} ${r.platform.padEnd(8)} ${(r.state + '/' + statusTag).padEnd(10)} ${r.buildStatus.padEnd(8)} ${(String(r.score) + '/100').padEnd(6)} ${issueText}\n`,
      )
    }
    process.stdout.write(`└${'─'.repeat(78)}\n`)
  }

  // 1. 正在运行中的插件
  printSection('一、正在运行中的插件 (RUNNING)', byState.running)

  // 2. 本地工作区源码插件
  printSection('二、本地工作区源码插件 (WORKSPACE)', byState.workspace)

  // 3. Web 平台已安装插件
  printSection('三、已安装 Web 插件 (INSTALLED / WEB)', byPlatform.web.filter((x) => x.sourceType !== 'WORKSPACE'))

  // 4. Desktop (APP) 平台插件
  printSection('四、已安装 Desktop (APP) 插件 (INSTALLED / APP)', byPlatform.app.filter((x) => x.sourceType !== 'WORKSPACE'))

  // 5. 已禁用或未启用的插件
  printSection('五、已禁用或未启用插件 (DISABLED / INACTIVE)', byState.disabled)

  process.stdout.write(
    `\n【全域统计】共 ${total} 个 | 运行中: ${byState.running.length} | 工作区: ${byState.workspace.length} | Web: ${byPlatform.web.length} | APP: ${byPlatform.app.length} | 未启用: ${byState.disabled.length}\n`,
  )
  process.stdout.write(`【健康结论】健康: ${healthy} | 需优化: ${warning} | 故障高危: ${broken}\n`)

  if (broken > 0) {
    process.stdout.write(`\n下一步指路: 存在 ${broken} 个故障插件，请使用单兵深度适配进行修复:\n`)
    for (const r of items.filter((x) => x.healthStatus === 'broken' && x.dir)) {
      process.stdout.write(`  node scripts/run.mjs ${r.dir}\n`)
    }
  }

  const exitCode = broken > 0 || (args.strict && warning > 0) ? 2 : 0
  process.exit(exitCode)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runFleetSweep()
}
