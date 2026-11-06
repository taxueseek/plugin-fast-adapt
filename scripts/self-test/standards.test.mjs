// standards.test.mjs —— 上游常设规则检出与包面批量修补的自检用例。
//
// 这组用例的重点不是「能抓到」，而是「不误报」：常设规则检测器最容易犯的错
// 是把常量表、注释、字符串里的同名词报成违规，那会让使用者直接不信整个工具。
// 因此每条规则都配一个反面用例（不该命中）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, tmpPluginDir } from './harness.mjs'
import { STANDARDS_RULES, scanStandards, standardsScore, collectEntryExports, findUnpairedLifecycleResources } from '../lib/standards.mjs'
import { planPeerFix, PEER_ONLY_PACKAGES } from '../lib/peer-fix.mjs'
import { prepareLexicalView } from '../lib/scanner.mjs'

function scan(files, pluginDir = '/tmp/fake-plugin') {
  return scanStandards(pluginDir, { files })
}

test('常设规则表：每条都带上游出处与分级', () => {
  assert.ok(STANDARDS_RULES.length >= 4, '规则表至少四条')
  for (const r of STANDARDS_RULES) {
    assert.ok(r.id && r.title && r.rules, `${r.id} 缺字段`)
    assert.ok(r.upstream.startsWith('docs/defensive-patterns/'), `${r.id} 出处必须指向上游常设规则原文`)
    assert.ok(['P0', 'P1', 'P2'].includes(r.priority), `${r.id} 分级非法`)
    assert.ok(r.note, `${r.id} 要写明机械判据`)
  }
})

test('规则 top-level-await：只抓缩进为 0 的 await，函数里的不抓', () => {
  const files = [
    {
      file: 'lib/index.js',
      source: [
        "// await shouldNotCount()",
        "const s = 'await alsoNotCount()'",
        'export const name = "x"',
        'export const inject = []',
        'export const Config = {}',
        'export function apply() {',
        '  return Promise.resolve()',
        '}',
        'async function boot() {',
        '  await loadThings()',
        '}',
      ].join('\n'),
    },
  ]
  const r = scan(files)
  assert.strictEqual(r.findings.filter((f) => f.rule === 'top-level-await').length, 0, '函数里的 await 不算顶层')

  const bad = scan([{ file: 'lib/index.js', source: 'export function apply() {}\nawait ready()\n' }])
  assert.strictEqual(bad.findings.filter((f) => f.rule === 'top-level-await').length, 1)
})

test('规则 loader-entry-shape：多出第五个值导出与两种形态混用都要报', () => {
  const base = ['export const name = "x"', 'export const inject = []', 'export const Config = {}', 'export function apply() {}']
  assert.strictEqual(scan([{ file: 'lib/index.js', source: base.join('\n') }]).findings.filter((f) => f.rule === 'loader-entry-shape').length, 0, '四件套齐全应干净')

  const withExtra = scan([{ file: 'lib/index.js', source: [...base, 'export function helperForTests() {}'].join('\n') }])
  const extraHits = withExtra.findings.filter((f) => f.rule === 'loader-entry-shape')
  assert.strictEqual(extraHits.length, 1)
  assert.ok(extraHits[0].evidence.includes('helperForTests'))

  const mixed = scan([{ file: 'lib/index.js', source: [...base, 'export default class WebApp {}'].join('\n') }])
  assert.strictEqual(mixed.findings.filter((f) => f.rule === 'loader-entry-shape').length, 1, '四件套旁加默认导出会让 Loader 丢命名空间')

  // 服务插件形态（只有默认导出）是合法的，不能报
  assert.strictEqual(scan([{ file: 'lib/index.js', source: 'export default class Svc {}\n' }]).findings.filter((f) => f.rule === 'loader-entry-shape').length, 0)

  // export type / interface 是编译期物，不算第五个导出
  const typed = scan([{ file: 'lib/index.js', source: [...base, 'export interface Extra {}', 'export type Alias = string'].join('\n') }])
  assert.strictEqual(typed.findings.filter((f) => f.rule === 'loader-entry-shape').length, 0)

  // export Service / Error / Adapter 类以及 export { type Foo } 豁免不报
  const withService = scan([{ file: 'lib/index.js', source: [...base, 'export class ApiService {}', 'export class RequestError extends Error {}'].join('\n') }])
  assert.strictEqual(withService.findings.filter((f) => f.rule === 'loader-entry-shape').length, 0, 'Service 和 Error 类按上游规范豁免')

  const withInlineType = scan([{ file: 'lib/index.js', source: [...base, 'export { type FooResult, type BarOptions }'].join('\n') }])
  assert.strictEqual(withInlineType.findings.filter((f) => f.rule === 'loader-entry-shape').length, 0, 'export { type Foo } 编译期类型豁免')
})

