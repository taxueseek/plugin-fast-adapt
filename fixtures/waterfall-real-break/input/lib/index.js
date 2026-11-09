// 夹具：真的断链——监听了 waterfall 事件，收了 next 却从不调用。
// 与 waterfall-far-next 成对：一个该报，一个不该报，两条一起守住判据的两侧。
export const name = 'fixture'
export const inject = []

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (args, next) => {
    // 这里故意不调 next()：流水线会在这里静默停住
    return { handled: true }
  })
}
