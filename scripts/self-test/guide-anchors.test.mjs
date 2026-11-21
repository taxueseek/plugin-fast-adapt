// guide-anchors.test.mjs —— 锚点抽取降噪判据的回归用例（2026-11-21 误报收口）。
// 判据真源在 lib/guide-parser.mjs：成员/裸调用锚点只从 Change 段的非延续子句抽、
// 替换对旧符号补锚（含 or 同伴与 instead of 方向）、包路径尾点半角点剥离。
// 全部零网络、零外部依赖。

import assert from 'node:assert/strict'
import { test } from './harness.mjs'
import { extractAnchors } from '../lib/guide-parser.mjs'

test('延续句里的符号不进待报锚点，转折子句的破坏面保留（2026-11-21 dsh-suggestion-chips 实录回归）', () => {
  // session-status-package 真指南句式：getSnapshot()/subscribe()「keeps its form」
  // 是延续表述，旧 blob 全量抽取把它们变成待报锚点，插件里本地 store 的同名
  // subscribe 与 composer shell 的 getSnapshot 全被报成 high（9/9 全误报）。
  const a = extractAnchors(
    "Reading it through `ctx.uiSession.sessionStatus.getSnapshot()` and `subscribe()` keeps its form, but a plugin that reads it without injecting `'uiSession.sessionStatus'` fails with an error.",
    "1. Each plugin that reads `ctx.uiSession.sessionStatus` adds `'uiSession.sessionStatus'` to `inject`."
  )
  assert.ok(!a.members.includes('getSnapshot'), `getSnapshot 是延续符号不该进待报锚点: ${JSON.stringify(a.members)}`)
  assert.ok(!a.members.includes('subscribe'), `subscribe 是延续符号不该进待报锚点: ${JSON.stringify(a.members)}`)
  // 转折子句（, but … fails）里的破坏面符号不能跟着延续句一起丢——整句一刀切就是丢召回
  assert.ok(a.members.includes('uiSession.sessionStatus'), `转折子句的破坏面应保留: ${JSON.stringify(a.members)}`)
})

test('Migration 里的迁移目标不进成员锚点（2026-11-21 dsh-suggestion-chips/dsh-files 实录回归）', () => {
  // ctx.slots.inject / ctx.sessions.create / ctx.emit 全是 Migration 段的「新写法」，
  // 旧 blob 全量抽取把它们抽成待报锚点，直接打脸「迁移目标不报」承诺
  const a = extractAnchors(
    'Store-owned instances reject writes before creation announcement completes.',
    '1. Use `ctx.sessions.create()` for a writable Session owned by the calling fiber.'
  )
  assert.ok(!a.members.includes('ctx.sessions.create'), `迁移目标不该进待报锚点: ${JSON.stringify(a.members)}`)
})

test('替换对旧符号补锚：Replace A or B with C 的 or 同伴都是旧符号', () => {
  // Change 段只写「旧行为变了」不点名时，破坏面只出现在 Migration 的替换对里，
  // Change-only 抽取会漏掉旧符号——由替换对补锚兜住召回。
  const a = extractAnchors(
    'Legacy helpers stop working.',
    '1. Replace helperOne() or helperTwo() with helperThree().'
  )
  assert.ok(a.members.includes('helperOne'), `or 前的旧符号应补锚: ${JSON.stringify(a.members)}`)
  assert.ok(a.members.includes('helperTwo'), `or 同伴旧符号应补锚: ${JSON.stringify(a.members)}`)
  assert.ok(!a.members.includes('helperThree'), '迁移目标不该进待报锚点')
})

test('「X instead of Y」方向判定：Y 是旧符号进待报锚点，X 是新写法进 introduced', () => {
  const a = extractAnchors(
    'The open path breaks.',
    '1. Call ctx.sessions.create() instead of ctx.sessions.open().'
  )
  assert.ok(a.members.includes('ctx.sessions.open'), `旧符号应进待报锚点: ${JSON.stringify(a.members)}`)
  assert.ok(!a.members.includes('ctx.sessions.create'), `新写法不该进待报锚点: ${JSON.stringify(a.members)}`)
  assert.ok(a.introduced.includes('ctx.sessions.create'), `新写法应进 introduced: ${JSON.stringify(a.introduced)}`)
})

test('包路径尾点半角点剥离（2026-11-21 实测漏报回归）', () => {
  // 子路径段 [\w.-]* 会把句号吃进捕获，带点形式去比插件 import 必然落空 → 漏报
  const a = extractAnchors(
    'The `@deepseek-ai/dsh-legacy/commands.` subpath export is removed.',
    ''
  )
  assert.ok(a.packages.includes('@deepseek-ai/dsh-legacy/commands'), `尾点应剥离: ${JSON.stringify(a.packages)}`)
  assert.ok(!a.packages.includes('@deepseek-ai/dsh-legacy/commands.'), '带点形式不该进锚点')
})

test('延续句里的常量不进 code 锚点（2026-11-21 dsh-files ATTACHMENT_* 回归）', () => {
  const a = extractAnchors('Every `ATTACHMENT_LEGACY` code is unchanged.', '')
  assert.ok(!a.codes.includes('ATTACHMENT_LEGACY'), `延续句里的码不该进锚点: ${JSON.stringify(a.codes)}`)
})
