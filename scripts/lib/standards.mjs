// lib/standards.mjs —— 上游常设规则的机器检出层。
//
// 为什么需要它：本技能原先只有「随版本变的破坏性变更」这一条检测线，
// 而 docs/defensive-patterns/ 里那层「任何时候都成立」的硬要求只能靠人工核对。
// 2026-11-05 的复盘把缺口说清了——一份插件可以通过全部升级指南扫描，仍然违反
// 常设要求，因为它违反的从来不是「变更」，是「一直如此」。
//
// 设计取舍（奥卡姆）：一页规则对应一个面，一个面只做机械可判的那部分。
// 只有「换个人照完整原文读一遍，也必然得出同一结论」的规则才进来；
// 需要意图判断的（dispose 是否真等停稳、回调异常是否被隔离、slot 注册物是否稳定）
// 一律不进，留在 review 车道人工核对——把裁量题伪装成判定题比不判更坏。
//
// 每条规则都带 upstream 出处（文件 + 小节标题），结论可回溯到上游原文位置。

import path from 'node:path'
import { prepareLexicalView } from './scanner.mjs'

// 代码区判定用的掩码值，与 scanner 内部一致：0/1/2 之外一律按代码处理
const CODE = 0

/** 可机械判定的常设规则表。 */
export const STANDARDS_RULES = [
  {
    id: 'top-level-await',
    title: '模块顶层使用 await',
    upstream: 'docs/defensive-patterns/package-surface.zh.md#包模块不在模块顶层 await',
    severity: 'MEDIUM',
    priority: 'P1',
    rules: '包模块的异步工作在它调用的函数里启动，模块顶层不使用 `await`、`for await` 或 `await using`：模块顶层的等待会让每个导入方的求值跟着等待，把 rejection 变成模块求值失败，也无法降级成同步 CommonJS 包装。',
    note: '机械判据：缩进为 0 的 `await` 语句。嵌套在函数体、回调、箭头函数里的都不算。',
  },
  {
    id: 'loader-entry-shape',
    title: 'Loader 入口导出面不合规（多出第五个值导出或两种形态混用）',
    upstream: 'docs/defensive-patterns/package-surface.zh.md#插件包导出-loader-所需的东西',
    severity: 'HIGH',
    priority: 'P0',
    rules: '函数插件具名导出 `name`、`inject`、`Config`、`apply`，不加第五个值导出；服务插件默认导出服务类，两种形态不得混用——在四件套旁加默认导出会让 Loader 丢弃整个命名空间。',
    note: '机械判据：入口文件的值导出集合。`export type` 与 `export interface` 是编译期物，不参与判定。',
  },
  {
    id: 'shared-state-no-owner',
    title: '共享状态没有所有者（全局旁路或模块级可变量被重赋值）',
    upstream: 'docs/defensive-patterns/general.zh.md#共享状态只有一个所有者',
    severity: 'HIGH',
    priority: 'P1',
    rules: '共享状态挂在服务或实例上，因此它的所有者是一个有生命周期的具名对象。模块级缓存、单例、全局 `WeakMap`，以及 `Symbol.for` / `globalThis` / `window.__X__` 旁路都会把这个所有者藏起来，并活得比任何一次清理都久。判定条件：说出拥有该值的服务或实例；说不出所有者时，先定所有者再实现。',
    note: '机械判据只有两种（第三轮收窄）：① `globalThis.__X__` / `window.__X__` 赋值；② 模块顶层的 `let`/`var` **被导出**且在函数体里被重新赋值。第二种限定「被导出」，是因为未导出的模块级 `let` 只是本模块的控制流状态，跨实例共享不到——2026-11-05 实测：不限定时本工具自扫命中全是那类状态，逐条核对零可信违规。',
  },
  {
    id: 'cross-package-relative-import',
    title: 'import 跨包伸进别的包的 src（绝对路径或相对路径）',
    upstream: 'docs/defensive-patterns/package-surface.zh.md#包只有两类且两类都是动态插件包',
    severity: 'MEDIUM',
    priority: 'P1',
    rules: '同包测试用相对 `../src/...` 路径触达内部；伸进**别的包**的 src 会绕过 `exports` 映射与包边界检查（测试 fixture 用相对路径引用其他包同样不合格）。绝对路径 import 则让插件绑死本机布局，换台机器就装不上。',
    note: '机械判据：import 说明符以 `/` 开头，或以 `../` 开头且解析后落在插件根之外。',
  },
  {
    id: 'lifecycle-unpaired-resource',
    title: '外部生命周期资源未闭环注销（未在 dispose 中注销监听或清理定时器）',
    upstream: 'docs/defensive-patterns/general.zh.md#资源与生命周期',
    severity: 'HIGH',
    priority: 'P1',
    rules: '申请的未受管外部资源（如原生 `setInterval` / `setTimeout`、`process.on`、`emitter.on`）必须在插件 `dispose` 回调中释放。Cordis 插件在热重载或停用时会销毁 Fork，若未注销将导致孤儿监听器常驻、多次重复触发甚至内存泄漏。',
    note: '机械判据：代码中调用了不受管的 `process.on(...)` / `process.addListener(...)` 或原生 `setInterval(...)`，但在整个模块中未找到配对的 `process.off`/`removeListener` 或 `clearInterval`/`ctx.on(\'dispose\')` 注销逻辑。使用 `ctx.setInterval` 或声明了 dispose 清理逻辑时不计入。',
  },
]

