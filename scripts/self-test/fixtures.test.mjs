// fixtures.test.mjs —— 事故夹具的全量回归。
//
// 这一节钉的是「判据可执行、结论可追溯」：每条真实事故一个最小复现切片，
// 自检启动时全量跑一遍。判据写松了（该报的不报）或写紧了（不该报的报了）
// 都会红，而不是靠注释提醒「下次别再踩」。
// 与 docs.test.mjs 的分工：那一节管文档与代码一致，这一节管判据与事故一致。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tests } from './harness.mjs'
import { runFixtures, listFixtures, loadExpected } from '../lib/fixtures.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const LEDGER = path.join(ROOT, 'references', 'incident-ledger.md')
// 安装副本形态：package.json 的 files 白名单不含 fixtures/（夹具是仓库内的判据资产，
// 随包分发的是判据本身，不是夹具切片）。装包后夹具不在，夹具断言必须诚实判 skipped，
// 不能报成「0 条夹具」或「账本漂移」——那是把「没带夹具」误报成「判据坏了」。
const FIXTURES_PRESENT = listFixtures().length > 0

test('夹具库：全量回归通过（判据写松或写紧都会红）', () => {
  if (!FIXTURES_PRESENT) return { skipped: '安装副本不含 fixtures/（files 白名单），夹具回归不在包内跑' }
  const result = runFixtures()
  assert.ok(result.total >= 9, `夹具数应至少 9 条，实际 ${result.total} 条——新增事故要配夹具`)
  assert.deepStrictEqual(
    result.failed,
    [],
    `这些夹具没过关：\n${result.failed.map((f) => `  ${f.id}: ${f.error}\n${JSON.stringify(f.detail, null, 2)}`).join('\n')}`,
  )
})

test('夹具库：每条 expected.json 都带来源与 fingerprint', () => {
  if (!FIXTURES_PRESENT) return { skipped: '安装副本不含 fixtures/（files 白名单）' }
  for (const id of listFixtures()) {
    const expected = loadExpected(id)
    assert.strictEqual(expected.id, id, `${id} 的 expected.id 与目录名不一致`)
    assert.ok(expected.source, `${id} 缺 source（事故来源）`)
    assert.ok(expected.symptom && expected.rootCause && expected.fix, `${id} 缺 symptom/rootCause/fix 三件套`)
    assert.ok(expected.check?.kind && expected.check?.assert, `${id} 缺可执行断言`)
    assert.ok(expected.fingerprint, `${id} 缺 fingerprint`)
  }
})

test('夹具库：fixtures/ 与 incident-ledger 双向对账（防各自漂移）', () => {
  // 复用既有双向断言模式：一边多一条、另一边少一行都要红。
  if (!FIXTURES_PRESENT) return { skipped: '安装副本不含 fixtures/（files 白名单），对账不在包内跑' }
  const ledger = fs.readFileSync(LEDGER, 'utf8')
  const ids = listFixtures()
  for (const id of ids) {
    assert.ok(ledger.includes(`\`${id}\``), `incident-ledger 未登记夹具 ${id}`)
  }
  // 账本「登记」表里每行都该有对应夹具（待入库小节明确标注为未切片，不计入）
  const registered = [...ledger.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1])
  const missing = registered.filter((id) => !ids.includes(id))
  assert.deepStrictEqual(missing, [], `账本登记了这些事故但没有夹具：${missing.join('、')}`)
})

test('夹具库：判据收窄的两侧都钉住（该报的报、不该报的不报）', () => {
  // waterfall 的三条夹具是同一判据的两侧：真断链必报，远 next 与对象字面量不报。
  // 只有单侧的夹具会让「把判据改坏」这件事静默通过。
  // 夹具的 pass 语义是「expected.assert 成立」：真断链夹具的断言是「命中 1 处」，
  // 所以判据改坏（不再报）时它变 failed；两条不误报夹具的断言是「命中 0 处」，
  // 所以判据改坏（开始误报）时它们变 failed。三个方向合起来才封住改动。
  if (!FIXTURES_PRESENT) return { skipped: '安装副本不含 fixtures/（files 白名单）' }
  const result = runFixtures()
  const failedIds = new Set(result.failed.map((f) => f.id))
  assert.ok(!failedIds.has('waterfall-real-break'), '真断链夹具应通过（判据要能报出来）')
  assert.ok(!failedIds.has('waterfall-far-next'), '远 next 夹具应通过（判据不能误报）')
  assert.ok(!failedIds.has('waterfall-object-literal-body'), '对象字面量体夹具应通过（判据不能误报）')
})

test('夹具库：夹具资产全部入库（防 .gitignore 吞夹具 mock 树）', () => {
  // 2026-11-21 实录：全局 `node_modules/` 忽略规则把 subpath-not-exported 夹具的
  // 模拟宿主树吞出库外——磁盘上有树所以本机自检全绿，CI 检出后没有树，
  // resolvePackageSubpathOnHost 返回 unknown，夹具门必红。判据：fixtures/ 下每个
  // 磁盘文件都必须被 git 追踪，忽略规则吞不掉夹具资产。
  if (!FIXTURES_PRESENT) return { skipped: '安装副本不含 fixtures/（files 白名单）' }
  let tracked
  try {
    tracked = new Set(
      execFileSync('git', ['ls-files', 'fixtures/'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n')
        .filter(Boolean),
    )
  } catch {
    return { skipped: '不在 git 仓库内（归档副本形态），入库核对不适用' }
  }
  const onDisk = []
  ;(function walk(dir) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) walk(p)
      else onDisk.push(path.relative(ROOT, p).split(path.sep).join('/'))
    }
  })(path.join(ROOT, 'fixtures'))
  const missing = onDisk.filter((f) => !tracked.has(f))
  assert.deepStrictEqual(
    missing,
    [],
    `这些夹具文件在磁盘上但没进版本库（.gitignore 吞掉则 CI 检出后夹具必红）：${missing.join('、')}`,
  )
})
