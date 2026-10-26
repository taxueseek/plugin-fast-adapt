// 自检共用骨架：用例登记、临时目录、运行与汇总。
//
// 章节按节拆到本目录下的 *.test.mjs，scripts/self-test.mjs 只负责 import 各节
// 并执行——单文件有 2200 行体积门禁，拆节是门禁触线时的规定动作，别让单文件
// 无界生长。新增用例一律写进对应小节文件，不要塞回 self-test.mjs。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const tests = []

export function test(name, fn) {
  tests.push({ name, fn })
}

export function tmpPluginDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fast-adapt-${name}-`))
}

// 脚手架用例的临时产物用完即删（os.tmpdir 只存可再生文件，不留唯一副本）
export const tmpDirs = []

export function trackTmpDir(dir) {
  tmpDirs.push(dir)
}

export async function runTests() {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  let passed = 0
  const failures = []

  for (const { name, fn } of tests) {
    try {
      await fn()
      passed++
      process.stderr.write(`  ok  ${name}\n`)
    } catch (err) {
      failures.push({ name, err })
      process.stderr.write(`FAIL  ${name}\n      ${err.message}\n`)
    }
  }

  process.stderr.write(`\n${passed} 项通过，${failures.length} 项失败\n`)
  if (failures.length) process.exit(1)
  process.stderr.write('[PASS] plugin-fast-adapt 自检全部通过\n')
}