/** 函数插件的四件套导出名。 */
export const FUNC_PLUGIN_EXPORTS = ['name', 'inject', 'Config', 'apply']

/** 需要剥离的注释与字符串都由词法视图负责，这里只从干净代码区里取行。 */
function codeLines(code) {
  return code.split('\n')
}

/**
 * 该下标是否落在代码区（注释与字符串里不算）。
 * @param {Uint8Array} mask 字符掩码
 * @param {number} index 字符下标
 * @returns {boolean} 是否代码区
 */
function inCode(mask, index) {
  return mask[index] === CODE
}

/**
 * 收集入口文件的值导出名。
 *
 * 形式覆盖 `export const/let/var/function/class/async function` 与 `export { a, b as c }`。
 * 类型导出（`export type` / `export interface`）与 `export default` 单独归类：
 * 前者不参与判定，后者的合规性取决于是否与具名导出混用。
 * @param {string} code 代码区文本
 * @param {Uint8Array} mask 字符掩码
 * @param {(i: number) => number} lineOf 行号查询
 * @returns {{ values: Array<{name: string, line: number}>, hasDefault: boolean, typeOnly: string[] }} 导出面
 */
export function collectEntryExports(code, mask, lineOf) {
  const values = []
  const typeOnly = []
  let hasDefault = false

  // export default
  const defaultRe = /^[ \t]*export\s+default\b/gm
  let m
  while ((m = defaultRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) hasDefault = true
  }

  // export type / export interface：编译期物，不参与判定
  const typeRe = /\bexport\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/g
  while ((m = typeRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) typeOnly.push(m[1])
  }

  // export <decl>
  const declRe = /\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g
  while ((m = declRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) values.push({ name: m[1], line: lineOf(m.index) })
  }

  // export { a, b as c } 与 export { type a, type b as c }
  const listRe = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g
  while ((m = listRe.exec(code)) !== null) {
    if (!inCode(mask, m.index)) continue
    const isExportType = /\bexport\s+type\s*\{/.test(m[0])
    for (const raw of m[1].split(',')) {
      const part = raw.trim()
      if (!part) continue
      if (isExportType || part.startsWith('type ')) {
        const typeName = part.replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim()
        if (typeName) typeOnly.push(typeName)
        continue
      }
      const name = (part.split(/\s+as\s+/).pop() || part).trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) values.push({ name, line: lineOf(m.index) })
    }
  }

  return { values, hasDefault, typeOnly }
}

/**
 * 对一个插件目录跑常设规则检测。
 * @param {string} pluginDir 插件根
 * @param {{ files?: Array<{ file: string, source: string }> }} [options] 显式给文件（自检用；默认由调用方传 files）
 * @returns {{ findings: Array<object>, scannedFiles: number, entry: string|null, exportNames: string[] }} 检测结果
 */
