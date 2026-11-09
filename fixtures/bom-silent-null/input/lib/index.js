// 夹具：package.json 带 UTF-8 BOM。JSON.parse 不认 BOM，异常被吞成 null 后
// 级联成「找不到宿主」这种完全不指向根因的症状（上游 #12322 的真实形态）。
export const name = 'fixture'
export const inject = []

export function apply() {
  return 'ok'
}
