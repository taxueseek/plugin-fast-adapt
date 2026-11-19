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
  const docs = ['SKILL.md', 'README.md', 'README.zh-CN.md', 'README.ja.md']
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
  const docs = ['SKILL.md', 'README.md', 'README.zh-CN.md', 'README.ja.md'].map((f) => path.join(root, f))
  let checked = 0
  for (const doc of docs) {
    const text = fs.readFileSync(doc, 'utf8')
    const numbers = [
      ...text.matchAll(/(\d+)\s*项断言/g),
      ...text.matchAll(/(\d+)\s*项自检/g),
      ...text.matchAll(/(\d+)\s*assertions/g),
      ...text.matchAll(/(\d+)\s*個のアサーション/g),
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
  const zh = read('README.zh-CN.md')
  const en = read('README.md')
  const ja = read('README.ja.md')
  const adapt = read('sub-skills/adapt/SKILL.md')

  // 1. 自动修补已不止两类：codemod / fix-peer-deps 之外还有 fleet-sweep
  //    --apply-compat 写 package.json（已补备份）。四份文档都不能再宣称「从不改插件代码」。
  assert.ok(!/不自动改插件代码/.test(zh), 'README.zh-CN.md 仍宣称「不自动改插件代码」，与 codemod/fix-peer-deps/fleet-sweep 的三个写盘入口矛盾')
  assert.ok(!/Never edits plugin code automatically/.test(en), 'README.md 仍宣称从不自动改插件代码')
  assert.ok(!/プラグインコードを自動的に編集することはない/.test(ja), 'README.ja.md 仍宣称绝不自动修改插件代码')
  for (const [name, text] of [['SKILL.md', main], ['README.md', en], ['README.zh-CN.md', zh], ['README.ja.md', ja]]) {
    // 只看安全姿态那几行：正文清单表本来就列了 fleet-sweep.mjs，全篇搜会假绿。
    const safetyLines = text.split('\n').filter((l) => /自动修补|自动改插件代码|Automatic plugin-code edits|プラグインコードの自動修復|三类/.test(l)).join('\n')
    assert.ok(/fleet-sweep/.test(safetyLines), `${name} 的安全姿态未把 fleet-sweep --apply-compat 列入自动修补边界`)
  }

  // 2. run-log 的 sanitize --out 会写文件，文档必须如实披露这一例外，不能只写
  //    「完全只读」。这里锁披露句而非禁掉 run-log 字样——正确的文档本来就要点名它。
  for (const [name, text] of [['SKILL.md', main], ['README.md', en], ['README.zh-CN.md', zh], ['README.ja.md', ja]]) {
    assert.ok(/sanitize --out/.test(text), `${name} 未披露 run-log 的 sanitize --out 写盘例外`)
    const line = text.split('\n').find((l) => /完全只读|完全不写文件|strictly read-only|厳格に読み取り専用/.test(l))
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

test('状态词表：状态字面量只从 lib/run-states.mjs 取（单一真源对账）', async () => {
  // 这一条是「同一类问题只修了一处」的机器版：run.mjs 曾 24 处手写 status 字面量，
  // runlog.mjs 又按另一套派生逻辑读它们。加一个状态名要改 N 处，漏一处就是静默失配。
  // 现在写入点与派生都从 lib/run-states.mjs 取值，门禁钉住这件事不再回退。
  // 扫描面原先只有 run.mjs 与 runlog.mjs，fleet-sweep 的构建/生命周期/健康三套
  // 字面量在门禁盲区里——2026-11-19 起扫描面是全 scripts/**/*.mjs（含 self-test 自身）。
  const root = path.resolve(import.meta.dirname, '..', '..')
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8')
  const { STAGE_STATUS, TYPECHECK_STATUS, SMOKE_STATUS, REAL_SMOKE_STATUS, BUILD_STATUS, LIFECYCLE_STATE, HEALTH_STATUS, PKG_PROBE_STATUS, HOST_PRESENCE, CHECK_VERDICT, SYMBOL_TEXT_PRESENCE, ALL_STATUSES } = await import('../lib/run-states.mjs')

  // 1. 词表本身自洽：不同词表之间的值可以同名（ok/skipped/error 是多阶段共用的），
  //    但同一张表内不允许两个键指向同一个值（那才是真的重复定义）。
  const vocab = { STAGE_STATUS, TYPECHECK_STATUS, SMOKE_STATUS, REAL_SMOKE_STATUS, BUILD_STATUS, LIFECYCLE_STATE, HEALTH_STATUS, PKG_PROBE_STATUS, HOST_PRESENCE, CHECK_VERDICT, SYMBOL_TEXT_PRESENCE }
  for (const [name, table] of Object.entries(vocab)) {
    const values = Object.values(table)
    assert.strictEqual(new Set(values).size, values.length, `${name} 内有两个键指向同一个状态值`)
  }
  // 逐张表断言，不用扁平字母序：扁平比在「新增一张表」时只报「并集漂移」，
  // 逐张比能直接指出是哪一面漏了。
  assert.deepStrictEqual([...Object.values(STAGE_STATUS)].sort(), ['error', 'ok', 'skipped'])
  assert.deepStrictEqual([...Object.values(TYPECHECK_STATUS)].sort(), ['fail', 'ok', 'skipped'])
  assert.deepStrictEqual([...Object.values(SMOKE_STATUS)].sort(), ['error', 'fail', 'ok', 'skipped'])
  assert.deepStrictEqual([...Object.values(REAL_SMOKE_STATUS)].sort(), ['fail', 'inconclusive', 'ok', 'skipped'])
  assert.deepStrictEqual([...Object.values(BUILD_STATUS)].sort(), ['CORRUPTED', 'N/A', 'OK', 'UNBUILT'])
  assert.deepStrictEqual([...Object.values(LIFECYCLE_STATE)].sort(), ['DISABLED', 'ENABLED', 'RUNNING', 'WORKSPACE'])
  assert.deepStrictEqual([...Object.values(HEALTH_STATUS)].sort(), ['broken', 'healthy', 'warning'])
  assert.deepStrictEqual([...Object.values(PKG_PROBE_STATUS)].sort(), ['corrupt', 'missing', 'ok'])
  assert.deepStrictEqual([...Object.values(HOST_PRESENCE)].sort(), ['absent', 'present', 'unknown'])
  assert.deepStrictEqual([...Object.values(CHECK_VERDICT)].sort(), ['fail', 'pass', 'skip', 'unknown', 'warn'])
  assert.deepStrictEqual([...Object.values(SYMBOL_TEXT_PRESENCE)].sort(), ['text-absent', 'text-present', 'unknown'])
  // 并集是所有表的去重新增集合，与逐张表自洽互为校验
  const union = [...new Set(Object.values(vocab).flatMap((t) => Object.values(t)))].sort()
  assert.deepStrictEqual([...ALL_STATUSES].sort(), union, 'ALL_STATUSES 与各表并集不一致')

  // 2. 全 scripts/**/*.mjs 扫描面：不允许手写词表外的状态字面量。
  //    判据按**值域**判，不按字段名判：`status` 这个字段名在本仓横跨构建面、
  //    宿主在场面、检查结论面与符号搜索面（host-scope / seams / release-rules /
  //    plugin-audit / code-scan 各用各的面），按字段名映射到单面会误报一大片。
  //    值落在任一词表内 = 合法；一个都不落 = 手写了新状态，必须进词表。
  //    注释行跳过（说明文字不算违规）。
  const allStatusValues = new Set(Object.values(vocab).flatMap((t) => Object.values(t)))
  const STATUS_FIELD_NAMES = ['status', 'state', 'healthStatus', 'buildStatus']
  const srcFiles = listScriptsRecursive(path.join(root, 'scripts'), root)
  const offenders = srcFiles.flatMap((f) => literalUse(read(f), f, STATUS_FIELD_NAMES, allStatusValues))
  assert.deepStrictEqual(offenders, [], `这些位置手写了词表外的状态字面量，应改走 lib/run-states.mjs：\n${offenders.join('\n')}`)

  // 3. runlog 的 phasesOf 只从词表派生，不再有自己的字面量分支
  const runlogSrc = read('scripts/lib/runlog.mjs')
  assert.ok(/phasesOf/.test(runlogSrc), 'runlog.mjs 应使用词表导出的 phasesOf')
  assert.ok(!/record\.typecheck\.status \?\?/.test(runlogSrc), 'runlog 不应再自己派生 typecheck 状态（已收进 run-states.phasesOf）')

  // 4. phasesOf 必须认 fast-pass 记录的顶层 phases 形状。
  //    实录：2026-11-19T12:24:25.549Z 的直通记录被 list 显示成 "?"、doctor 判成
  //    scan-unknown，而记录里 phases.scan 明明是 ok。派生少认一种形状 = 静默失配。
  const { phasesOf } = await import('../lib/run-states.mjs')
  const fastPassRecord = { phases: { scan: 'ok', smoke: 'ok', typecheck: 'skipped', realSmoke: null } }
  assert.deepStrictEqual(phasesOf(fastPassRecord), fastPassRecord.phases, '直通记录的 phases 应原样投影，不能变成全 null')
  // 全量报告形状不能被直通分支吃掉
  assert.strictEqual(
    phasesOf({ scan: { findingCount: 0 }, smoke: { success: true }, typecheck: { status: 'ok' } }).scan,
    'ok',
    '全量报告仍应从 scan/smoke 字段派生',
  )
  assert.strictEqual(phasesOf({}).scan, null, '无字段仍为 null（未知）')
})

/** 抓一个源文件里的状态字面量。注释行跳过（说明文字不算违规）。
 *  值在 allowedValues 外即违规——判据是值域而非字段名，见上方说明。 */
function literalUse(src, label, fieldNames, allowedValues) {
  const offenders = []
  for (const [i, line] of src.split('\n').entries()) {
    const code = line.replace(/^\s*\/\/.*$/, '').trim()
    if (!code) continue
    for (const field of fieldNames) {
      const m = code.match(new RegExp(`${field}:\\s*'([^']*)'`)) || code.match(new RegExp(`${field}\\s*(?:===|!==)\\s*'([^']*)'`))
      if (m && !allowedValues.has(m[1])) offenders.push(`${label}:${i + 1}: ${code}`)
    }
  }
  return offenders
}

/** 递归列出 scripts/ 下的 .mjs（相对仓库根），跳过 node_modules 与 tmp。 */
function listScriptsRecursive(dir, root) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === 'tmp') continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...listScriptsRecursive(full, root))
    else if (ent.name.endsWith('.mjs')) out.push(path.relative(root, full))
  }
  return out.sort()
}

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
