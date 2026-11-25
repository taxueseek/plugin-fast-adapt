// CLI 子命令路由回归用例：doctor / fleet / check / new 与向后兼容路径转发。
// 纯路由断言 + 真实子进程帮助/版本校验，全程离线。

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from './harness.mjs'
import { SUBCOMMANDS, resolveCliCommand, formatHelp } from '../cli.mjs'

const SCRIPTS = path.resolve(import.meta.dirname, '..')
const ROOT = path.resolve(SCRIPTS, '..')
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('cli：四条子命令精准路由并原样透传后续参数', () => {
  assert.deepStrictEqual(resolveCliCommand(['doctor', '--brief']), {
    action: 'run',
    script: 'env-doctor.mjs',
    args: ['--brief'],
  })
  assert.deepStrictEqual(resolveCliCommand(['fleet', '--running', '--json']), {
    action: 'run',
    script: 'fleet-sweep.mjs',
    args: ['--running', '--json'],
  })
  assert.deepStrictEqual(resolveCliCommand(['check', './my-plugin', '--offline']), {
    action: 'run',
    script: 'run.mjs',
    args: ['./my-plugin', '--offline'],
  })
  assert.deepStrictEqual(resolveCliCommand(['new', 'acme/hello', '--form', 'tool']), {
    action: 'run',
    script: 'scaffold.mjs',
    args: ['acme/hello', '--form', 'tool'],
  })
})

test('cli：子命令自带 --help 时透传给目标脚本，不被顶层截胡', () => {
  assert.deepStrictEqual(resolveCliCommand(['fleet', '--help']), {
    action: 'run',
    script: 'fleet-sweep.mjs',
    args: ['--help'],
  })
  assert.deepStrictEqual(resolveCliCommand(['new', '--help']), {
    action: 'run',
    script: 'scaffold.mjs',
    args: ['--help'],
  })
})

test('cli：直接传插件目录保持向后兼容，转发到 run.mjs', () => {
  assert.deepStrictEqual(resolveCliCommand(['./my-plugin', '--real-smoke']), {
    action: 'run',
    script: 'run.mjs',
    args: ['./my-plugin', '--real-smoke'],
  })
})

test('cli：无参、help、--help、--version 返回对应顶层动作', () => {
  assert.deepStrictEqual(resolveCliCommand([]), { action: 'help' })
  assert.deepStrictEqual(resolveCliCommand(['--help']), { action: 'help' })
  assert.deepStrictEqual(resolveCliCommand(['-h']), { action: 'help' })
  assert.deepStrictEqual(resolveCliCommand(['help']), { action: 'help' })
  assert.deepStrictEqual(resolveCliCommand(['--version']), { action: 'version' })
  assert.deepStrictEqual(resolveCliCommand(['-v']), { action: 'version' })
})

test('cli：每个子命令对应的目标脚本真实存在', () => {
  for (const [cmd, file] of Object.entries(SUBCOMMANDS)) {
    const full = path.join(SCRIPTS, file)
    assert.ok(fs.existsSync(full), `子命令 ${cmd} 指向的脚本不存在：${full}`)
  }
})

test('cli：真实子进程跑 --help 与 --version 输出版本号与全部子命令', () => {
  const help = spawnSync(process.execPath, [path.join(SCRIPTS, 'cli.mjs'), '--help'], { encoding: 'utf8' })
  assert.strictEqual(help.status, 0)
  assert.match(help.stdout, new RegExp(`plugin-fast-adapt v${PKG.version.replaceAll('.', '\\.')}`))
  for (const cmd of ['doctor', 'fleet', 'check', 'new']) {
    assert.ok(help.stdout.includes(`plugin-fast-adapt ${cmd}`), `--help 应列出 ${cmd}`)
  }

  const ver = spawnSync(process.execPath, [path.join(SCRIPTS, 'cli.mjs'), '--version'], { encoding: 'utf8' })
  assert.strictEqual(ver.status, 0)
  assert.strictEqual(ver.stdout.trim(), `plugin-fast-adapt v${PKG.version}`)
  assert.ok(formatHelp(PKG.version).includes('doctor'))
})
