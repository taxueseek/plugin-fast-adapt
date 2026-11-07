// 插件形态的激活契约回归（2026-11-07 实录）。
//
// 背景：plugin-fast-adapt 自身带 DSH 原生插件形态（lib/index.js + cordis.patch.yml），
// 但 `inject` 里写了 cordis 旧式 `command` 面，而 DSH 宿主只提供 `commands`。
// 多声明一个不存在的服务不会报错，而是让整个插件静默 pending——真宿主实测：
//   plugin-fast-adapt (plugin-fast-adapt): pending (waiting for service: command)
// 即「插件形态装了但从未激活」。而 quick-smoke 与四维体检当时都判满分，
// 因为它们只验自己声明的东西，从不验「声明的服务宿主是否真的提供」。
//
// 本节把两件事钉住：
//   1. 本仓插件形态的 inject 只含宿主确实提供的服务；
//   2. 声明 inject 前先过一遍宿主服务清单，不再凭印象写。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from './harness.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

// 宿主 base bundle 的服务 id 清单。取不到时返回 null，用例跳过而不是假通过——
// 清单是外部事实，本机没装宿主就不该假装验过。
function hostServiceIds() {
  const candidates = [
    path.join(
      process.env.DSH_HOST_PATH || '',
      'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml',
    ),
    path.join(
      process.env.HOME || '',
      '.local', 'lib', 'node_modules', '@deepseek-ai', 'dsh',
      'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml',
    ),
  ]
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue
    const ids = new Set()
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s+- id:\s*(\S+)\s*$/)
      if (m) ids.add(m[1])
    }
    if (ids.size) return ids
  }
  return null
}

test('插件形态：inject 只声明宿主确实提供的服务（不含 cordis 旧式 command 面）', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const m = entry.match(/export const inject\s*=\s*\[([^\]]*)\]/)
  assert.ok(m, 'lib/index.js 应导出 inject 数组')
  const declared = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1])
  assert.ok(declared.length > 0, 'inject 不应为空')

  // 硬判据：cordis 旧式 command 面在 DSH 里不存在，写进 inject 就是静默 pending
  assert.ok(
    !declared.includes('command'),
    `inject 不得含 cordis 旧式 'command' 面（DSH 只提供 'commands'）：${declared.join(', ')}`,
  )
  assert.ok(declared.includes('commands'), '命令面应声明宿主真实提供的 commands 服务')

  // 有宿主清单时逐条核对；没有则只跑上面的硬判据
  const ids = hostServiceIds()
  if (!ids) {
    process.stderr.write('  （跳过：本机未找到宿主 base bundle，无法核对服务清单）\n')
    return
  }
  const unknown = declared.filter((name) => !ids.has(name))
  assert.deepStrictEqual(
    unknown,
    [],
    `inject 声明了宿主不提供的服务：${unknown.join(', ')}（宿主实际提供 ${[...ids].length} 个服务）`,
  )
})

test('插件形态：入口导出面完整且命令注册走 ctx.inject 按需解析', () => {
  const entry = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  for (const name of ['name', 'inject', 'Config', 'apply']) {
    assert.ok(entry.includes(`export const ${name}`) || entry.includes(`export function ${name}`), `应导出 ${name}`)
  }
  // 命令注册必须按需解析：服务缺失时降级跳过，而不是拖垮整个插件激活
  assert.ok(entry.includes("ctx.inject(['commands']"), '命令面应通过 ctx.inject 按需解析 commands 服务')
  assert.ok(
    !entry.includes('ctx.command('),
    '不应保留 cordis 旧式 ctx.command 调用（DSH 无此面，留着只是死分支）',
  )
})