export function scanStandards(pluginDir, { files = null, entryFile = null } = {}) {
  const findings = []
  const scanned = files || []
  const push = (rule, file, line, extra = {}) => {
    const meta = STANDARDS_RULES.find((r) => r.id === rule)
    findings.push({
      rule,
      dimension: 'standards',
      severity: meta.severity,
      priority: meta.priority,
      file,
      line,
      title: meta.title,
      detail: meta.rules,
      upstream: meta.upstream,
      ...extra,
    })
  }

  // 入口文件先定：只有它是 Loader 读的那个面，导出面规则只对它生效
  let entryRel = entryFile
  if (!entryRel) {
    for (const cand of ['lib/index.js', 'lib/index.mjs', 'src/index.ts', 'src/index.tsx', 'index.js']) {
      if (scanned.some((f) => f.file === cand)) { entryRel = cand; break }
    }
    if (!entryRel) {
      const hit = scanned.find((f) => /(?:^|\/)(?:lib|src|dist)?\/?index\.(?:js|mjs|cjs|ts|tsx)$/.test(f.file))
      if (hit) entryRel = hit.file
    }
  }

  let exportNames = []
  for (const { file, source } of scanned) {
    const { code, mask, lineOf } = prepareLexicalView(source)
    const lines = codeLines(code)

    // 规则 1：模块顶层 await（缩进为 0）
    for (let i = 0; i < lines.length; i += 1) {
      if (/^(?:await\s|for\s+await\s|await\s+using\s)/.test(lines[i])) {
        push('top-level-await', file, i + 1)
      }
    }

    // 规则 3：共享状态没有所有者。只认两种机械可判形态——
    // 泛化的「模块级容器」判不出来：常量查表容器（`const X = new Set([...])` 只读）
    // 与真正的共享可变容器在文本上长得一样，先能后对的代价是把常量表全报成违规。
    // 2026-11-05 实测：泛化版在 dsh-llm-fallbacks 上 10 命中、dsh-image-gen 上 35 命中，
    // 逐条核对全是常量表与编译后产物，故收窄。
    for (const hit of findSharedStateWithoutOwner(lines, mask)) {
      push('shared-state-no-owner', file, hit.line, { evidence: hit.evidence, detail: `${STANDARDS_RULES[2].rules} ${hit.why}` })
    }

    // 规则 4：跨包相对 import / 绝对路径 import
    for (const imp of collectImportSources(code, mask, lineOf)) {
      if (imp.source.startsWith('/')) {
        push('cross-package-relative-import', file, imp.line, { evidence: imp.source })
        continue
      }
      if (!imp.source.startsWith('..')) continue
      const resolved = path.resolve(pluginDir, path.dirname(file), imp.source)
      const rel = path.relative(pluginDir, resolved)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        push('cross-package-relative-import', file, imp.line, { evidence: imp.source })
      }
    }

    // 规则 5：外部生命周期资源未闭环注销
    for (const hit of findUnpairedLifecycleResources(code, mask, lineOf)) {
      push('lifecycle-unpaired-resource', file, hit.line, {
        evidence: hit.evidence,
        detail: `${STANDARDS_RULES.find((r) => r.id === 'lifecycle-unpaired-resource').rules} ${hit.why}`,
      })
    }

    // 规则 2：Loader 入口导出面（只判入口）
    if (entryRel && file === entryRel) {
      const collected = collectEntryExports(code, mask, lineOf)
      exportNames = collected.values.map((v) => v.name)
      const hasFunc = FUNC_PLUGIN_EXPORTS.every((n) => exportNames.includes(n))
      if (hasFunc) {
        const extra = collected.values.filter((v) => !FUNC_PLUGIN_EXPORTS.includes(v.name))
        if (collected.hasDefault) {
          push('loader-entry-shape', file, 1, {
            evidence: 'export default',
            severity: 'HIGH',
            priority: 'P0',
            detail: `${STANDARDS_RULES.find((r) => r.id === 'loader-entry-shape').rules} 本次在入口里同时看到具名导出与 \`export default\`，Loader 会按服务插件处理并丢掉具名那半边。`,
          })
        }
        for (const v of extra) {
          // 上游 package-surface.zh.md 明确允许导出供外部 extends/throw 的 Service 类、Error 类及 Adapter 类
          if (/(?:Service|Error|Exception|Adapter)$/.test(v.name)) continue
          push('loader-entry-shape', file, v.line, {
            evidence: `export ${v.name}`,
            severity: 'LOW',
            priority: 'P2',
            detail: `${STANDARDS_RULES.find((r) => r.id === 'loader-entry-shape').rules} 本次多出的值导出是 \`${v.name}\`。若它只是同包测试或辅助逻辑，建议通过子路径导出或内部引用，保持最小包面。`,
          })
        }
      }
    }
  }

  return { findings, scannedFiles: scanned.length, entry: entryRel, exportNames }
}

