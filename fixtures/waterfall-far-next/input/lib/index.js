// 夹具：next() 写在监听器函数体的第 3300 个字符处，是合法透传。
// 2026-11-06 实测：旧实现只看监听器后 800 字符，把这种合法透传报成断链。
export const name = 'fixture'
export const inject = []

const pad = (n) => '  const v' + n + ' = ' + n + ';\n'

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (args, next) => {
    // 用一段与业务无关的长函数体把 next() 推到 800 字符窗口之外
    let out = 0
    // eslint-disable-next-line no-unused-vars
    const body = [
${Array.from({ length: 40 }, (_, i) => pad(i)).join('')}
    ]
    for (const line of body) out += line.length
    if (out < 0) return null
    return next()
  })
}
