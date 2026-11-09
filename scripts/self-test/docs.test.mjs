// docs.test.mjs —— 文档与代码一致性门禁。
//
// 这一节钉的是「文档说的和代码做的是不是一回事」：脚本清单双向对齐、断言数不漂移、
// 安全姿态如实披露、常设规则条数不硬编码。从 self-test.mjs 拆出来是因为单文件有
// 2200 行体积门禁——门禁触线时按节拆是本仓的规定动作，别让单文件无界生长。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, tests } from './harness.mjs'

test('车道文档里的命令脚本都在工具根存在，且声明了工具根工作目录', () => {
  // 车道目录以软链别名单独加载时没有 scripts/，旧文档写「在技能根执行」会指向不存在的路径
  const root = path.resolve(import.meta.dirname, '..', '..')
  let checked = 0
  for (const lane of ['adapt', 'build', 'diagnose']) {
    const text = fs.readFileSync(path.join(root, 'sub-skills', lane, 'SKILL.md'), 'utf8')
    assert.ok(text.includes('工具根目录执行'), `sub-skills/${lane} 应声明命令在工具根目录执行`)
    assert.ok(!text.includes('技能根目录执行'), `sub-skills/${lane} 仍写「技能根目录执行」，单独加载时找不到 scripts/`)
    for (const m of text.matchAll(/node (scripts\/[\w./-]+\.mjs)/g)) {
      assert.ok(fs.existsSync(path.join(root, m[1])), `sub-skills/${lane} 引用的 ${m[1]} 不存在`)
      checked++
    }
  }
  assert.ok(checked >= 10, `应至少核对 10 处命令，实际 ${checked} 处`)
})

