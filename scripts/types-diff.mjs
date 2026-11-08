#!/usr/bin/env node
// types-diff.mjs —— 宿主 TypeScript 声明与导出面差分 CLI 工具（方案 C）。
//
// 为什么需要它：
// 官方发版后，升级指南经常滞后数天或漏写。
// 本工具通过直接提取宿主 package.json 导出面与 .d.ts 类型声明文件的符号图谱，
// 自动计算两版之间的破坏性 API 删除（REMOVED_SYMBOL / REMOVED_PACKAGE），
// 并自动合成虚拟指南，实现官方发版后零等待的自动化适配。
//
// 用法:
//   node scripts/types-diff.mjs --from <旧版/旧路径> --to <新版/新路径> [--json]
//   node scripts/types-diff.mjs --current [--save]
// 退出码:
//   0: 无破坏性变更，或成功提取/保存
//   1: 发现破坏性 API 删除/包移除
//   2: 参数错误或路径不存在

import fs from 'node:fs'
import path from 'node:path'
import {
  extractPackageSignature,
  extractHostSignature,
  diffTypeSignatures,
  synthesizeGuidesFromDiff,
  writeSynthesizedGuides,
  saveCachedSignature,
  loadCachedSignature,
} from './lib/types-diff.mjs'
import { findGlobalDsh } from './env-doctor.mjs'
import { printJson } from './lib/scanner.mjs'
import { readPackageJson } from './lib/package-json.mjs'

function parseArgs(argv) {
  const out = { from: null, to: null, current: false, save: false, json: false, synth: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i]
    else if (a === '--to') out.to = argv[++i]
    else if (a === '--current') out.current = true
    else if (a === '--save') out.save = true
    else if (a === '--json') out.json = true
    else if (a === '--synth') out.synth = true
    else if (a === '--help') out.help = true
    else if (a.startsWith('--')) {
      process.stderr.write(`未知参数「${a}」\n用法: node scripts/types-diff.mjs --from <旧> --to <新> [--json] | --current [--save]\n`)
      process.exit(2)
    }
  }
  return out
}

function resolveSig(spec) {
  // 1. 若是本地路径
  const abs = path.resolve(spec)
  if (fs.existsSync(abs)) {
    if (fs.existsSync(path.join(abs, 'node_modules'))) {
      return extractHostSignature(abs)
    }
    return {
      version: readPackageJson(abs)?.version || 'custom',
      packages: { [path.basename(abs)]: extractPackageSignature(abs) },
      timestamp: Date.now(),
    }
  }
  // 2. 若是缓存的版本号
  const cached = loadCachedSignature(spec)
  if (cached) return cached
  throw new Error(`找不到签名来源（既非本地路径，亦无缓存版本签名）: ${spec}`)
}

export function runTypesDiffCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  if (args.help) {
    process.stderr.write(
      '用法: node scripts/types-diff.mjs --from <旧版/路径> --to <新版/路径> [--json] [--synth]\n' +
        '      node scripts/types-diff.mjs --current [--save] [--json]\n\n' +
        '通过对比宿主前后两版 .d.ts 与导出面，全自动计算破坏性变更（REMOVED），生成自动适配虚拟指南。\n'
    )
    return 0
  }

  // 模式 1：提取当前宿主签名
  if (args.current || (!args.from && !args.to)) {
    const host = findGlobalDsh()
    if (!host || !host.location) {
      process.stderr.write('未检测到本机已安装的 DSH 宿主。\n')
      return 2
    }
    const sig = extractHostSignature(host.location)
    let savedFile = null
    if (args.save) {
      savedFile = saveCachedSignature(sig.version, sig)
    }

    if (args.json) {
      printJson({ signature: sig, savedFile })
      return 0
    }

    process.stdout.write(`✓ 已提取宿主 v${sig.version} 签名（包含 ${Object.keys(sig.packages).length} 个核心套件包）：\n`)
    for (const [name, p] of Object.entries(sig.packages)) {
      process.stdout.write(`  • ${name}@${p.version} (导出符号: ${p.symbols.length} 个, 子路径: ${p.subpaths.length} 个)\n`)
    }
    if (savedFile) {
      process.stdout.write(`\n💾 已缓存版本签名至: ${savedFile}\n`)
    }
    return 0
  }

  // 模式 2：两版差分
  if (!args.from || !args.to) {
    process.stderr.write('差分模式必须同时指定 --from 与 --to。\n')
    return 2
  }

  let baseSig, targetSig
  try {
    baseSig = resolveSig(args.from)
    targetSig = resolveSig(args.to)
  } catch (err) {
    process.stderr.write(`签名提取失败: ${err.message}\n`)
    return 2
  }

  const diff = diffTypeSignatures(baseSig, targetSig)
  let guides = []
  let synthFile = null
  if (args.synth) {
    guides = synthesizeGuidesFromDiff(diff)
    if (guides.length > 0) {
      // 按基线版本落盘：code-scan 拿窗口起点来取，基线对不上不消费（防跨窗口误报）。
      synthFile = writeSynthesizedGuides(diff.fromVersion, guides)
    }
  }

  if (args.json) {
    printJson({ diff, guides, synthFile })
    return diff.breakingCount > 0 ? 1 : 0
  }

  process.stdout.write(`\n🔍 宿主类型与导出面差分报告: v${diff.fromVersion} → v${diff.toVersion}\n`)
  if (diff.changes.length === 0) {
    process.stdout.write('✓ 两版本间未发现任何导出包或符号的破坏性删除，API 表面完全向前兼容。\n\n')
    return 0
  }

  process.stdout.write(`⚠ 发现 ${diff.changes.length} 处变更（其中 P0 阻断性删除: ${diff.breakingCount} 处）：\n\n`)
  for (const ch of diff.changes) {
    const mark = ch.priority === 'P0' ? '❌ [P0 阻断]' : 'ℹ [变更]'
    process.stdout.write(`  ${mark} ${ch.description}\n`)
  }

  if (args.synth && guides.length > 0) {
    process.stdout.write(`\n🚀 已合成 ${guides.length} 条虚拟破坏性指南并落盘: ${synthFile}\n`)
    process.stdout.write(`   code-scan 传第五个参数（合成指南目录）后，窗口起点 = ${diff.fromVersion} 的扫描会自动并入这批指南。\n`)
  }
  process.stdout.write('\n')

  return diff.breakingCount > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  process.exit(runTypesDiffCli())
}
