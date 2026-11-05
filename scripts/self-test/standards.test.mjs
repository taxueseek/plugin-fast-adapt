// standards.test.mjs —— 上游常设规则检出与包面批量修补的自检用例。
//
// 这组用例的重点不是「能抓到」，而是「不误报」：常设规则检测器最容易犯的错
// 是把常量表、注释、字符串里的同名词报成违规，那会让使用者直接不信整个工具。
// 因此每条规则都配一个反面用例（不该命中）。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
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
