// lib/proc-env.mjs —— 起子进程时的环境净化，与删除路径时的链接安全。
//
// 两件事放一处，是因为它们同属一类：本工具是「只读为主 + 偶尔自愈」的诊断器，它的
// 危险动作只有两类——把环境交给子进程、把路径交给删除原语。两条都由宿主常设规则
// 约束（docs/defensive-patterns/general.zh.md），都只有几十行，不值得各开一个模块。
//
// 为什么需要它（2026-11-05 在本机 DSH 会话内实测）：
// 宿主给子进程做凭证擦除时，会摘掉 GIT_CONFIG_KEY_n，却留下 GIT_CONFIG_COUNT
// 和 GIT_CONFIG_VALUE_n。git 读到「计数说有 N 组命令行配置、键却不见了」就直接
// 死：
//     error: missing config key GIT_CONFIG_KEY_0
//     fatal: unable to parse command-line config
// 于是本工具里每一处 git 调用都失败——env-doctor 的 gitCheckoutInfo 静默吃异常
// 返回 null（幽灵宿主判定退化成「磁盘时间来源不明」），guide-sync 的 fetch/clone
// 全挂，release-check 的版本一致性检查全挂。本工具自身的自检也因此在宿主会话里
// 由 214 项通过退化成 212 项通过 2 项失败（失败的两项各自跑 git init）。
//
// 这不是本工具的 bug，也不是宿主的 bug：宿主按凭证安全要求摘键是对的，git 对残缺
// 配置组直接 fatal 是它的契约，两边都合理，中间没有人为环境残缺负责。所以负责的
// 位置在「谁起子进程谁净化」——即本工具在这一层收口。
//
// 判据（不是猜）：git 只在「声明了 GIT_CONFIG_COUNT 但任一 KEY_i 缺失」时报这句。
// 全组齐全（GIT_CONFIG_KEY_0 与 GIT_CONFIG_VALUE_0 都在）时是合法用法，不能动。
// 因此净化规则是外科式的：
//   - 组齐全 → 原样返回，一个字节不改；
//   - 组残缺 → 摘掉整组（COUNT / PARAMETERS / KEY_n / VALUE_n），并显式落
//     GIT_CONFIG_COUNT=0 表达「零组命令行配置」，避免子进程再继承一个坏计数。
// GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM 是另外三个单键，
// 不属这一组，一律不碰。

import fs from 'node:fs'

/** git 索引式命令行配置的完整名字面量。 */
const INDEXED_CONFIG_NAME = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/u

/**
 * 判定环境里的 git 索引式命令行配置组是否残缺。
 * @param {NodeJS.ProcessEnv} env 待判定的环境对象
 * @returns {{ broken: boolean, count: number|null, missingKeys: string[] }} 判定结果与证据
 */
export function diagnoseGitConfigGroup(env = process.env) {
  const raw = env.GIT_CONFIG_COUNT
  if (raw === undefined) return { broken: false, count: null, missingKeys: [] }
  const count = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(count) || count < 0) {
    // 计数本身就不是个合法数字，git 一样会炸；按残缺处理
    return { broken: true, count: null, missingKeys: [] }
  }
  const missingKeys = []
  for (let i = 0; i < count; i += 1) {
    if (env[`GIT_CONFIG_KEY_${i}`] === undefined) missingKeys.push(`GIT_CONFIG_KEY_${i}`)
  }
  return { broken: missingKeys.length > 0, count, missingKeys }
}

/**
 * 返回一个可安全交给 git 子进程的环境对象。
 *
 * 组齐全时返回原对象本身（不复制、不改动，调用方拿到的就是 process.env）；
 * 组残缺时返回去掉整组、并把 GIT_CONFIG_COUNT 落成 '0' 的副本。
 * @param {NodeJS.ProcessEnv} [env] 基准环境，默认 process.env
 * @returns {{ env: NodeJS.ProcessEnv, repaired: boolean, missingKeys: string[] }} 净化结果
 */
export function gitChildEnv(env = process.env) {
  const diagnosis = diagnoseGitConfigGroup(env)
  if (!diagnosis.broken) return { env, repaired: false, missingKeys: [] }

  const cleaned = {}
  for (const [key, value] of Object.entries(env)) {
    if (INDEXED_CONFIG_NAME.test(key)) continue
    cleaned[key] = value
  }
  cleaned.GIT_CONFIG_COUNT = '0'
  return { env: cleaned, repaired: true, missingKeys: diagnosis.missingKeys }
}

/**
 * 返回一份去掉了残缺索引式配置组的环境副本（组健康时原样返回同一个对象）。
 *
 * 供需要自己拼 env 再交给子进程的调用方使用：`env: cleanGitEnv({ ...process.env, X: '1' })`。
 * @param {NodeJS.ProcessEnv} [env] 基准环境，默认 process.env
 * @returns {NodeJS.ProcessEnv} 可直接交给子进程的环境
 */
export function cleanGitEnv(env = process.env) {
  return gitChildEnv(env).env
}

/**
 * 删除一个「可能是软链 / junction」的路径，绝不跟随链接进入其目标。
 *
 * 判据来自宿主常设规则「用 unlink 删除链接形态的路径」
 * （docs/defensive-patterns/general.zh.md）：`rmSync(link, { recursive: true })`
 * 在 Windows 上对 junction 抛 ERR_FS_EISDIR，在 POSIX 上则穿过链接把目标内容删掉
 * ——后者是纯数据丢失，而在「用户把缓存目录软链到别处」时是最真实的形态。
 * 所以先 lstat 判定：链接用 unlink（只删链接本身、拒绝真实目录），真实目录才递归删。
 * @param {string} target 待删路径
 * @returns {{ removed: boolean, kind: 'symlink'|'dir'|'file'|'absent', error?: string }} 实际发生了什么
 */
export function removeDirSafely(target) {
  let stat
  try {
    stat = fs.lstatSync(target)
  } catch (err) {
    if (err?.code === 'ENOENT') return { removed: false, kind: 'absent' }
    return { removed: false, kind: 'absent', error: err?.message || String(err) }
  }
  const kind = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'dir' : 'file'
  try {
    if (kind === 'dir') {
      fs.rmSync(target, { recursive: true, force: true })
    } else {
      // unlink 只删链接/文件本身，且对真实目录会拒绝——这正是我们要的失败方向
      fs.unlinkSync(target)
    }
    return { removed: true, kind }
  } catch (err) {
    return { removed: false, kind, error: err?.message || String(err) }
  }
}

