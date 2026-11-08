#!/usr/bin/env node
// codemod.mjs —— 代码级与包面确定性自动修补 CLI 工具。
//
// 为什么需要它：
// standards-scan 与 code-scan 能够发现代码与配置中的违规与破坏性变更。
// 对已确定有唯一安全解的问题（如入口四件套旁混用的 export default、宿主核心包 peer 依赖错位、
// 多余的值导出），本工具提供一键确定性语法变换与重构，消除手动修改的繁琐与二次出错。
//
// 默认 dry-run：只打印待应用的变换计划与变更行。
// 加 --apply 才落盘，落盘前自动将原文件备份至 <插件目录>/.pfa-backup/<时间戳>/。
//
// 用法:
//   node scripts/codemod.mjs <插件目录> [--apply] [--json] [--rule <id>]
//   node scripts/codemod.mjs --rules
// 退出码:
//   0: 干净无需修改，或 --apply 落盘成功
//   1: 存在待修补项（dry-run 提示）
//   2: 参数错误或插件读取失败

import fs from 'node:fs'
import path from 'node:path'
import { CODEMOD_RULES, planCodemods, applyCodemodPlan } from './lib/codemod.mjs'
import { readPluginSources, readLoadedModuleGraph } from './standards-scan.mjs'
import { printJson } from './lib/scanner.mjs'

function parseArgs(argv) {
  const out = { dir: null, apply: false, json: false, rules: false, focusRule: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--apply') out.apply = true
    else if (a === '--json') out.json = true
    else if (a === '--rules') out.rules = true
    else if (a === '--rule') out.focusRule = argv[++i] || null
    else if (a === '--help') out.help = true
    else if (a.startsWith('--')) {
      process.stderr.write(`未知参数「${a}」\n用法: node scripts/codemod.mjs <插件目录> [--apply] [--json] [--rule <id>] | --rules\n`)
      process.exit(2)
    } else if (!out.dir) out.dir = a
  }
  return out
}

export function runCodemodCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  if (args.help) {
    process.stderr.write(
      '用法: node scripts/codemod.mjs <插件目录> [--apply] [--json] [--rule <id>] | --rules\n' +
        '\n对机械可判的常设违规（Loader 入口导出面、宿主核心包 peer 依赖、顶层 await）执行确定性自动修补。\n' +
        '默认 dry-run 只打印计划；--apply 才落盘，落盘前自动备份到 <插件目录>/.pfa-backup/<时间戳>/。\n'
    )
    return 0
  }

  if (args.rules) {
    if (args.json) {
      printJson(CODEMOD_RULES)
      return 0
    }
    process.stdout.write('可用的确定性 Codemod 修补规则：\n\n')
    for (const r of CODEMOD_RULES) {
      process.stdout.write(`• ${r.id} (${r.safety} / ${r.severity})\n  ${r.title}\n  ${r.description}\n\n`)
    }
    return 0
  }

  if (!args.dir) {
    process.stderr.write('请指定插件目录。\n用法: node scripts/codemod.mjs <插件目录> [--apply] [--json] [--rule <id>]\n')
    return 2
  }

  const targetDir = path.resolve(args.dir)
  if (!fs.existsSync(targetDir)) {
    process.stderr.write(`插件目录不存在: ${targetDir}\n`)
    return 2
  }

  const pkgPath = path.join(targetDir, 'package.json')
  let pkg = null
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    } catch (e) {
      process.stderr.write(`package.json 无法解析: ${e.message}\n`)
      return 2
    }
  }

  // 读取模块图（优先宿主真实加载模块图，退回到全部源码）
  let files = []
  if (pkg) {
    const graph = readLoadedModuleGraph(targetDir, pkg)
    files = graph.files
  }
  if (!files || files.length === 0) {
    files = readPluginSources(targetDir)
  }

  const rulesFilter = args.focusRule ? [args.focusRule] : null
  const plan = planCodemods(targetDir, { files, pkg, rules: rulesFilter })

  if (args.json) {
    let result = { plan }
    if (args.apply && plan.hasChanges) {
      result.applied = applyCodemodPlan(targetDir, plan)
    }
    printJson(result)
    return 0
  }

  if (!plan.hasChanges) {
    process.stdout.write(`✓ ${path.basename(targetDir)}: 无需修补（所有检查项均合规）。\n`)
    return 0
  }

  process.stdout.write(`\n🔍 在「${path.basename(targetDir)}」中发现待修补项：\n`)

  if (plan.moves && plan.moves.length > 0) {
    process.stdout.write(`\n[包面依赖修补] 共 ${plan.moves.length} 处：\n`)
    for (const m of plan.moves) {
      process.stdout.write(`  • ${m.from} → ${m.to}\n    原因: ${m.why}\n`)
    }
  }

  if (plan.transforms && plan.transforms.length > 0) {
    process.stdout.write(`\n[代码重构修补] 共 ${plan.transforms.length} 处：\n`)
    for (const t of plan.transforms) {
      process.stdout.write(`  • ${t.file}:${t.line} [${t.rule}]\n    ${t.description}\n`)
      process.stdout.write(`    - 原代码: ${t.before.trim()}\n`)
      process.stdout.write(`    + 改为:   ${t.after.trim()}\n`)
    }
  }

  if (args.apply) {
    const res = applyCodemodPlan(targetDir, plan)
    process.stdout.write(`\n🚀 修补已落盘！已备份 ${res.backupFiles.length} 个文件至：\n   ${res.backupDir}\n`)
    process.stdout.write(`   已写入文件: ${res.writtenFiles.join(', ')}\n\n`)
    return 0
  }

  process.stdout.write('\n💡 当前为 dry-run 预览模式。若确认修补，请执行：\n')
  process.stdout.write(`   node scripts/codemod.mjs "${args.dir}" --apply\n\n`)
  return 1
}

// 直接运行 CLI
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  process.exit(runCodemodCli())
}
