// 夹具：缓存目录被软链到别处（省盘空间的常见做法）时，「清缓存」绝不能跟进去删目标。
// rmSync(link, { recursive: true }) 在 POSIX 上会穿过链接删掉目标内容——
// 纯数据丢失，且发生在「清缓存」这种心理上安全的动作里。
// 判据来自上游常设规则「用 unlink 删除链接形态的路径」
// （docs/defensive-patterns/general.zh.md）。
export const name = 'fixture'
export const inject = []

export function apply() {
  return 'ok'
}
