// 夹具：箭头监听器用表达式体调用一个收对象字面量的函数，函数体外的 next() 是透传。
// 2026-11-06 实测：旧实现把对象字面量的 `{` 当成函数体起点，于是函数体外的
// next() 被读成「函数体内没有 next」，把合法透传报成断链（dsh-ops 假阳性）。
function refusal(opts) {
  return { ok: false, ...opts }
}

export const name = 'fixture'
export const inject = []

export function apply(ctx) {
  ctx.on('tools/pre-execute', (exec, next) => refusal({ exec }) ?? next())
}
