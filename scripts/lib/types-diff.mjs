// lib/types-diff.mjs —— 基于 .d.ts 与包导出面的宿主类型与接缝差分引擎（方案 C）。
//
// 为什么需要它：
// 官方发版后，docs/upgrade-guide/ 经常滞后甚至漏写（实测 2026-11-05 官方漏写 rc 目录）。
// 导致扫描走廊出现「未知态」，自动化适配停摆。
//
// 第一性原理：
// 宿主发版的 npm 包或源码中包含的 package.json exports 映射与 .d.ts 类型声明文件，
// 是反映 API 存在性的第一手真源。
// 通过比对两版宿主导出的符号签名图谱（Types-Diff），可全自动提取出破坏性删除（REMOVED）
// 与变更（CHANGED），并在零人工文档介入的情况下自动合成虚拟指南，驱动扫描与 Codemod。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { prepareLexicalView } from './scanner.mjs'

const CACHE_ROOT = path.join(os.homedir(), '.cache', 'dsh-plugin-fast-adapt')
const SIGNATURES_DIR = path.join(CACHE_ROOT, 'signatures')
const SYNTHESIZED_GUIDES_DIR = path.join(CACHE_ROOT, 'synthesized-guides')

/**
 * 从单个 .d.ts 或 .ts 源码中提取导出符号表（具名函数、类、接口、类型、常量）。
 * 基于词法掩码，注释与字符串中的 export 不计入。
 * @param {string} source 源码
 * @returns {Array<{ name: string, kind: string, line: number }>}
 */
export function extractSymbolsFromDts(source) {
  const { code, mask, lineOf } = prepareLexicalView(source)
  const symbols = []
  const seen = new Set()

  // 1. export declare (function|class|const|let|var|interface|type) name
  //    export (async function|class|const|let|var|interface|type) name
  const declRe = /\bexport\s+(?:declare\s+)?(?:async\s+)?(function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m
  while ((m = declRe.exec(code)) !== null) {
    if (mask[m.index] === 0) { // CODE
      const kind = m[1].replace('*', '')
      const name = m[2]
      if (!seen.has(name)) {
        seen.add(name)
        symbols.push({ name, kind, line: lineOf(m.index) })
      }
    }
  }

  // 2. export { a, b as c }
  const listRe = /\bexport\s*\{([^}]*)\}/g
  while ((m = listRe.exec(code)) !== null) {
    if (mask[m.index] === 0) {
      for (const part of m[1].split(',')) {
        const item = part.trim()
        if (!item || item.startsWith('type ')) continue
        const exported = (item.split(/\s+as\s+/).pop() || item).trim()
        if (/^[A-Za-z_$][\w$]*$/.test(exported) && !seen.has(exported)) {
          seen.add(exported)
          symbols.push({ name: exported, kind: 'export', line: lineOf(m.index) })
        }
      }
    }
  }

  return symbols
}

/**
 * 提取单个包的完整导出签名。
 * @param {string} pkgDir 包根目录
 * @returns {{ package: string, version: string, subpaths: string[], symbols: Array<object> }}
 */
export function extractPackageSignature(pkgDir) {
  const pkgJsonPath = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) {
    throw new Error(`package.json 不存在: ${pkgDir}`)
  }

  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))
  const subpaths = []
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const key of Object.keys(pkg.exports)) {
      if (key.startsWith('.')) subpaths.push(key)
    }
  }

  // 定位类型声明入口文件
  let dtsFile = null
  const candNames = [
    pkg.types,
    pkg.typings,
    pkg.exports?.['.']?.types,
    pkg.exports?.['.']?.import?.types,
    'index.d.ts',
    'lib/index.d.ts',
    'dist/index.d.ts',
    pkg.main ? pkg.main.replace(/\.(?:js|mjs|cjs)$/, '.d.ts') : null,
  ].filter(Boolean)

  for (const cand of candNames) {
    const full = path.join(pkgDir, cand)
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      dtsFile = full
      break
    }
  }

  // 若没有 .d.ts，退回查找 .ts 源码或 .js 入口
  if (!dtsFile) {
    for (const fallback of ['src/index.ts', 'lib/index.js', 'index.js']) {
      const full = path.join(pkgDir, fallback)
      if (fs.existsSync(full) && fs.statSync(full).isFile()) {
        dtsFile = full
        break
      }
    }
  }

  let symbols = []
  if (dtsFile) {
    try {
      const source = fs.readFileSync(dtsFile, 'utf8')
      symbols = extractSymbolsFromDts(source)
    } catch {}
  }

  return {
    package: pkg.name || path.basename(pkgDir),
    version: pkg.version || '0.0.0',
    subpaths,
    dtsFile: dtsFile ? path.relative(pkgDir, dtsFile) : null,
    symbols,
  }
}

/**
 * 提取整套宿主（主包 + node_modules 内部套件子包）的签名图谱。
 * @param {string} hostLocation 宿主安装位置
 * @returns {{ version: string, packages: Record<string, object>, timestamp: number }}
 */
