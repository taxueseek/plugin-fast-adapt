// 夹具：常量查表容器曾被泛化判据报成「共享状态无所有者」。
// 2026-11-05 实测：泛化版在 dsh-llm-fallbacks 上 10 命中、dsh-image-gen 上 35 命中，
// 逐条核对全是常量表与编译后产物。收窄后这类只读查表必须零命中。
export const name = 'fixture'
export const inject = []

const FALLBACK_TABLE = new Set(['a', 'b', 'c'])
const ERROR_CODE_MAP = new Map([
  ['E1', 'one'],
  ['E2', 'two'],
])

export const Config = {}

export function apply() {
  return FALLBACK_TABLE.size + ERROR_CODE_MAP.size
}
