// 幽灵宿主与 tsconfig 假绿的自检。
//
// 判定逻辑全部抽成纯函数：进程启动时间与磁盘变更时间都由用例注入，
// 不依赖本机真的跑着一个老宿主，也不依赖网络。

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import {
  parseEtimeSeconds,
  judgeGhostHost,
  pickHostProcesses,
  probeDiskChangeTime,
  checkTsconfigFalseGreen,
  parseJsonc,
  isHarnessCheckout,
} from '../env-doctor.mjs'

// ── 进程启动时间解析 ────────────────────────────────────────────────────────

test('ps etime 三种格式都解析成秒', () => {
  assert.strictEqual(parseEtimeSeconds('11:52'), 11 * 60 + 52)
  assert.strictEqual(parseEtimeSeconds('01:36:09'), 3600 + 36 * 60 + 9)
  assert.strictEqual(parseEtimeSeconds('02-14:12:54'), 2 * 86400 + 14 * 3600 + 12 * 60 + 54)
  assert.strictEqual(parseEtimeSeconds(''), null)
  assert.strictEqual(parseEtimeSeconds('not-a-duration'), null)
})

// ── 幽灵宿主判定 ────────────────────────────────────────────────────────────

test('幽灵宿主：没有运行中的宿主进程 → no-running-host', () => {
  const result = judgeGhostHost({ processes: [], diskTimeMs: 1000 })
  assert.strictEqual(result.verdict, 'no-running-host')
})

test('幽灵宿主：磁盘时间不可用 → unknown，不猜', () => {
  const result = judgeGhostHost({ processes: [{ pid: '1', startedAtMs: 2000 }], diskTimeMs: null })
  assert.strictEqual(result.verdict, 'unknown')
  assert.match(result.reason, /磁盘侧/)
})

test('幽灵宿主：进程启动早于磁盘变更 → stale 并点出 pid', () => {
  const now = 1_700_000_000_000
  const result = judgeGhostHost({
    processes: [{ pid: '4242', startedAtMs: now - 10 * 60 * 1000 }],
    diskTimeMs: now,
  })
  assert.strictEqual(result.verdict, 'stale')
  assert.deepStrictEqual(result.stale.map((p) => p.pid), ['4242'])
  assert.match(result.reason, /重启宿主/)
})

test('幽灵宿主：进程启动晚于磁盘变更 → ok', () => {
  const now = 1_700_000_000_000
  const result = judgeGhostHost({
    processes: [{ pid: '1', startedAtMs: now }],
    diskTimeMs: now - 10 * 60 * 1000,
  })
  assert.strictEqual(result.verdict, 'ok')
})

test('幽灵宿主：120 秒容差内的先后抖动不算 stale', () => {
  const now = 1_700_000_000_000
  const result = judgeGhostHost({
    processes: [{ pid: '1', startedAtMs: now - 60 * 1000 }],
    diskTimeMs: now,
    toleranceSeconds: 120,
  })
  assert.strictEqual(result.verdict, 'ok')
})

test('幽灵宿主：所有进程时间都解析不出 → unknown', () => {
  const result = judgeGhostHost({
    processes: [{ pid: '1', startedAtMs: null }],
    diskTimeMs: 1000,
  })
  assert.strictEqual(result.verdict, 'unknown')
})

// ── 宿主进程筛选 ────────────────────────────────────────────────────────────

test('只认 CLI 宿主主进程：renderer 与插件名不冒充', () => {
  const now = 1_700_000_000_000
  const picked = pickHostProcesses(
    [
      { pid: '1', elapsed: '11:52', command: 'node /usr/local/bin/dsh web' },
      { pid: '2', elapsed: '01:36:09', command: '/Applications/DeepSeek Harness.app/Contents/MacOS/Helper --type=renderer --user-data-dir=@deepseek-ai/dsh-desktop' },
      { pid: '3', elapsed: '02-14:12:54', command: 'node /repo/dsh-plugin-foo/serve/index.js' },
      { pid: '4', elapsed: '00:05', command: 'node /repo/@deepseek-ai/dsh/bin/dsh.js serve' },
    ],
    now,
  )
  assert.deepStrictEqual(picked.map((p) => p.pid), ['1', '4'])
  assert.strictEqual(picked[0].startedAtMs, now - (11 * 60 + 52) * 1000)
})

