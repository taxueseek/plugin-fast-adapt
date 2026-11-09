// 夹具：正则字面量里的引号让 maskSource 把后续真实代码吞成字符串。
//
// 2026-11-09 场测实录：本机 45 个真实插件、1278 个文件跑三条新规则（lifecycle /
// vendor-rescope / waterfall），第三方插件零命中，但本工具自扫报出两处
// lifecycle-unpaired-resource 误报——位置在 standards.mjs 自己的检测器源码里。
//
// 根因：maskSource 不认正则字面量。检测器源码里有
//   const procOnRe = /\bprocess\s*\.\s*(?:on|addListener)\s*\(/g
// 正则里的 `'` `"` 被当成字符串边界，状态机从正则起就跟丢，把后面三行
// （含真实的 process.on(...) 与 setInterval(...) 调用）整段标成 STRING，
// 检测器读到这些位置时 mask=0（CODE），于是把「注释里说明检测器长什么样」的
// 字面量当成了真实调用。
//
// 修法：maskSource 增加正则字面量识别——`/` 前一个非空白字符属于「期待表达式」
// 上下文（= ( [ , ! & | ? { } ; : + - * % ^ ~ < > 或行首）时，整段标 CODE，
// 正则内的引号不参与字符串边界判定。
export const name = 'fixture'
export const inject = []

const procOnRe = /\bprocess\s*\.\s*(?:on|addListener)\s*\(/g
const timerRe = /(?:^|[^\w$])setInterval\s*\(/g

export function apply() {
  // 这里真的调用了 process.on 与 setInterval——它们应该被检出不配对。
  // 夹具的 expected 只断言「正则字面量行不报」，真实调用行该报。
  process.on('exit', () => {})
  setInterval(() => {}, 1000)
  return procOnRe.source + timerRe.source
}
