// 夹具：宿主子进程凭证擦除留下的残缺 git 配置组。
// 宿主按凭证安全要求摘掉 GIT_CONFIG_KEY_n，却留下 GIT_CONFIG_COUNT 与
// GIT_CONFIG_VALUE_n。git 读到「计数说有 N 组、键却不见了」直接 fatal：
//   error: missing config key GIT_CONFIG_KEY_0
//   fatal: unable to parse command-line config
// 2026-11-05 在本机 DSH 会话内实测：本工具每一条 git 调用都因此挂掉，
// 且全都表现为「没结果」而不是「报错」——env-doctor 静默吃异常返回 null、
// guide-sync 的 fetch/clone/reset 全挂、自检 2 项假失败。
// 负责的位置在「谁起子进程谁净化」：组齐全时一个字节不动，组残缺时摘净整组。
export const name = 'fixture'
export const inject = []

export function apply() {
  return 'ok'
}
