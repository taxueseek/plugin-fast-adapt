// codemod.test.mjs —— 确定性自动修补引擎（方案 A）自检用例。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import {
  CODEMOD_RULES,
  fixLoaderEntryShape,
  fixTopLevelAwait,
  planCodemods,
  applyCodemodPlan,
} from '../lib/codemod.mjs'
import { scanStandards } from '../lib/standards.mjs'

test('Codemod 规则表：规则齐全且带安全等级', () => {
  assert.ok(CODEMOD_RULES.length >= 3, '至少提供 3 条确定性修补规则')
  for (const r of CODEMOD_RULES) {
    assert.ok(r.id && r.title && r.description)
    assert.strictEqual(r.safety, 'SAFE', '自动化修补必须是 SAFE 级别')
  }
})

test('fixLoaderEntryShape：混用 export default 时安全消除默认导出', () => {
  const codeWithDefaultExpr = [
    'export const name = "my-test-plugin"',
    'export const inject = []',
    'export const Config = {}',
    'export function apply(ctx) {}',
    'export default apply',
  ].join('\n')

  const res1 = fixLoaderEntryShape(codeWithDefaultExpr)
  assert.strictEqual(res1.transforms.length, 1)
  assert.ok(!res1.source.includes('\nexport default apply'), '默认导出应被消除')
  assert.ok(res1.source.includes('export function apply(ctx) {}'), '四件套必须保留')

  const codeWithDefaultClass = [
    'export const name = "my-test-plugin"',
    'export const inject = []',
    'export const Config = {}',
    'export function apply(ctx) {}',
    'export default class ServiceRunner {}',
  ].join('\n')

  const res2 = fixLoaderEntryShape(codeWithDefaultClass)
  assert.strictEqual(res2.transforms.length, 1)
  assert.ok(!res2.source.includes('export default class'), 'export default class 应被改写')
  assert.ok(res2.source.includes('class ServiceRunner {}'), '类声明应原样保留')
})

test('fixLoaderEntryShape：多余的值导出被收回为模块内部私有', () => {
  const codeWithExtra = [
    'export const name = "my-test-plugin"',
    'export const inject = []',
    'export const Config = {}',
    'export function apply(ctx) {}',
    'export function helperForTests() {}',
    'export const myConstant = 42',
  ].join('\n')

  const res = fixLoaderEntryShape(codeWithExtra)
  assert.strictEqual(res.transforms.length, 2)
  assert.ok(!res.source.includes('export function helperForTests'), '多余函数导出应被收回')
  assert.ok(res.source.includes('function helperForTests'), '函数体必须原样保留')
  assert.ok(!res.source.includes('export const myConstant'), '多余变量导出应被收回')
  assert.ok(res.source.includes('const myConstant = 42'), '变量声明必须原样保留')
})

test('fixTopLevelAwait：顶层缩进为 0 的 await 被安全封装，函数体内部不误伤', () => {
  const code = [
    'async function foo() {',
    '  await doWork()',
    '}',
    'await globalInit()',
  ].join('\n')

  const res = fixTopLevelAwait(code)
  assert.strictEqual(res.transforms.length, 1)
  assert.ok(!res.source.includes('\nawait globalInit()'), '顶层 await 必须被封装')
  assert.ok(res.source.includes('  await doWork()'), '函数体内的 await 不能被改动')
})

test('planCodemods 与 applyCodemodPlan：端到端修补并安全备份', () => {
  const dir = tmpPluginDir('codemod-e2e')
  try {
    const pkg = {
      name: 'broken-plugin',
      version: '1.0.0',
      dependencies: {
        cordis: '^4.0.0',
        'left-pad': '^1.0.0',
      },
    }
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))

    const entryCode = [
      'export const name = "broken-plugin"',
      'export const inject = []',
      'export const Config = {}',
      'export function apply(ctx) {}',
      'export function extraExport() {}',
      'export default apply',
    ].join('\n')
    fs.writeFileSync(path.join(dir, 'lib', 'index.js'), entryCode)

    // 1. 修补前扫描：必然命中 standards 违规
    const beforeScan = scanStandards(dir, {
      files: [{ file: 'lib/index.js', source: entryCode }],
    })
    assert.ok(beforeScan.findings.some((f) => f.rule === 'loader-entry-shape'), '修补前应命中 loader-entry-shape')

    // 2. 生成计划
    const plan = planCodemods(dir, {
      files: [{ file: 'lib/index.js', source: entryCode }],
      pkg,
    })
    assert.strictEqual(plan.hasChanges, true)
    assert.strictEqual(plan.moves.length, 1, '应有 1 处 peerDependencies 迁移')
    assert.strictEqual(plan.transforms.length, 2, '应有 2 处代码修补（export default 与 extraExport）')

    // 3. 执行落盘并备份
    const applyRes = applyCodemodPlan(dir, plan)
    assert.strictEqual(applyRes.writtenFiles.length, 2)
    assert.ok(fs.existsSync(applyRes.backupDir))
    assert.ok(fs.existsSync(path.join(applyRes.backupDir, 'package.json')))
    assert.ok(fs.existsSync(path.join(applyRes.backupDir, 'lib', 'index.js')))

    // 4. 修补后重新扫描：应 100% 干净
    const fixedCode = fs.readFileSync(path.join(dir, 'lib', 'index.js'), 'utf8')
    const afterScan = scanStandards(dir, {
      files: [{ file: 'lib/index.js', source: fixedCode }],
    })
    assert.strictEqual(
      afterScan.findings.filter((f) => f.rule === 'loader-entry-shape').length,
      0,
      '修补后 loader-entry-shape 违规应彻底归零'
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
