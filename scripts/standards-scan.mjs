#!/usr/bin/env node
// standards-scan.mjs —— 上游常设规则的机器检出（把人工核对升级为扫描）。
//
// 与 code-scan 的分工：code-scan 查「随版本变的破坏性变更」，本脚本查
// 「不随版本变的常设硬要求」（docs/defensive-patterns/）。两者互不覆盖——
// 一份插件可以通过全部升级指南扫描，仍然违反常设要求。
//
// 与 plugin-audit 的关系：同样的规则也作为第 5 维进了 plugin-audit（standards），
// 本脚本是它的单兵入口与规则清单出口，规则表只有一份（lib/standards.mjs）。
//
// 用法:
//   node scripts/standards-scan.mjs <插件目录> [--json] [--compact] [--rule <id>]
//   node scripts/standards-scan.mjs --rules
// 退出码: 0 无命中；2 有 P0/P1 命中。

import fs from 'node:fs'
import path from 'node:path'
import { scanStandards, standardsScore, STANDARDS_RULES } from './lib/standards.mjs'
import { findSourceFiles, pickScanRoots } from './code-scan.mjs'
import { printJson } from './lib/scanner.mjs'

function parseArgs(argv) {
  const out = { dir: null, json: false, compact: false, rules: false, focusRule: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--compact') out.compact = true
    else if (a === '--rules') out.rules = true
    else if (a === '--rule') out.focusRule = argv[++i] || null
    else if (a.startsWith('--')) {
      process.stderr.write(`未知参数「${a}」\n用法: node scripts/standards-scan.mjs <插件目录> [--json] [--compact] [--rule <id>] | --rules\n`)
      process.exit(1)
    } else if (!out.dir) out.dir = a
  }
  return out
}

/**
 * 读插件源码（复用 code-scan 的扫描根判定：src 与同级 client/web/ui 都扫，
 * lib/dist 只在没有任何源码根时退回）。
 * @param {string} dir 插件根
 * @returns {Array<{file: string, source: string}>} 源码清单
 */
export function readPluginSources(dir, { extraRoots = null } = {}) {
  const files = findSourceFiles(dir, extraRoots || pickScanRoots(dir))
  return files.map((abs) => ({
    file: path.relative(dir, abs).split(path.sep).join('/'),
    source: fs.readFileSync(abs, 'utf8'),
  }))
}

/**
 * 求「宿主真正加载的模块图」：从包面入口沿相对 import 走，只收落到包内的文件。
 *
 * 为什么不用 pickScanRoots，也不看 files 名单：
 *   - pickScanRoots 在没有 src/ 时退回整个插件目录，仓库自己的 CLI 脚本
 *     （scripts/run.mjs 那类）被当成包模块，那里模块级 `let` 是正当的控制流状态。
 *     2026-11-05 实测：本工具自扫 21 处命中，逐条核对全是 scripts/ 下的 CLI 状态，零可信违规。
 *   - files 名单也不对：本包把 scripts/** 发出去是为了让用户能跑 CLI，但那不等于
 *     那些模块会被宿主当插件加载。
 *   - 所以判据回到规则本身：规则讲的是「包模块」的模块级状态，能被宿主加载的模块
 *     就是入口加它 import 出来的那批。`scripts/` 不在任何入口的 import 图里，自然出局。
 * @param {string} dir 插件根
 * @param {object} pkg 解析后的 package.json
 * @returns {{ files: Array<{file: string, source: string}>, entries: string[] }} 加载面
 */
