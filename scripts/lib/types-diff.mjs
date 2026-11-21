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
import zlib from 'node:zlib'
import { prepareLexicalView, compareVersions } from './scanner.mjs'
import { cacheRoot } from './cache-root.mjs'

// 缓存根每次调用时求值（DSH_PFA_CACHE_DIR 可覆盖），自检才能把签名缓存隔离到
// 临时目录。此前这里是模块级常量，`签名本地缓存存取闭环` 会去写真实 ~/.cache，
// 在只读 HOME 或沙箱里直接 EPERM 失败——同一份自检里 runlog 早已支持注入，
// 两套隔离标准让自检结果依赖机器状态。
function signaturesDir() {
  return path.join(cacheRoot(), 'signatures')
}
// 合成指南按「差分基线版本」命名落盘（<base>.json）：code-scan 消费时只认
// 「基线 == 扫描窗口起点」的文件。差分从更早的基线算起会包含窗口前的移除
// （插件按 peer 下限声明根本没用过它们，报了就是误报），从更晚的基线算起会
// 漏掉窗口内的移除，只有恰好相等才精确。
export function synthesizedGuidesDir() {
  return path.join(cacheRoot(), 'synthesized-guides')
}


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
  const dir = signaturesDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${version}.json`)
  fs.writeFileSync(file, JSON.stringify(signature, null, 2), 'utf8')
  return file
}

/**
 * 读取已缓存的版本签名。
 * @param {string} version 版本号
 * @returns {object|null}
 */
export function loadCachedSignature(version) {
  const file = path.join(signaturesDir(), `${version}.json`)
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 把合成指南按基线版本落盘。同基线重算即覆盖（移除只会累积，新差分是旧差分的超集）；
 * 不同基线各占一份文件，互不覆盖——code-scan 按窗口起点精确取用。
 * @param {string} baseVersion 差分基线（扫描窗口起点）
 * @param {Array<object>} guides synthesizeGuidesFromDiff 产物
 * @returns {string} 写入的文件路径
 */
export function writeSynthesizedGuides(baseVersion, guides, opts = {}) {
  // 写侧与读侧对称：loadSynthesizedGuides 早就支持 rootDir，写侧此前硬编码默认目录，
  // 于是「能读自定义目录，但没有任何代码路径会往自定义目录写」——参数链只通了半条。
  const rootDir = opts.rootDir || synthesizedGuidesDir()
  fs.mkdirSync(rootDir, { recursive: true })
  const file = path.join(rootDir, `${baseVersion}.json`)
  const payload = {
    from: baseVersion,
    to: guides[0]?.version ?? null,
    generatedAt: new Date().toISOString(),
    guides,
  }
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  return file
}

/**
 * 读取某个基线版本落盘的合成指南。缺文件或内容损坏一律返回空数组——
 * 消费方（code-scan）不该为合成面的缺失失败，官方指南照常扫。
 * @param {string|null} baseVersion 差分基线（扫描窗口起点）；null 表示不消费
 * @param {{ maxVersion?: string|null, rootDir?: string }} [opts] maxVersion 只保留 to <= maxVersion 的指南（防降级窗口吃进未来变更）；rootDir 覆盖落盘根目录（code-scan 的第五个参数传进来的那个目录），默认取 SYNTHESIZED_GUIDES_DIR
 * @returns {Array<object>} 兼容 loadGuides 形状的指南列表
 */
export function loadSynthesizedGuides(baseVersion, opts = {}) {
  if (!baseVersion) return []
  const rootDir = opts.rootDir || synthesizedGuidesDir()
  const file = path.join(rootDir, `${baseVersion}.json`)
  if (!fs.existsSync(file)) return []
  try {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(payload?.guides)) return []
    if (opts.maxVersion && payload.to && compareVersions(payload.to, opts.maxVersion) > 0) return []
    return payload.guides
  } catch {
    return []
  }
}

/**
 * 零依赖轻量 tar 解包器：仅提取 package.json 与 .d.ts 文本文件，跳过所有二进制/源码块。
 * 遵循标准 POSIX ustar 512 字节头，用于从 npm tarball 免装机抽取历史版本 API 签名。
 * @param {Buffer} tarBuf 解压后的 tar Buffer
 * @returns {Map<string, string>} 相对包根路径 -> UTF-8 内容
 */
export function parseTarTextEntries(tarBuf) {
  const files = new Map()
  let offset = 0
  const len = tarBuf.length
  while (offset + 512 <= len) {
    const header = tarBuf.subarray(offset, offset + 512)
    // 全零块表示归档结束
    let allZero = true
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) { allZero = false; break }
    }
    if (allZero) break

    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    const rawPrefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '')
    const fullName = rawPrefix ? `${rawPrefix}/${rawName}` : rawName
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    const typeFlag = String.fromCharCode(header[156] || 48)
    const dataStart = offset + 512
    const nextOffset = dataStart + Math.ceil(size / 512) * 512

    if ((typeFlag === '0' || typeFlag === '\0') && size > 0 && dataStart + size <= len) {
      // 剥离 npm tarball 首层 package/ 前缀
      const rel = fullName.replace(/^[^/]+\//, '')
      if (rel === 'package.json' || rel.endsWith('.d.ts')) {
        files.set(rel, tarBuf.subarray(dataStart, dataStart + size).toString('utf8'))
      }
    }
    offset = nextOffset
  }
  return files
}

/**
 * 从 npm .tgz Buffer 直接提取单包签名图谱（0 外部依赖，无需装包）。
 * @param {Buffer} gzBuf gzip 压缩的 npm tarball
 * @param {{ fallbackVersion?: string }} [opts]
 */
export function extractSignatureFromTarballBuffer(gzBuf, { fallbackVersion = '0.0.0' } = {}) {
  const tarBuf = zlib.gunzipSync(gzBuf)
  const files = parseTarTextEntries(tarBuf)
  const pkgRaw = files.get('package.json')
  if (!pkgRaw) throw new Error('tarball 缺少 package.json')
  const pkg = JSON.parse(pkgRaw.replace(/^\uFEFF/, ''))

  const subpaths = []
  if (pkg.exports && typeof pkg.exports === 'object') {
    for (const key of Object.keys(pkg.exports)) {
      if (key.startsWith('.')) subpaths.push(key)
    }
  }

  const candNames = [
    pkg.types,
    pkg.typings,
    pkg.exports?.['.']?.types,
    pkg.exports?.['.']?.import?.types,
    'index.d.ts',
    'lib/index.d.ts',
    'dist/index.d.ts',
    pkg.main ? pkg.main.replace(/\.(?:js|mjs|cjs)$/, '.d.ts') : null,
  ]
    .filter(Boolean)
    .map((p) => String(p).replace(/^\.\//, ''))

  let dtsFile = null
  let symbols = []
  for (const cand of candNames) {
    if (files.has(cand)) {
      dtsFile = cand
      symbols = extractSymbolsFromDts(files.get(cand))
      break
    }
  }

  const pkgName = pkg.name || '@deepseek-ai/dsh'
  const version = pkg.version || fallbackVersion
  const pkgSig = { package: pkgName, version, subpaths, dtsFile, symbols }
  return {
    version,
    packages: { [pkgName]: pkgSig },
    source: 'npm-tarball',
    timestamp: Date.now(),
  }
}

/**
 * 按需从 npm registry 拉取指定版本的 tarball 并抽签名落盘缓存（补齐离线旧版基线 F3）。
 * @param {string} version 目标版本号（如 0.2.2-rc.3）
 * @param {{ pkgName?: string, fetcher?: typeof fetch, save?: boolean }} [opts]
 */
export async function fetchVersionSignatureFromNpm(
  version,
  { pkgName = '@deepseek-ai/dsh', fetcher = null, save = true } = {},
) {
  const bare = String(version).replace(/^v/, '')
  const cached = loadCachedSignature(bare)
  if (cached) return { signature: cached, source: 'cache', savedFile: null }

  const doFetch = fetcher || ((url, init) => fetch(url, init))
  const encoded = encodeURIComponent(pkgName).replace('%40', '@')
  const metaRes = await doFetch(`https://registry.npmjs.org/${encoded}/${bare}`, { signal: AbortSignal.timeout(15000) })
  if (!metaRes.ok) throw new Error(`npm registry 返回 ${metaRes.status}（${pkgName}@${bare}）`)
  const meta = await metaRes.json()
  const tarballUrl = meta?.dist?.tarball
  if (!tarballUrl) throw new Error(`${pkgName}@${bare} 缺少 dist.tarball`)

  const tgzRes = await doFetch(tarballUrl, { signal: AbortSignal.timeout(30000) })
  if (!tgzRes.ok) throw new Error(`下载 tarball 失败 (${tgzRes.status}): ${tarballUrl}`)
  const gzBuf = Buffer.from(await tgzRes.arrayBuffer())
  const signature = extractSignatureFromTarballBuffer(gzBuf, { fallbackVersion: bare })
  const savedFile = save ? saveCachedSignature(bare, signature) : null
  return { signature, source: 'npm-tarball', savedFile }
}