/**
 * 找「共享状态没有所有者」的两种机械可判形态。
 *
 * 形态甲：`globalThis.__X__ = ...` / `window.__X__ = ...`（全局旁路，原文反面样例就是这个）。
 * 形态乙：模块顶层的 `let`/`var` 具名声明，在函数体里被重新赋值——跨实例共享的可变状态，
 *        而原文明确要求它挂在服务或实例的字段上。
 * 模块顶层 `const` 一律不看（常量表与只读查表容器是合法写法）。
 * @param {string[]} lines 代码区按行切分
 * @param {Uint8Array} mask 字符掩码
 * @returns {Array<{ line: number, evidence: string, why: string }>} 命中
 */
function findSharedStateWithoutOwner(lines, mask) {
  const hits = []
  // 单个或双下划线前缀都算（原文反面样例是 `globalThis.__dshCache`，只有一个前导下划线）
  const sideChannel = /\b(?:globalThis|window)\s*\.\s*_[A-Za-z_$][\w$]*\s*=/
  const topLevelMutable = /^(?:export\s+)?(?:let|var)\s+([A-Za-z_$][\w$]*)\b/

  // 只收「被导出」的模块级可变量：未导出的那种是本模块控制流状态，跨实例共享不到
  const exportedNames = new Set()
  const code = lines.join('\n')
  let em
  const exportDeclRe = /\bexport\s+(?:let|var)\s+([A-Za-z_$][\w$]*)/g
  while ((em = exportDeclRe.exec(code)) !== null) exportedNames.add(em[1])
  const exportListRe = /\bexport\s*\{([^}]*)\}/g
  while ((em = exportListRe.exec(code)) !== null) {
    for (const raw of em[1].split(',')) {
      const name = (raw.trim().split(/\s+as\s+/).pop() || '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) exportedNames.add(name)
    }
  }

  const mutableNames = new Map()
  for (let i = 0; i < lines.length; i += 1) {
    const m = topLevelMutable.exec(lines[i])
    if (m && exportedNames.has(m[1])) mutableNames.set(m[1], i + 1)
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (sideChannel.test(line)) {
      hits.push({ line: i + 1, evidence: line.trim(), why: '这是原文列出的全局旁路写法，所有者被藏进全局命名空间。' })
    }
    // 缩进不为 0 ⇒ 这一行在函数体或块里，对模块级可变量的赋值就是跨实例共享
    if (/^[ \t]/.test(line)) {
      for (const [name, declLine] of mutableNames) {
        if (new RegExp(`(?:^|[^.\\w$])${name}\\s*(?:=(?!=)|\\+=|-=|\\+\\+|--)`).test(line)) {
          hits.push({
            line: i + 1,
            evidence: line.trim(),
            why: `\`${name}\` 在第 ${declLine} 行声明为模块级可变，这里在函数体里写它——多个实例会共享同一份状态。改挂在服务或实例的字段上。`,
          })
        }
      }
    }
  }
  return hits
}

