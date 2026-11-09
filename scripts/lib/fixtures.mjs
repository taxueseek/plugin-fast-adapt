// lib/fixtures.mjs —— 事故夹具的全量回归。
//
// 为什么需要它：每一轮实战修掉的误报/漏报都是一次性消耗品。第一轮的
// 「判据收窄过三轮（35 处全误报）」这种教训，换台机器重跑就没了。夹具把
// 「真实事故的最小复现」沉淀成可执行判据，自检启动时全量跑一遍——
// 判据写松了（该报的不报）或写紧了（不该报的报了）都会红。
//
// 夹具形状（与 jscodeshift 的 __testfixtures__ 同构）：
//   fixtures/<id>/input/        最小复现（插件目录或环境构造所需文件）
//   fixtures/<id>/expected.json 正确判定 + fingerprint + 事故来源
//
// expected.json 的 check.kind 决定怎么跑：
//   standards  对 input 跑 scanStandards，按 assert 判命中数
//   scan       对 input 跑 code-scan 的扫描器，按 anchors 构造锚点
//   env        直接跑 lib/proc-env.mjs 的判定，按 env 给环境
//   pkg        对 input 跑 package-json 三态探测（input 目录的 package.json 带 BOM）
//
// fingerprint 是这条事故的稳定键（去重键），与 incident-ledger 的 id 对应。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanStandards } from './standards.mjs'
import { scanPlugin } from '../code-scan.mjs'
import { parseGuideMarkdown, extractAnchors } from './guide-parser.mjs'
import { gitChildEnv, removeDirSafely } from './proc-env.mjs'
import { probePackageJson, readPackageJson } from './package-json.mjs'

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures')

/** 夹具 id 清单（按目录名排序，输出稳定）。 */
export function listFixtures(dir = FIXTURES_DIR) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/**
 * 读一个夹具的 expected.json。缺文件或坏 JSON 直接抛——夹具本身就是契约，
 * 读不出来是夹具坏了，不是「跳过」。
 * @param {string} id 夹具 id
 */
export function loadExpected(id, dir = FIXTURES_DIR) {
  const file = path.join(dir, id, 'expected.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** 夹具的 input 目录（插件根）。 */
export function inputDir(id, dir = FIXTURES_DIR) {
  return path.join(dir, id, 'input')
}

/**
 * 把 expected.check 的 assert 表达式求值。
 *
 * 断言写成字符串而不是函数，是为了让 expected.json 保持纯数据（可 diff、可审阅、
 * 可双向对账）。求值只暴露几个具名变量，不用 eval 的全量作用域。
 * @param {string} expr 断言表达式
 * @param {Record<string, unknown>} scope 具名变量
 */
function evaluateAssert(expr, scope) {
  const names = Object.keys(scope)
  const values = names.map((n) => scope[n])
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `"use strict"; return (${expr});`)
  return fn(...values)
}

/**
 * 把夹具的 input 目录读成 scanStandards 需要的 files 清单。
 * 只收源码文件（与 code-scan 的 SOURCE_EXT 一致），路径相对 input 根。
 */
function readInputSources(root) {
  const exts = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
  const skip = new Set(['node_modules', '.git', 'dist', '.trash', 'coverage'])
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (exts.has(path.extname(e.name))) {
        out.push({
          file: path.relative(root, full).split(path.sep).join('/'),
          source: fs.readFileSync(full, 'utf8'),
        })
      }
    }
  }
  walk(root)
  return out
}