export function extractHostSignature(hostLocation) {
  const mainPkg = extractPackageSignature(hostLocation)
  const packages = { [mainPkg.package]: mainPkg }

  // 遍历 node_modules/@deepseek-ai/* 与 cordis/schemastery
  const nm = path.join(hostLocation, 'node_modules')
  if (fs.existsSync(nm)) {
    const scanDir = (dir, depth = 0) => {
      if (depth > 2) return
      let entries = []
      try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (!e.isDirectory() && !e.isSymbolicLink()) continue
        if (e.name.startsWith('.')) continue
        const full = path.join(dir, e.name)
        if (e.name.startsWith('@')) {
          scanDir(full, depth + 1)
          continue
        }
        if (fs.existsSync(path.join(full, 'package.json'))) {
          try {
            const sig = extractPackageSignature(full)
            packages[sig.package] = sig
          } catch {}
        }
      }
    }
    scanDir(nm, 0)
  }

  return {
    version: mainPkg.version,
    packages,
    timestamp: Date.now(),
  }
}

/**
 * 对比两套签名，计算精确的破坏性变更差分。
 * @param {object} baseSig 基线（旧版）签名
 * @param {object} targetSig 目标（新版）签名
 * @returns {{ fromVersion: string, toVersion: string, breakingCount: number, changes: Array<object> }}
 */
export function diffTypeSignatures(baseSig, targetSig) {
  const changes = []
  const basePkgs = baseSig?.packages || {}
  const targetPkgs = targetSig?.packages || {}

  // 1. 消失的包（REMOVED_PACKAGE）
  for (const pkgName of Object.keys(basePkgs)) {
    if (!targetPkgs[pkgName]) {
      changes.push({
        type: 'REMOVED_PACKAGE',
        package: pkgName,
        severity: 'critical',
        priority: 'P0',
        description: `宿主包「${pkgName}」在目标版本 ${targetSig?.version || 'new'} 中已不复存在。`,
      })
    }
  }

  // 2. 包内导出的子路径与符号变更
  for (const [pkgName, bPkg] of Object.entries(basePkgs)) {
    const tPkg = targetPkgs[pkgName]
    if (!tPkg) continue

    // 子路径消失（如 ./settings 变成独立包或被移除）
    if (bPkg.subpaths && bPkg.subpaths.length > 0) {
      const targetSubpaths = new Set(tPkg.subpaths || [])
      for (const sp of bPkg.subpaths) {
        if (!targetSubpaths.has(sp)) {
          changes.push({
            type: 'REMOVED_SUBPATH',
            package: pkgName,
            subpath: sp,
            severity: 'critical',
            priority: 'P0',
            description: `包「${pkgName}」的导出子路径「${sp}」在新版本中已被移除。`,
          })
        }
      }
    }

    // 导出的具名符号消失（如方法改名或删除）
    if (bPkg.symbols && bPkg.symbols.length > 0) {
      const targetSymbols = new Set((tPkg.symbols || []).map((s) => s.name))
      for (const sym of bPkg.symbols) {
        if (!targetSymbols.has(sym.name)) {
          changes.push({
            type: 'REMOVED_SYMBOL',
            package: pkgName,
            symbol: sym.name,
            kind: sym.kind,
            severity: 'high',
            priority: 'P0',
            description: `导出符号「${sym.name}」已从包「${pkgName}」的类型定义中移除。`,
          })
        }
      }
    }
  }

  return {
    fromVersion: baseSig?.version || 'unknown',
    toVersion: targetSig?.version || 'unknown',
    breakingCount: changes.filter((c) => c.priority === 'P0').length,
    changes,
  }
}

/**
 * 将类型差分全自动合成为虚拟指南（Synthetic Type Guides），
 * 直接兼容 code-scan 与 seams 的消费模型，消除官方发版后指南滞后的空白期。
 * @param {object} diff diffTypeSignatures 产物
 * @returns {Array<object>} 兼容 loadGuides 的指南列表
 */
export function synthesizeGuidesFromDiff(diff) {
  const guides = []
  const version = diff.toVersion
  let idx = 1

  for (const ch of diff.changes) {
    const topic = `types-diff-${ch.package.replace(/[@/]/g, '-')}-${ch.symbol || (ch.subpath ? ch.subpath.replace(/[./]/g, '') : 'pkg')}`
    const anchors = {
      packages: [ch.package],
      members: ch.symbol ? [ch.symbol] : [],
      codes: [],
    }

    guides.push({
      version,
      topic,
      guideFile: `types-diff/${version}.json#${idx}`,
      titleLine: idx,
      title: ch.description,
      description: ch.description,
      change: ch.description,
      migration: `在版本 ${version} 中，${ch.package}${ch.symbol ? `.${ch.symbol}` : ''} 已不再导出。请检查调用点并迁移至新符号。`,
      anchors,
      virtual: true,
      source: 'types-diff',
    })
    idx++
  }

  return guides
}

/**
 * 保存版本签名至本地缓存。
 * @param {string} version 版本号
 * @param {object} signature 签名对象
 */
export function saveCachedSignature(version, signature) {
  fs.mkdirSync(SIGNATURES_DIR, { recursive: true })
  const file = path.join(SIGNATURES_DIR, `${version}.json`)
  fs.writeFileSync(file, JSON.stringify(signature, null, 2), 'utf8')
  return file
}

/**
 * 读取已缓存的版本签名。
 * @param {string} version 版本号
 * @returns {object|null}
 */
export function loadCachedSignature(version) {
  const file = path.join(SIGNATURES_DIR, `${version}.json`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