test('规则 shared-state-no-owner：只抓全局旁路与被导出的模块级可变量', () => {
  const files = [
    {
      file: 'lib/index.js',
      source: [
        'const lookup = new Set(["a"])',
        'const r = Symbol.for("react.element")',
        'let privateFlag = false',
        'export function apply() {',
        '  privateFlag = true',
        '}',
      ].join('\n'),
    },
  ]
  assert.strictEqual(scan(files).findings.filter((f) => f.rule === 'shared-state-no-owner').length, 0, '常量表 / 未导出的模块级 let 都不算')

  const sideChannel = scan([{ file: 'lib/index.js', source: 'globalThis.__dshCache = new Map()\n' }])
  assert.strictEqual(sideChannel.findings.filter((f) => f.rule === 'shared-state-no-owner').length, 1)

  const exportedShared = scan([
    {
      file: 'lib/index.js',
      source: ['export let activeTabId', 'export function apply() {', '  activeTabId = "x"', '}'].join('\n'),
    },
  ])
  assert.strictEqual(exportedShared.findings.filter((f) => f.rule === 'shared-state-no-owner').length, 1, '被导出的模块级可变量是共享状态')

  // 注释里的全局旁路不算
  assert.strictEqual(scan([{ file: 'lib/index.js', source: '// globalThis.__x__ = 1\n' }]).findings.filter((f) => f.rule === 'shared-state-no-owner').length, 0)
})

test('规则 cross-package-relative-import：只报跑出包根的相对路径与绝对路径', () => {
  const inside = scan([{ file: 'lib/index.js', source: "import { a } from '../src/internal/a.js'\n" }])
  assert.strictEqual(inside.findings.filter((f) => f.rule === 'cross-package-relative-import').length, 0, '包内相对路径合法')

  const outside = scan([{ file: 'lib/index.js', source: "import { a } from '../../other-pkg/src/a.js'\n" }])
  assert.strictEqual(outside.findings.filter((f) => f.rule === 'cross-package-relative-import').length, 1)

  const absolute = scan([{ file: 'lib/index.js', source: "import { a } from '/Users/x/packages/util/src/a.js'\n" }])
  assert.strictEqual(absolute.findings.filter((f) => f.rule === 'cross-package-relative-import').length, 1)

  const bare = scan([{ file: 'lib/index.js', source: "import { a } from '@deepseek-ai/dsh-util'\n" }])
  assert.strictEqual(bare.findings.filter((f) => f.rule === 'cross-package-relative-import').length, 0, '包名 import 合法')
})

test('standardsScore：按分级扣分且不为负', () => {
  assert.strictEqual(standardsScore([]), 100)
  assert.ok(standardsScore([{ severity: 'HIGH' }]) < 100)
  assert.strictEqual(standardsScore(Array.from({ length: 40 }, () => ({ severity: 'HIGH' }))), 0)
})

test('collectEntryExports：识别 export { a as b } 与 export default', () => {
  const src = 'const a = 1\nexport { a as renamed }\nexport default function f() {}\n'
  const { code, mask, lineOf } = prepareLexicalView(src)
  const e = collectEntryExports(code, mask, lineOf)
  assert.deepStrictEqual(e.values.map((v) => v.name), ['renamed'])
  assert.strictEqual(e.hasDefault, true)
})

test('planPeerFix：宿主核心包从 dependencies 搬进 peer/dev，非核心包不动', () => {
  const pkg = {
    dependencies: { '@deepseek-ai/schemastery': '^3.18.1', 'left-pad': '^1.0.0' },
    peerDependencies: { '@deepseek-ai/cordis': '^4.0.2' },
  }
  const plan = planPeerFix(pkg)
  assert.strictEqual(plan.moves.length, 1, `只搬 ${PEER_ONLY_PACKAGES.join('/')}`)
  const next = JSON.parse(plan.files['package.json'])
  assert.strictEqual(next.dependencies['left-pad'], '^1.0.0', '普通依赖不动')
  assert.strictEqual(next.dependencies['@deepseek-ai/schemastery'], undefined)
  assert.strictEqual(next.peerDependencies['@deepseek-ai/schemastery'], '^3.18.1', '范围照搬，不改写')
  assert.strictEqual(next.devDependencies['@deepseek-ai/schemastery'], '^3.18.1', 'devDependencies 保留开发期类型支持')
  assert.strictEqual(next.peerDependencies['@deepseek-ai/cordis'], '^4.0.2', '已声明的 peer 不覆盖')

  // 搬空 dependencies 后不该留空对象
  const emptied = JSON.parse(planPeerFix({ dependencies: { cordis: '^4.0.0' } }).files['package.json'])
  assert.strictEqual(emptied.dependencies, undefined)
  assert.strictEqual(planPeerFix({ dependencies: { 'left-pad': '^1.0.0' } }).moves.length, 0)
})

