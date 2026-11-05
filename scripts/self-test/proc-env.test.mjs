// proc-env.test.mjs —— 子进程环境净化与链接安全删除的自检用例。
//
// 这组用例对应 2026-11-05 在 DSH 宿主会话内的实录：宿主做子进程凭证擦除时摘掉
// GIT_CONFIG_KEY_n 却留下 GIT_CONFIG_COUNT/VALUE_n，git 读到残缺组直接
// 「fatal: unable to parse command-line config」，本工具里每条 git 调用全挂。
// 用例覆盖三种形态：健康组不动、残缺组摘净、执行面真的能跑通 git。
// 零外部依赖；git 不可用的机器上只跳过「真跑 git」那一条，其余照跑。

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import { cleanGitEnv, diagnoseGitConfigGroup, gitChildEnv, removeDirSafely } from '../lib/proc-env.mjs'

const BROKEN = {
  PATH: process.env.PATH,
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_VALUE_1: 'false',
}

test('proc-env：健康配置组判为不残缺，环境对象一个字节不改', () => {
  const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'false' }
  assert.deepStrictEqual(diagnoseGitConfigGroup(env), { broken: false, count: 1, missingKeys: [] })
  const result = gitChildEnv(env)
  assert.strictEqual(result.repaired, false)
  assert.strictEqual(result.env, env, '组健康时必须返回同一个对象，不做无谓复制')
})

test('proc-env：无 GIT_CONFIG_COUNT 时不介入', () => {
  const env = { PATH: process.env.PATH }
  assert.strictEqual(gitChildEnv(env).repaired, false)
  assert.strictEqual(gitChildEnv(env).env, env)
})

test('proc-env：残缺组报出缺哪些键，净化后整组摘净且计数落 0', () => {
  const diagnosis = diagnoseGitConfigGroup(BROKEN)
  assert.strictEqual(diagnosis.broken, true)
  assert.deepStrictEqual(diagnosis.missingKeys, ['GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1'])

  const { env, repaired } = gitChildEnv(BROKEN)
  assert.strictEqual(repaired, true)
  assert.notStrictEqual(env, BROKEN, '净化要出副本，不动调用方的对象')
  assert.strictEqual(env.GIT_CONFIG_COUNT, '0', '显式表达零组命令行配置')
  assert.strictEqual(env.GIT_CONFIG_KEY_0, undefined)
  assert.strictEqual(env.GIT_CONFIG_VALUE_0, undefined)
  assert.strictEqual(env.GIT_CONFIG_VALUE_1, undefined)
  assert.strictEqual(BROKEN.GIT_CONFIG_COUNT, '2', '调用方对象保持原样')
})

test('proc-env：不碰 GIT_CONFIG_GLOBAL / SYSTEM / NOSYSTEM 这三个单键', () => {
  const env = {
    ...BROKEN,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const { env: cleaned } = gitChildEnv(env)
  assert.strictEqual(cleaned.GIT_CONFIG_GLOBAL, '/dev/null')
  assert.strictEqual(cleaned.GIT_CONFIG_SYSTEM, '/dev/null')
  assert.strictEqual(cleaned.GIT_CONFIG_NOSYSTEM, '1')
})

test('proc-env：计数本身不是合法数字也按残缺处理', () => {
  assert.strictEqual(diagnoseGitConfigGroup({ GIT_CONFIG_COUNT: 'abc' }).broken, true)
  assert.strictEqual(diagnoseGitConfigGroup({ GIT_CONFIG_COUNT: '-1' }).broken, true)
  assert.strictEqual(diagnoseGitConfigGroup({ GIT_CONFIG_COUNT: '0' }).broken, false, '零组是合法的')
})

test('proc-env：cleanGitEnv 可直接拼进自造 env', () => {
  const cleaned = cleanGitEnv({ ...BROKEN, DSH_PFA_RUNS_DIR: '/tmp/runs' })
  assert.strictEqual(cleaned.GIT_CONFIG_COUNT, '0')
  assert.strictEqual(cleaned.DSH_PFA_RUNS_DIR, '/tmp/runs')
})

test('proc-env：残缺组下 git 子进程真的能跑通（实录形态回归）', () => {
  let gitAvailable = true
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', env: cleanGitEnv(process.env) })
  } catch {
    gitAvailable = false
  }
  if (!gitAvailable) {
    process.stderr.write('  （跳过：本机 git 不可用）\n')
    return
  }

  const dir = tmpPluginDir('git-env')
  try {
    // 关键点：显式把「残缺组」交给 git，净化必须让这条命令活下来。
    // 不净化时 git 在这里就 fatal（实录：error: missing config key GIT_CONFIG_KEY_0）。
    const env = cleanGitEnv({ ...process.env, ...BROKEN })
    execFileSync('git', ['init', '-q'], { cwd: dir, env })
    fs.writeFileSync(`${dir}/a.txt`, 'x')
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir, env })
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir, env })
    assert.strictEqual(execFileSync('git', ['status', '--porcelain'], { cwd: dir, env, encoding: 'utf8' }).trim(), '', '提交后工作树应干净')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('proc-env：removeDirSafely 对真实目录递归删、对文件与链接只删本身', () => {
  const base = tmpPluginDir('proc-env-rm')
  try {
    const realDir = path.join(base, 'real')
    fs.mkdirSync(path.join(realDir, 'inner'), { recursive: true })
    fs.writeFileSync(path.join(realDir, 'inner', 'x.txt'), 'x')
    assert.deepStrictEqual(removeDirSafely(realDir), { removed: true, kind: 'dir' })
    assert.strictEqual(fs.existsSync(realDir), false)

    const file = path.join(base, 'a.txt')
    fs.writeFileSync(file, 'a')
    assert.deepStrictEqual(removeDirSafely(file), { removed: true, kind: 'file' })

    // 不存在的路径不报错、不伪造删除
    assert.deepStrictEqual(removeDirSafely(path.join(base, 'nope')), { removed: false, kind: 'absent' })
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('proc-env：removeDirSafely 删链接时绝不跟随进入目标（常设规则锚点）', () => {
  if (process.platform === 'win32') {
    process.stderr.write('  （跳过：Windows 建符号链接需特权，形态与 POSIX 不同）\n')
    return
  }
  const base = tmpPluginDir('proc-env-link')
  try {
    const target = path.join(base, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
    const link = path.join(base, 'link')
    fs.symlinkSync(target, link, 'dir')

    const result = removeDirSafely(link)
    assert.strictEqual(result.kind, 'symlink', '链接要按链接处理，不按目录递归删')
    assert.strictEqual(result.removed, true)
    assert.strictEqual(fs.existsSync(link), false, '链接本身应被删掉')
    assert.strictEqual(fs.existsSync(path.join(target, 'keep.txt')), true, '链接目标的内容一个字节都不能少')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})
