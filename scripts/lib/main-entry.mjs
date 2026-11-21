// lib/main-entry.mjs —— 软链安全的「是否作为主入口运行」判定。
//
// 为什么存在（2026-11-21 实测）：技能目录对外是软链（~/.agents/skills/* 与
// ~/.zcode/skills/* 都指向仓库真源），Node ESM 默认解析软链——import.meta.url
// 是真实路径；用户按 SKILL.md 的用法 `node <技能根>/scripts/<脚本>.mjs` 直跑时
// argv[1] 是软链路径，直接与 import.meta.url 比较永不相等：模块正常加载、
// main 守卫判 false、静默 no-op exit 0（fleet-sweep 经软链调用零输出零报错）。
// 两侧都过 realpathSync 才是同一判定；realpath 失败（竞态删除等）按
// 「不是主入口」处理，宁可少跑不误跑。
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMainEntry(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}