test('planPeerFix：原对象不被改动（纯函数）', () => {
  const pkg = { dependencies: { schemastery: '^3.18.0' } }
  const snapshot = JSON.stringify(pkg)
  planPeerFix(pkg)
  assert.strictEqual(JSON.stringify(pkg), snapshot, '计划不能改调用方传进来的对象')
})

test('standards-scan：包面只有构建产物时回退到源码根，不因零文件冒充干净', async () => {
  const dir = tmpPluginDir('standards-graph')
  try {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '1.0.0', main: './lib/index.js' }))
    fs.writeFileSync(path.join(dir, 'src', 'index.ts'), 'export function apply() {}\nawait nope()\n')
    const { readLoadedModuleGraph } = await import('../standards-scan.mjs')
    const graph = readLoadedModuleGraph(dir, JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')))
    assert.ok(graph.files.length >= 1, '有源码时走源码面')
    assert.ok(graph.files.some((f) => f.file === 'src/index.ts'))
    const hits = scanStandards(dir, { files: graph.files }).findings
    assert.strictEqual(hits.filter((f) => f.rule === 'top-level-await').length, 1)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('规则 lifecycle-unpaired-resource：不受管监听与定时器未清理要报警，受管与闭环不误报', () => {
  // 正例 1：使用受管的 ctx.setInterval
  const safeCtxTimer = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.setInterval(() => {}, 1000)',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(safeCtxTimer.findings.filter((f) => f.rule === 'lifecycle-unpaired-resource').length, 0, 'ctx.setInterval 是受管资源，不报')

  // 正例 2：原生定时器在 dispose 中清理
  const safeNativeTimer = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  const timer = setInterval(() => {}, 1000)',
        '  ctx.on("dispose", () => {',
        '    clearInterval(timer)',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(safeNativeTimer.findings.filter((f) => f.rule === 'lifecycle-unpaired-resource').length, 0, '在 dispose 中清理的不报')

  // 正例 3：注释与字符串里的同名调用
  const decoy = scan([
    {
      file: 'lib/index.js',
      source: [
        '// process.on("exit", () => {})',
        'const str = "setInterval(() => {}, 1000)"',
        'export function apply() {}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(decoy.findings.filter((f) => f.rule === 'lifecycle-unpaired-resource').length, 0, '注释和字符串不报')

  // 违规 1：使用原生 setInterval，全模块无 clearInterval 且无 dispose
  const leakedTimer = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  setInterval(() => { console.log("tick") }, 5000)',
        '}',
      ].join('\n'),
    },
  ])
  const timerHits = leakedTimer.findings.filter((f) => f.rule === 'lifecycle-unpaired-resource')
  assert.strictEqual(timerHits.length, 1, '原生 setInterval 未注销应抓到')
  assert.ok(timerHits[0].evidence.includes('setInterval'))

  // 违规 2：使用 process.on，全模块无 process.off 且无 dispose
  const leakedListener = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  process.on("SIGINT", () => { console.log("cleanup") })',
        '}',
      ].join('\n'),
    },
  ])
  const listenerHits = leakedListener.findings.filter((f) => f.rule === 'lifecycle-unpaired-resource')
  assert.strictEqual(listenerHits.length, 1, 'process.on 未注销应抓到')
  assert.ok(listenerHits[0].evidence.includes('process.on'))
})