// ── 磁盘变更时间 ────────────────────────────────────────────────────────────

test('磁盘变更时间：npm 布局读目录时间，位置不存在返回 null', () => {
  const dir = tmpPluginDir('ghostdisk')
  try {
    fs.mkdirSync(path.join(dir, '@deepseek-ai', 'dsh'), { recursive: true })
    fs.writeFileSync(path.join(dir, '@deepseek-ai', 'dsh', 'package.json'), '{"name":"x"}')
    const info = probeDiskChangeTime({ version: '1.0.0', location: path.join(dir, '@deepseek-ai', 'dsh'), source: 'node_modules' })
    assert.ok(Number.isFinite(info.diskTimeMs), '应读到有限的时间戳')
    assert.ok(info.source, '应标明时间来源')
    const missing = probeDiskChangeTime({ version: '1.0.0', location: path.join(dir, 'nope'), source: 'node_modules' })
    assert.strictEqual(missing.diskTimeMs, null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('只把真正的 harness 源码检出当 git 来源，外层主目录仓不算', () => {
  const dir = tmpPluginDir('harness-check')
  try {
    assert.strictEqual(isHarnessCheckout(os.homedir()), false)
    assert.strictEqual(isHarnessCheckout(dir), false)
    fs.mkdirSync(path.join(dir, 'packages'))
    assert.strictEqual(isHarnessCheckout(dir), false, '只有 packages 目录不够')
    fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n')
    assert.strictEqual(isHarnessCheckout(dir), true)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── tsconfig 假绿 ───────────────────────────────────────────────────────────

function writeTree(files) {
  const dir = tmpPluginDir('falsegreen')
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content)
  }
  return dir
}

test('JSONC：注释与尾逗号能解析，字符串里的 // 不当注释', () => {
  const parsed = parseJsonc('{\n // 行注释\n "url": "https://example.com/x",\n /* 块注释 */\n "a": 1,\n}\n')
  assert.strictEqual(parsed.url, 'https://example.com/x')
  assert.strictEqual(parsed.a, 1)
})

test('tsconfig 假绿：paths 指向不存在的宿主 checkout → high（M1）', () => {
  const dir = writeTree({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { paths: { '@dsh/*': ['../missing-harness/packages/*'] } },
    }),
  })
  try {
    const result = checkTsconfigFalseGreen(dir)
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.findings[0].severity, 'high')
    assert.strictEqual(result.findings[0].alias, '@dsh/*')
    assert.match(result.findings[0].message, /静默回落/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tsconfig 假绿：目标存在就不报', () => {
  const dir = writeTree({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'src/index.ts': 'export {}\n',
  })
  try {
    assert.strictEqual(checkTsconfigFalseGreen(dir).count, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tsconfig 假绿：extends 继承的 paths 也查', () => {
  const dir = writeTree({
    'tsconfig.base.json': JSON.stringify({ compilerOptions: { paths: { '@host/*': ['../gone/*'] } } }),
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
  })
  try {
    const result = checkTsconfigFalseGreen(dir)
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.findings[0].alias, '@host/*')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tsconfig 假绿：非宿主 alias 指向缺失目录 → medium，不冒充宿主问题', () => {
  const dir = writeTree({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./nope/*'] } } }),
  })
  try {
    const result = checkTsconfigFalseGreen(dir)
    assert.strictEqual(result.count, 1)
    assert.strictEqual(result.findings[0].severity, 'medium')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('tsconfig 假绿：无扩展名的文件别名能识别 .d.ts', () => {
  const dir = writeTree({
    'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@types': ['./types'] } } }),
    'types.d.ts': 'export {}\n',
  })
  try {
    assert.strictEqual(checkTsconfigFalseGreen(dir).count, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