const CHECKERS = {
  // 常设规则：对 input 跑 scanStandards，断言命中数
  standards(id, check) {
    const dir = inputDir(id)
    const result = scanStandards(dir, { files: readInputSources(dir) })
    const hits = (rule) => result.findings.filter((f) => f.rule === rule).length
    return {
      pass: evaluateAssert(check.assert, { findings: result.findings, hits }),
      detail: { findingCount: result.findings.length, findings: result.findings.map((f) => ({ rule: f.rule, file: f.file, line: f.line })) },
    }
  },

  // 破坏性变更扫描：按 check.anchors 构造一份指南再扫 input。
  // 常量锚点直接按 codes 列表构造（它们是 SCREAMING_SNAKE 错误码形态，
  // 不经 extractAnchors 的「移除动词同句」语义门——夹具要钉的是词边界匹配，
  // 不是锚点抽取；抽取规则由 plan-a 的用例单独覆盖）。
  scan(id, check) {
    const dir = inputDir(id)
    const codes = check.anchors?.codes || []
    const packages = check.anchors?.packages || []
    const guides = [{
      version: 'v0.2.2-test',
      topic: 'fixture',
      guideFile: 'fixture/guide.md',
      titleLine: 1,
      title: 'fixture guide',
      description: '',
      change: 'Change',
      migration: 'Migration',
      anchors: {
        packages,
        members: [],
        codes,
        introduced: [],
      },
      virtual: false,
    }]
    const result = scanPlugin(dir, guides, { localVersion: '0.2.1', targetVersion: '0.2.2', verifyHost: false })
    return {
      pass: evaluateAssert(check.assert, { findings: result.findings }),
      detail: { findingCount: result.findingCount, findings: result.findings.map((f) => ({ kind: f.kind, symbol: f.symbol, line: f.line })) },
    }
  },

  // 环境判定：lib/proc-env.mjs 的净化与链接安全
  env(id, check) {
    const scope = {
      gitChildEnv,
      removeDirSafely,
      env: check.env || {},
    }
    // 链接形态要在临时目录里真建一个链接再判
    if (/removeDirSafely\(link\)/.test(check.assert)) {
      const base = fs.mkdtempSync(path.join(path.dirname(FIXTURES_DIR), 'pfa-fixture-'))
      try {
        const target = path.join(base, 'target')
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
        const link = path.join(base, 'link')
        try {
          fs.symlinkSync(target, link, 'dir')
        } catch {
          // Windows 建符号链接需特权；junction 走同一条 unlink 路径，这里用目录链接的同构形态代替
          return { pass: true, skipped: '本机不允许建符号链接', detail: null }
        }
        scope.link = link
        scope.targetKept = () => fs.existsSync(path.join(target, 'keep.txt'))
        const pass = evaluateAssert(check.assert, scope)
        return { pass, detail: { linkKind: 'symlink', targetStillThere: fs.existsSync(path.join(target, 'keep.txt')) } }
      } finally {
        removeDirSafely(base)
      }
    }
    return { pass: evaluateAssert(check.assert, scope), detail: { env: check.env || {} } }
  },

  // package.json 三态：input 目录的 package.json 带 BOM（写入时由夹具保证）
  pkg(id, check) {
    const dir = inputDir(id)
    const probe = probePackageJson(dir)
    const pkg = readPackageJson(dir)
    return {
      pass: evaluateAssert(check.assert, { probePackageJson, readPackageJson, dir, probe, pkg }),
      detail: { probe: { status: probe.status, bom: probe.bom }, version: pkg?.version ?? null },
    }
  },
}
/**
 * 跑全量夹具回归。
 * @param {{ dir?: string, ids?: string[] }} [opts]
 * @returns {{ total: number, passed: number, failed: Array<{ id: string, error: string, detail: unknown }>, skipped: Array<{ id: string, reason: string }> }}
 */
export function runFixtures({ dir = FIXTURES_DIR, ids = null } = {}) {
  const all = ids ?? listFixtures(dir)
  const passed = []
  const failed = []
  const skipped = []
  for (const id of all) {
    let expected
    try {
      expected = loadExpected(id, dir)
    } catch (err) {
      failed.push({ id, error: `expected.json 读不出来：${err.message}`, detail: null })
      continue
    }
    const kind = expected.check?.kind
    const checker = CHECKERS[kind]
    if (!checker) {
      failed.push({ id, error: `未知 check.kind：${kind}`, detail: Object.keys(CHECKERS) })
      continue
    }
    try {
      const result = checker(id, expected.check)
      if (result.skipped) skipped.push({ id, reason: result.skipped })
      else if (result.pass) passed.push(id)
      else failed.push({ id, error: `断言未过：${expected.check.assert}`, detail: result.detail })
    } catch (err) {
      failed.push({ id, error: err.message, detail: null })
    }
  }
  return { total: all.length, passed, failed, skipped }
}