/** 取某一行的首个字符下标（用于把「整行命中」映射回掩码位置）。 */
function maskIndexOfLine(code, lineIndex) {
  let idx = 0
  for (let i = 0; i < lineIndex; i += 1) {
    const nl = code.indexOf('\n', idx)
    if (nl === -1) return Math.max(0, code.length - 1)
    idx = nl + 1
  }
  return idx
}

/** 收 import 说明符（含 `import type`，类型引用同样是边界信号）与动态 import。 */
function collectImportSources(code, mask, lineOf) {
  const out = []
  const re = /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g
  let m
  while ((m = re.exec(code)) !== null) {
    if (!inCode(mask, m.index)) continue
    const src = m[1] || m[2]
    if (src) out.push({ source: src, line: lineOf(m.index) })
  }
  return out
}

/**
 * 常设规则保持度打分（100 起扣，只扣不判）。
 * @param {Array<object>} findings scanStandards 的命中
 * @returns {number} 0-100
 */
export function standardsScore(findings) {
  let score = 100
  for (const f of findings) {
    if (f.severity === 'HIGH') score -= 15
    else if (f.severity === 'MEDIUM') score -= 8
    else score -= 4
  }
  return Math.max(0, score)
}

/**
 * 找外部生命周期资源未成对注销的违规。
 *
 * 机械判据：
 * 1. 原生 `process.on(...)` / `process.addListener(...)`：代码区调用，但模块内无 `process.off` / `removeListener` 且无 `dispose`。
 * 2. 原生 `setInterval(...)`：代码区调用（非 `ctx.setInterval` 等方法），但模块内无 `clearInterval` 且无 `dispose`。
 * 字符串与注释里的同名调用由词法掩码 mask 自动过滤。
 * @param {string} code 文本
 * @param {Uint8Array} mask 掩码
 * @param {(idx: number) => number} lineOf 行号定位
 * @returns {Array<{ line: number, evidence: string, why: string }>}
 */
export function findUnpairedLifecycleResources(code, mask, lineOf) {
  const hits = []

  let hasDispose = false
  let hasProcessOff = false
  let hasClearInterval = false

  const disposeRe = /\bdispose\b/g
  let m
  while ((m = disposeRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) { hasDispose = true; break }
  }

  const offRe = /\bprocess\s*\.\s*(?:off|removeListener)\b/g
  while ((m = offRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) { hasProcessOff = true; break }
  }

  const clearRe = /\bclearInterval\b/g
  while ((m = clearRe.exec(code)) !== null) {
    if (inCode(mask, m.index)) { hasClearInterval = true; break }
  }

  // 1. process.on / process.addListener
  if (!hasDispose && !hasProcessOff) {
    const procOnRe = /\bprocess\s*\.\s*(?:on|addListener)\s*\(/g
    while ((m = procOnRe.exec(code)) !== null) {
      if (inCode(mask, m.index)) {
        const line = lineOf(m.index)
        const lineText = code.split('\n')[line - 1]?.trim() || 'process.on(...)'
        hits.push({
          line,
          evidence: lineText,
          why: '调用了全局 `process.on` / `process.addListener`，但未发现 `process.off`、`removeListener` 或 `dispose` 注销调用。热重载时会导致监听器重复常驻与内存泄漏。',
        })
      }
    }
  }

  // 2. 原生 setInterval(...)，排除 obj.setInterval (如 ctx.setInterval)
  if (!hasDispose && !hasClearInterval) {
    const timerRe = /(?:^|[^.\w$])setInterval\s*\(/g
    while ((m = timerRe.exec(code)) !== null) {
      const matchStr = m[0]
      const offset = matchStr.indexOf('setInterval')
      const actualIdx = m.index + offset
      if (inCode(mask, actualIdx)) {
        const line = lineOf(actualIdx)
        const lineText = code.split('\n')[line - 1]?.trim() || 'setInterval(...)'
        hits.push({
          line,
          evidence: lineText,
          why: '调用了原生不受管的 `setInterval`，但未发现 `clearInterval` 或 `dispose` 清理逻辑。改用 `ctx.setInterval` 或在 `ctx.on(\'dispose\')` 中清理。',
        })
      }
    }
  }

  return hits
}