export function readLoadedModuleGraph(dir, pkg) {
  // 同一份逻辑存在源码与构建产物两份时，只查一份：源码存在就查源码。
  // 查两份的代价是同一处违规报两遍（dsh-client-ui-task-board 实测 2 → 4），
  // 而人还得自己看出是同一件事。挑源码是因为那是作者能改的那一份。
  const hasSource = ['src', 'client', 'web', 'ui'].some((d) => fs.existsSync(path.join(dir, d)))
  if (hasSource) {
    const files = readPluginSources(dir, { extraRoots: ['src', 'client', 'web', 'ui'].map((d) => path.join(dir, d)).filter((f) => fs.existsSync(f)) })
    const mainRel = typeof pkg?.main === 'string' ? pkg.main.replace(/^\.\//, '') : null
    const mainBase = mainRel ? path.basename(mainRel).replace(/\.(?:js|mjs|cjs)$/, '') : 'index'
    const entry =
      files.find((f) => f.file.endsWith(`/${mainBase}.ts`) || f.file.endsWith(`/${mainBase}.tsx`) || f.file === `${mainBase}.ts` || f.file === `${mainBase}.tsx`)?.file ||
      files.find((f) => /(?:^|\/)index\.(?:ts|tsx)$/.test(f.file))?.file ||
      files[0]?.file ||
      null
    return { files, entries: entry ? [entry] : [] }
  }

  const entryPaths = []
  const addEntry = (p) => {
    if (typeof p !== 'string' || !p.startsWith('./')) return
    const rel = p.slice(2)
    // .d.ts 是类型面不是运行时面：拿它当入口会把加载图整个走偏
    if (!rel || /\.d\.[cm]?ts$/.test(rel)) return
    if (!entryPaths.includes(rel)) entryPaths.push(rel)
  }
  addEntry(pkg?.main)
  addEntry(pkg?.module)
  // exports 的 "." 键才是包根入口，子路径（./client 等）单独收
  const walk = (node) => {
    if (typeof node === 'string') return addEntry(node)
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { if (k === '.') walk(v); else walk(v) }
  }
  walk(pkg?.exports)
  for (const c of ['lib/index.js', 'src/index.ts', 'index.js']) if (fs.existsSync(path.join(dir, c))) addEntry(`./${c}`)
  if (entryPaths.length === 0) return { files: [], entries: [] }

  const seen = new Set()
  const out = []
  const queue = [...entryPaths]
  while (queue.length) {
    const rel = queue.shift()
    if (!rel || seen.has(rel)) continue
    seen.add(rel)
    const abs = path.resolve(dir, rel)
    // 只收包内的普通文件，且拒绝跑出包根（cross-package-relative-import 单独报）
    const inside = path.relative(dir, abs)
    if (inside.startsWith('..') || path.isAbsolute(inside) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
    const source = fs.readFileSync(abs, 'utf8')
    out.push({ file: inside.split(path.sep).join('/'), source })
    // 解析相对 import（含动态 import），带 .js 后缀与目录 index 两种兜底
    const re = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g
    let m
    while ((m = re.exec(source)) !== null) {
      const spec = m[1] || m[2]
      if (!spec || !spec.startsWith('.')) continue
      const base = path.dirname(rel)
      const cand = [path.join(base, spec), `${path.join(base, spec)}.js`, path.join(base, spec, 'index.js')]
      for (const c of cand) {
        if (fs.existsSync(path.resolve(dir, c)) && fs.statSync(path.resolve(dir, c)).isFile()) {
          queue.push(c.split(path.sep).join('/'))
          break
        }
      }
    }
  }
  return { files: out, entries: entryPaths }
}

export function runStandardsScan(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  if (args.rules) {
    const payload = {
      rules: STANDARDS_RULES.map((r) => ({
        id: r.id,
        title: r.title,
        priority: r.priority,
        severity: r.severity,
        upstream: r.upstream,
        note: r.note,
      })),
      count: STANDARDS_RULES.length,
      source: 'docs/defensive-patterns/',
      note: '规则表只有一份（scripts/lib/standards.mjs），plugin-audit 的 standards 维度用的是同一份。',
    }
    if (args.json) printJson(payload)
    else {
      process.stderr.write(`常设规则检出表（${payload.count} 条，出处 ${payload.source}）\n\n`)
      for (const r of payload.rules) {
        process.stderr.write(`  [${r.priority}] ${r.id}\n        ${r.title}\n        ${r.upstream}\n        ${r.note}\n\n`)
      }
      process.stderr.write('需要意图判断的条目不在这里（dispose 是否真停稳、回调异常是否隔离、slot 注册物是否稳定），那些留在 review 车道人工核对。\n')
    }
    return 0
  }

  const dir = path.resolve(args.dir || process.cwd())
  if (!fs.existsSync(path.join(dir, 'package.json'))) {
    process.stderr.write(`找不到 package.json: ${path.join(dir, 'package.json')}\n`)
    return 1
  }

  let pkg = null
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {}
  const graph = readLoadedModuleGraph(dir, pkg)
  // 包面没有任何可加载入口（纯工具仓的极端形态）时退回源码根，避免「零文件零命中」冒充干净
  const sources = graph.files.length ? graph.files : readPluginSources(dir)
  const result = scanStandards(dir, { files: sources, entryFile: graph.files.length ? graph.entries[0] : null })
  const findings = args.focusRule ? result.findings.filter((f) => f.rule === args.focusRule) : result.findings
  const score = standardsScore(findings)
  const blockers = findings.filter((f) => f.priority === 'P0' || f.priority === 'P1')

  if (args.compact || args.json) {
    printJson({
      plugin: path.basename(dir),
      root: dir,
      entry: result.entry,
      exportNames: result.exportNames,
      standardsScore: score,
      findingCount: findings.length,
      ruleCount: STANDARDS_RULES.length,
      blockers: blockers.map((f) => ({ priority: f.priority, rule: f.rule, file: f.file, line: f.line, title: f.title, evidence: f.evidence })),
      findings,
    })
    return blockers.length ? 2 : 0
  }

  printJson({ plugin: path.basename(dir), standardsScore: score, findingCount: findings.length, findings })
  process.stderr.write(
    `\n插件: ${path.basename(dir)}（扫 ${result.scannedFiles} 个文件，入口 ${result.entry || '未识别'}）\n` +
      `常设规则分: ${score}/100（${STANDARDS_RULES.length} 条规则，命中 ${findings.length} 处）\n`
  )
  if (blockers.length) process.stderr.write(`下一步: ${blockers.length} 处 P0/P1，逐条按 upstream 指出的原文核对后修\n`)
  return blockers.length ? 2 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(runStandardsScan())
}
