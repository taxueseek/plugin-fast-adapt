#!/usr/bin/env node
// fix-peer-deps.mjs —— 批量把宿主核心包从 dependencies 挪进 peerDependencies。
//
// 为什么这类修补敢批量做：判据纯机械（名字在不在 PEER_ONLY_PACKAGES 里），
// 且失败方向是「报错」而不是「静默改坏」——搬错位置会让 npm install 直接报
// 依赖缺失，不会变成看不见的运行时异常。
//
// 默认 dry-run：只打印计划。加 --apply 才落盘，且落盘前把原文件备份到
// <插件目录>/.pfa-backup/<时间戳>/package.json（保留现场，不删原文件）。
//
// 用法:
//   node scripts/fix-peer-deps.mjs [目录...] [--installed] [--apply] [--json]
// 退出码: 0 无待修补；2 有待修补（dry-run 下）或已修补。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { planPeerFix, PEER_ONLY_PACKAGES } from './lib/peer-fix.mjs'
import { printJson } from './lib/scanner.mjs'

function parseArgs(argv) {
  const out = { dirs: [], installed: false, apply: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--installed') out.installed = true
    else if (a === '--apply') out.apply = true
    else if (a === '--json') out.json = true
    else if (a === '--help') out.help = true
    else if (a.startsWith('--')) {
      process.stderr.write(`未知参数「${a}」\n用法: node scripts/fix-peer-deps.mjs [目录...] [--installed] [--apply] [--json]\n`)
      process.exit(1)
    } else out.dirs.push(a)
  }
  return out
}

/** 列出本机各 profile 下已安装的插件目录（含 scoped 包）。 */
function listInstalledPluginDirs() {
  const profilesRoot = process.env.DSH_PFA_PROFILES_ROOT || path.join(process.env.HOME || '', '.dsh', 'profiles')
  const out = []
  if (!fs.existsSync(profilesRoot)) return out
  for (const profile of fs.readdirSync(profilesRoot)) {
    const nm = path.join(profilesRoot, profile, 'node_modules')
    if (!fs.existsSync(nm)) continue
    const walk = (dir, depth) => {
      if (depth > 2) return
      let entries = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.name.startsWith('@')) {
          walk(full, depth + 1)
          continue
        }
        if (fs.existsSync(path.join(full, 'package.json'))) out.push({ dir: full, profile, name: e.name })
      }
    }
    walk(nm, 0)
  }
  return out
}

function planOne(dir, name) {
  const pkgPath = path.join(dir, 'package.json')
  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (err) {
    return { dir, name, error: `package.json 读不出来：${err.message}` }
  }
  const plan = planPeerFix(pkg)
  return { dir, name, moves: plan.moves, files: plan.files, description: plan.description }
}

export function runFixPeerDeps(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    process.stderr.write(
      '用法: node scripts/fix-peer-deps.mjs [目录...] [--installed] [--apply] [--json]\n' +
        `\n把宿主核心包（${PEER_ONLY_PACKAGES.join(' / ')}）从 dependencies 挪进 peerDependencies。\n` +
        '默认 dry-run 只打印计划；--apply 才落盘，落盘前备份到 <插件目录>/.pfa-backup/<时间戳>/。\n'
    )
    return 0
  }

  let targets = args.dirs.map((d) => ({ dir: path.resolve(d), name: path.basename(path.resolve(d)) }))
  if (args.installed || targets.length === 0) targets = targets.concat(listInstalledPluginDirs())

  const seen = new Set()
  targets = targets.filter((t) => {
    const key = fs.existsSync(t.dir) ? fs.realpathSync(t.dir) : t.dir
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  const results = []
  for (const t of targets) {
    const r = planOne(t.dir, t.name)
    if (r.error || (r.moves && r.moves.length)) results.push(r)
  }

  const fixable = results.filter((r) => r.moves && r.moves.length)
  const unreadable = results.filter((r) => r.error)

  const applied = []
  if (args.apply) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    for (const r of fixable) {
      try {
        const backupDir = path.join(r.dir, '.pfa-backup', stamp)
        fs.mkdirSync(backupDir, { recursive: true })
        fs.copyFileSync(path.join(r.dir, 'package.json'), path.join(backupDir, 'package.json'))
        for (const [rel, content] of Object.entries(r.files)) {
          fs.writeFileSync(path.join(r.dir, rel), content)
        }
        applied.push({ dir: r.dir, name: r.name, moves: r.moves.length, backup: path.relative(r.dir, backupDir) })
      } catch (err) {
        applied.push({ dir: r.dir, name: r.name, error: err.message })
      }
    }
  }

  if (args.json) {
    printJson({
      mode: args.apply ? 'applied' : 'dry-run',
      scanned: targets.length,
      fixable: fixable.length,
      unreadable: unreadable.length,
      results: results.map((r) => ({ dir: r.dir, name: r.name, error: r.error, moves: r.moves })),
      applied,
    })
  } else {
    process.stderr.write(`包面修补${args.apply ? '（已落盘）' : '（dry-run，加 --apply 才写）'}\n`)
    process.stderr.write(`扫描 ${targets.length} 个插件目录，待修补 ${fixable.length} 个${unreadable.length ? `，读不出 ${unreadable.length} 个` : ''}\n\n`)
    for (const r of fixable) {
      process.stderr.write(`  ${r.name}\n`)
      for (const m of r.moves) process.stderr.write(`      ${m.from}  →  ${m.to}\n`)
    }
    for (const r of unreadable) process.stderr.write(`  ! ${r.name}: ${r.error}\n`)
    if (fixable.length) {
      const backups = applied.filter((a) => a.backup).map((a) => `${a.name} → ${a.backup}`)
      if (backups.length) process.stderr.write(`\n备份：${backups.join('；')}\n`)
      else process.stderr.write('\n下一步: 复核上面的计划，确认后加 --apply 落盘（会先备份原文件）\n')
    }
  }

  return fixable.length ? 2 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(runFixPeerDeps())
}