test('规则 vendor-rescope-unscoped：未加 @deepseek-ai/ 前缀的裸 vendor 引用要报警，作用域后不误报', () => {
  // 正例：使用加了 scope 的包名
  const safe = scan([
    {
      file: 'lib/index.js',
      source: [
        'import { Context } from "@deepseek-ai/cordis"',
        'import Schema from "@deepseek-ai/schemastery"',
        'declare module "@deepseek-ai/cordis" {}',
        'export function apply(ctx) {}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(safe.findings.filter((f) => f.rule === 'vendor-rescope-unscoped').length, 0, '已加作用域的包名不报')

  // 反例：使用裸 cordis / schemastery
  const leaked = scan([
    {
      file: 'lib/index.js',
      source: [
        'import { Context } from "cordis"',
        'import { Schema } from "schemastery"',
        'declare module "cordis" {}',
        'export function apply(ctx) {}',
      ].join('\n'),
    },
  ])
  const hits = leaked.findings.filter((f) => f.rule === 'vendor-rescope-unscoped')
  assert.strictEqual(hits.length, 3, '3 处裸包引用都要抓到')
})

test('规则 waterfall-missing-next：waterfall 事件漏调 next() 要报警，透传或非 waterfall 不误报', () => {
  // 正例 1：调用了 next()
  const safeWaterfall = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("tools/pre-execute", async (tool, args, next) => {',
        '    console.log("before")',
        '    return await next()',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(safeWaterfall.findings.filter((f) => f.rule === 'waterfall-missing-next').length, 0, '调了 next() 不报')

  // 正例 2：非 waterfall 事件（如 agent/created）不需要 next
  const safeEmit = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("agent/created", (agent) => {',
        '    console.log("created", agent.id)',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(safeEmit.findings.filter((f) => f.rule === 'waterfall-missing-next').length, 0, '非 waterfall 事件不报')

  // 反例：监听了 waterfall 事件但函数体没调 next()
  const brokenWaterfall = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("tools/pre-execute", (tool, args) => {',
        '    console.log("intercepted")',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  const hits = brokenWaterfall.findings.filter((f) => f.rule === 'waterfall-missing-next')
  assert.strictEqual(hits.length, 1, 'waterfall 漏调 next 应报警')
  assert.ok(hits[0].evidence.includes('tools/pre-execute'))
})

test('规则 waterfall-missing-next：作用域按函数体边界取，不按字符窗口（2026-11-06 假阳性回归）', () => {
  // 反例（旧实现误报）：next() 写在监听器函数体第 3300 字符处，仍属该监听器
  const longBody = Array.from({ length: 80 }, (_, i) => `    const pad${i} = '${'x'.repeat(38)}'`).join('\n')
  const farNext = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("llm/stream", function (options, next) {',
        longBody,
        '    return next()',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(
    farNext.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    0,
    'next() 写在监听器函数体深处也必须算透传——旧实现的 800 字符窗口会把它报成断链',
  )

  // 正例：next() 出现在函数体之外（监听器已闭合）不算透传，仍要报
  const nextOutside = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("tools/execute", async (tool, next) => {',
        '    console.log("intercepted")',
        '  })',
        '  return next()',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(
    nextOutside.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    1,
    'next() 在监听器函数体外，不能拿来给这个监听器开脱',
  )

  // 正例：花括号不配平（无法定界）时不报，宁少不滥
  const unbalanced = scan([
    {
      file: 'lib/index.js',
      source: ['export function apply(ctx) {', '  ctx.on("tools/execute", (tool, next) => {', '    return 1'].join('\n'),
    },
  ])
  assert.strictEqual(
    unbalanced.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    0,
    '函数体无法定界时放弃判定，不用窗口长度冒充作用域',
  )

  // 正例：第二个实参是具名引用，不是函数字面量，不判
  const namedHandler = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        '  ctx.on("tools/execute", makeHandler())',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(
    namedHandler.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    0,
    '第二个实参不是函数字面量时不判',
  )
})

test('规则 waterfall-missing-next：只认裸 next(，`.next(` 与 `?.next(` 是别人的同名方法', () => {
  // 反例（真实实录形态）：`?? next()` 是合法透传；集合迭代的 `it.next()` 不是透传
  const ternaryFallback = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        "  ctx.on('tools/pre-execute', (exec, next) => refusal({ toolName: String(exec?.name ?? '') }) ?? next())",
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(
    ternaryFallback.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    0,
    '`?? next()` 是透传，不能报（dsh-ops 实测命中）',
  )

  const memberNext = scan([
    {
      file: 'lib/index.js',
      source: [
        'export function apply(ctx) {',
        "  ctx.on('tools/execute', (tool, next) => {",
        '    const it = cache.keys()',
        '    while (!it.next().done) { /* … */ }',
        '  })',
        '}',
      ].join('\n'),
    },
  ])
  assert.strictEqual(
    memberNext.findings.filter((f) => f.rule === 'waterfall-missing-next').length,
    1,
    '`it.next()` 是集合迭代，不能拿来给这个监听器开脱',
  )
})

test('SKILL.md 规则枚举与 lib/standards.mjs 规则表双向一致（防文档计数漂移）', () => {
  const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const skillMd = fs.readFileSync(path.join(toolRoot, 'SKILL.md'), 'utf8')
  const m = skillMd.match(/机械可判的 (\d+) 条 `standards-scan`（规则 id：([^）]+)）/)
  assert.ok(m, 'SKILL.md 来源表必须带「机械可判的 N 条（规则 id：…）」清单——这是规则计数的唯一权威写法')
  assert.strictEqual(Number(m[1]), STANDARDS_RULES.length, `SKILL.md 写的条数 ${m[1]} 与规则表实际 ${STANDARDS_RULES.length} 条不一致`)
  const docIds = m[2].split('、').map((s) => s.trim()).filter(Boolean).sort()
  const tableIds = STANDARDS_RULES.map((r) => r.id).sort()
  assert.deepStrictEqual(docIds, tableIds, 'SKILL.md 枚举的规则 id 集合与规则表不一致——加删规则必须同步这一行（dbea17d 一笔加三条只写「第 5 条」的教训）')
})
