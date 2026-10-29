#!/usr/bin/env node
// fleet-sweep.mjs —— DSH 插件集群批量治理与巡检入口。
//
// 职责：
//   批量扫描指定工作区目录或系统中安装的整批插件，执行轻量契约审计、构建产物探测、
//   Bundle 阴影检测与 Peer 兼容性核验，输出集群治理矩阵看板与结构化报告。
//
// 用法：
//   node scripts/fleet-sweep.mjs [目录...] [--installed] [--json] [--strict] [--target <版本>]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printJson, isPluginForm } from './lib/scanner.mjs'
import { findGlobalDsh, listInstalledPlugins } from './env-doctor.mjs'
import { auditPlugin } from './plugin-audit.mjs'

const TOOL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const dirs = []
  let installed = false
  let json = false
  let strict = false
  let target = null

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--installed') installed = true
    else if (a === '--json') json = true
    else if (a === '--strict') strict = true
    else if (a === '--target') target = argv[++i] ?? null
    else if (a === '--help' || a === '-h') {
      process.stdout.write(
        '用法: node scripts/fleet-sweep.mjs [目录...] [--installed] [--json] [--strict] [--target <版本>]\n\n' +
          '选项:\n' +
          '  [目录...]         待扫描的工作区根目录或通配目录（默认扫当前目录下的子插件）\n' +
          '  --installed       扫描本机 DSH profiles 中已安装的所有插件\n' +
          '  --json            输出纯 JSON 报告\n' +
          '  --strict          存在任何 warning 或 broken 时以退出码 2 退出\n' +
          '  --target <版本>   指定目标宿主版本（默认取本机当前宿主）\n',
      )
      process.exit(0)
    } else if (!a.startsWith('--')) {
      dirs.push(path.resolve(a))
    }
  }

  return { dirs, installed, json, strict, target }
}

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

export function discoverPlugins(targetDirs = [], { scanInstalled = false } = {}) {
  const candidates = new Set()

  if (scanInstalled) {
    try {
      const installed = listInstalledPlugins()
      for (const p of installed) {
        if (p.location && fs.existsSync(p.location)) {
          candidates.add(path.resolve(p.location))
        }
      }
    } catch {}
  }

  const roots = targetDirs.length > 0 ? targetDirs : [process.cwd()]
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    // 如果显式指定的目录本身包含 package.json，直接纳入
    const rootPkg = path.join(root, 'package.json')
    if (fs.existsSync(rootPkg)) {
      candidates.add(root)
    }

    // 扫描子目录
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
        // 支持 packages/* / plugins/* 二级子目录
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

export function inspectPlugin(pluginDir, { hostInfo = null, targetVersion = null } = {}) {
  const pkgPath = path.join(pluginDir, 'package.json')
  let pkg = { name: path.basename(pluginDir), version: '0.0.0' }
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch {}

  const build = checkBuild(pluginDir)
  let audit = null
  try {
    audit = auditPlugin(pluginDir, {
      hostInfo,
      targetVersion: targetVersion || hostInfo?.version || null,
    })
  } catch (err) {
    audit = { overallScore: 0, scores: {}, findings: [{ severity: 'CRITICAL', title: err.message }] }
  }

  const findings = audit.findings || []
  const criticalCount = findings.filter((f) => f.severity === 'CRITICAL').length
  const highCount = findings.filter((f) => f.severity === 'HIGH').length
  const mediumCount = findings.filter((f) => f.severity === 'MEDIUM').length

  let status = 'healthy'
  const issues = []

  if (!build.ok) {
    status = 'broken'
    issues.push(build.reason || '未构建')
  }

  if (criticalCount > 0 || highCount > 0) {
    status = 'broken'
    const highTitles = findings.filter((f) => f.severity === 'CRITICAL' || f.severity === 'HIGH').map((f) => f.title)
    issues.push(...highTitles)
  } else if (mediumCount > 0 || audit.overallScore < 85) {
    if (status !== 'broken') status = 'warning'
    const medTitles = findings.filter((f) => f.severity === 'MEDIUM').map((f) => f.title)
    issues.push(...medTitles)
  }

  return {
    dir: pluginDir,
    name: pkg.name || path.basename(pluginDir),
    version: pkg.version || '0.0.0',
    buildStatus: build.status,
    score: audit.overallScore,
    status,
    criticalCount,
    highCount,
    mediumCount,
    issues,
    findingsCount: findings.length,
  }
}

export function runFleetSweep(argv = process.argv.slice(2)) {
  const { dirs, installed, json, strict, target } = parseArgs(argv)
  const hostInfo = findGlobalDsh()
  const targetVer = target || hostInfo?.version || '0.2.1'
  const plugins = discoverPlugins(dirs, { scanInstalled: installed })

  const results = plugins.map((dir) => inspectPlugin(dir, { hostInfo, targetVersion: targetVer }))
  const total = results.length
  const healthy = results.filter((r) => r.status === 'healthy').length
  const warning = results.filter((r) => r.status === 'warning').length
  const broken = results.filter((r) => r.status === 'broken').length

  const summary = {
    total,
    healthy,
    warning,
    broken,
    hostVersion: hostInfo?.version || null,
    targetVersion: targetVer,
    plugins: results,
  }

  if (json) {
    printJson(summary)
    const exitCode = broken > 0 || (strict && warning > 0) ? 2 : 0
    process.exit(exitCode)
  }

  // 终端看板呈现
  process.stdout.write(`\n=== DSH 插件集群治理巡检看板 (共 ${total} 个插件 | 目标宿主: ${targetVer}) ===\n\n`)
  if (total === 0) {
    process.stdout.write('未发现待检测插件。请指定插件目录或追加 --installed。\n\n')
    process.exit(0)
  }

  process.stdout.write(
    `${'插件名称'.padEnd(28)} ${'版本'.padEnd(12)} ${'构建'.padEnd(8)} ${'评分'.padEnd(6)} ${'状态'.padEnd(8)} 关键诊断\n`,
  )
  process.stdout.write(''.padEnd(85, '-') + '\n')

  for (const r of results) {
    const statusText = r.status === 'healthy' ? '健康' : r.status === 'warning' ? '警告' : '高危'
    const issueText = r.issues.length > 0 ? r.issues[0].slice(0, 32) : '无显著风险'
    process.stdout.write(
      `${r.name.slice(0, 26).padEnd(28)} ${r.version.slice(0, 10).padEnd(12)} ${r.buildStatus.padEnd(8)} ${(String(r.score) + '/100').padEnd(6)} ${statusText.padEnd(8)} ${issueText}\n`,
    )
  }

  process.stdout.write(''.padEnd(85, '-') + '\n')
  process.stdout.write(`统计汇总: 健康 ${healthy} | 需优化 ${warning} | 故障/高危 ${broken}\n`)

  if (broken > 0) {
    process.stdout.write(`\n下一步指路: 存在 ${broken} 个故障插件，请使用单兵深度适配进行修复:\n`)
    for (const r of results.filter((x) => x.status === 'broken')) {
      process.stdout.write(`  node scripts/run.mjs ${r.dir}\n`)
    }
  }

  const exitCode = broken > 0 || (strict && warning > 0) ? 2 : 0
  process.exit(exitCode)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runFleetSweep()
}