test('主技能与两份 README 的脚本清单双向对齐：正文引用的脚本存在，清单不漏脚本', () => {
  // 上一条只锁三条车道；cli.mjs 曾只存在于 scripts/ 而不在主技能清单里。
  // 后来两份 README 的清单也各漏 5 个脚本，只因门禁只查 SKILL.md 才没拦住，
  // 所以把三份文档一起收进这张网：脚本集合只有一份，清单就不该有三套说法。
  const root = path.resolve(import.meta.dirname, '..', '..')
  const docs = ['SKILL.md', 'README.md', 'README.en.md']
  const scriptFiles = fs.readdirSync(path.join(root, 'scripts')).filter((f) => f.endsWith('.mjs'))
  for (const doc of docs) {
    const text = fs.readFileSync(path.join(root, doc), 'utf8')
    let referenced = 0
    for (const m of text.matchAll(/node (scripts\/[\w./-]+\.mjs)/g)) {
      assert.ok(fs.existsSync(path.join(root, m[1])), `${doc} 引用的 ${m[1]} 不存在`)
      referenced++
    }
    assert.ok(referenced >= 3, `${doc} 应至少引用 3 处命令，实际 ${referenced} 处`)
    // SKILL.md 写 `run.mjs`，两份 README 写 `scripts/run.mjs`，前缀可省。
    const listed = new Set([...text.matchAll(/^\| `((?:scripts\/)?[\w-]+\.mjs)` \|/gm)].map((m) => m[1].replace(/^scripts\//, '')))
    assert.ok(listed.size >= 15, `${doc} 脚本清单表应至少 15 行，实际 ${listed.size}`)
    for (const f of scriptFiles) {
      assert.ok(listed.has(f), `scripts/${f} 未进 ${doc} 脚本清单表`)
    }
  }
})

test('文档宣称的断言数与实际一致（防手工漂移）', () => {
  // 这个数字已漂过两次（49→50→54 都是事后手补）；现在让自检拦住它
  const root = path.resolve(import.meta.dirname, '..', '..')
  const docs = ['SKILL.md', 'README.md', 'README.en.md'].map((f) => path.join(root, f))
  let checked = 0
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8')
    const numbers = [
      ...text.matchAll(/(\d+)\s*项断言/g),
      ...text.matchAll(/(\d+)\s*项自检/g),
      ...text.matchAll(/(\d+)\s*assertions/g),
    ].map((m) => Number(m[1]))
    assert.ok(numbers.length > 0, `${path.basename(doc)} 应写明断言数，否则本断言失去保护对象`)
    for (const n of numbers) {
      assert.strictEqual(n, tests.length, `${path.basename(doc)} 宣称 ${n} 项断言，实际 ${tests.length} 项`)
    }
    checked += numbers.length
  }
  assert.ok(checked >= 5, `应至少核对 5 处断言数，实际 ${checked} 处`)
})

test('文档安全姿态与常设规则条数对齐代码（防 README 与代码各说各话）', () => {
  const root = path.resolve(import.meta.dirname, '..', '..')
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
  const main = read('SKILL.md')
  const zh = read('README.md')
  const en = read('README.en.md')
  const adapt = read('sub-skills/adapt/SKILL.md')

  // 1. 自动修补已不止两类：codemod / fix-peer-deps 之外还有 fleet-sweep
  //    --apply-compat 写 package.json（已补备份）。三份文档都不能再宣称「从不改插件代码」。
  assert.ok(!/不自动改插件代码/.test(zh), 'README.md 仍宣称「不自动改插件代码」，与 codemod/fix-peer-deps/fleet-sweep 的三个写盘入口矛盾')
  assert.ok(!/Never edits plugin code automatically/.test(en), 'README.en.md 仍宣称从不自动改插件代码')
  for (const [name, text] of [['SKILL.md', main], ['README.md', zh], ['README.en.md', en]]) {
    // 只看安全姿态那几行：正文清单表本来就列了 fleet-sweep.mjs，全篇搜会假绿。
    const safetyLines = text.split('\n').filter((l) => /自动修补|自动改插件代码|Automatic plugin-code edits|三类/.test(l)).join('\n')
    assert.ok(/fleet-sweep/.test(safetyLines), `${name} 的安全姿态未把 fleet-sweep --apply-compat 列入自动修补边界`)
  }

  // 2. run-log 的 sanitize --out 会写文件，文档必须如实披露这一例外，不能只写
  //    「完全只读」。这里锁披露句而非禁掉 run-log 字样——正确的文档本来就要点名它。
  for (const [name, text] of [['SKILL.md', main], ['README.md', zh], ['README.en.md', en]]) {
    assert.ok(/sanitize --out/.test(text), `${name} 未披露 run-log 的 sanitize --out 写盘例外`)
    const line = text.split('\n').find((l) => /完全只读|完全不写文件|strictly read-only/.test(l))
    assert.ok(line && /sanitize --out/.test(line), `${name} 的只读清单行未在同行披露 run-log 的 sanitize --out 例外`)
  }

  // 3. 常设规则条数：SKILL.md 与 sub-skill 必须一致，且代码里不许再出现
  //    「四条 / 五条 / 六条」这类硬编码中文数字——旧门禁只禁了「四条」这一个
  //    字符串，规则表加到 8 条时它照样绿。这里禁的是整类写法。
  const m = main.match(/机械可判的 (\d+) 条 `standards-scan`/)
  assert.ok(m, 'SKILL.md 来源表缺规则条数')
  assert.ok(adapt.includes(`${m[1]} 条机械可判的常设规则`), `sub-skills/adapt/SKILL.md 的常设规则条数应与 SKILL.md 的 ${m[1]} 条一致`)
  const CN_NUM = '一二三四五六七八九十'
  const hardcoded = /机械可判的[一二三四五六七八九十]+条|只跑机械可判的[一二三四五六七八九十]+条/
  for (const [name, text] of [['scripts/plugin-audit.mjs', read('scripts/plugin-audit.mjs')], ['SKILL.md', main], ['sub-skills/adapt/SKILL.md', adapt]]) {
    assert.ok(!hardcoded.test(text), `${name} 用中文数字硬编码了常设规则条数，规则表一变就漂移；改写成「条数以规则表为准」`)
  }
})

test('状态词表：run.mjs 与 runlog.mjs 不再手写阶段状态字面量（单一真源对账）', async () => {
  // 这一条是「同一类问题只修了一处」的机器版：run.mjs 曾 24 处手写 status 字面量，
  // runlog.mjs 又按另一套派生逻辑读它们。加一个状态名要改 N 处，漏一处就是静默失配。
  // 现在写入点与派生都从 lib/run-states.mjs 取值，门禁钉住这件事不再回退。
  const root = path.resolve(import.meta.dirname, '..', '..')
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
  const { STAGE_STATUS, TYPECHECK_STATUS, SMOKE_STATUS, REAL_SMOKE_STATUS, ALL_STATUSES } = await import('../lib/run-states.mjs')
  const runSrc = read('scripts/run.mjs')
  const runlogSrc = read('scripts/lib/runlog.mjs')

  // 1. 词表本身自洽：不同词表之间的值可以同名（ok/skipped/error 是多阶段共用的），
  //    但同一张表内不允许两个键指向同一个值（那才是真的重复定义）。
  const vocab = { STAGE_STATUS, TYPECHECK_STATUS, SMOKE_STATUS, REAL_SMOKE_STATUS }
  for (const [name, table] of Object.entries(vocab)) {
    const values = Object.values(table)
    assert.strictEqual(new Set(values).size, values.length, `${name} 内有两个键指向同一个状态值`)
  }
  assert.deepStrictEqual([...ALL_STATUSES].sort(), ['error', 'fail', 'inconclusive', 'ok', 'skipped'], 'ALL_STATUSES 并集漂移')

  // 2. 写入点不再出现裸字面量。允许出现在注释里（说明文字），不允许出现在
  //    `status:` 赋值或 `===` 比较的位置。
  const literalUse = (src, label) => {
    const offenders = []
    for (const [i, line] of src.split('\n').entries()) {
      const code = line.replace(/^\s*\/\/.*$/, '').trim()
      if (!code) continue
      if (/status:\s*'/.test(code) || /status\s*===\s*'/.test(code) || /status\s*!==\s*'/.test(code)) {
        offenders.push(`${label}:${i + 1}: ${code}`)
      }
    }
    return offenders
  }
  const offenders = [...literalUse(runSrc, 'run.mjs'), ...literalUse(runlogSrc, 'runlog.mjs')]
  assert.deepStrictEqual(offenders, [], `这些位置仍在手写状态字面量，应改走 lib/run-states.mjs：\n${offenders.join('\n')}`)

  // 3. runlog 的 phasesOf 只从词表派生，不再有自己的字面量分支
  assert.ok(/phasesOf/.test(runlogSrc), 'runlog.mjs 应使用词表导出的 phasesOf')
  assert.ok(!/record\.typecheck\.status \?\?/.test(runlogSrc), 'runlog 不应再自己派生 typecheck 状态（已收进 run-states.phasesOf）')
})

test('文档分层：过程报告（research/）不进技能面，技能面文件都在 package.json files 白名单里', async () => {
  // argo v2.13.0 的文档分层收口（docs/ 87→26）：真源、生成物、公开文档、过程报告
  // 四层分开，过程报告归档不进公开仓。本技能的同构动作：research/ 是过程报告，
  // 不该打进 npm 包（读者不会用，还会随每次调研增长）。
  const root = path.resolve(import.meta.dirname, '..', '..')
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
  const pkg = JSON.parse(read('package.json'))
  const files = pkg.files || []
  assert.ok(!files.includes('research/**/*.md'), 'research/ 是过程报告，不该进 npm 包；移到 docs-local/archive/ 或直接删除')
  assert.ok(!files.includes('fixtures/**'), 'fixtures/ 是自检资产，不该进 npm 包（随包分发的是判据，不是夹具）')

  // 技能面同步的真源 sync-skill.mjs 也要跟上：它的同步面固定为五类文件，
  // 不应把 research/ 或 fixtures/ 镜像到下游。
  const syncSrc = read('scripts/sync-skill.mjs')
  assert.ok(!/research/.test(syncSrc), 'sync-skill 的同步面不应包含 research/')
})
