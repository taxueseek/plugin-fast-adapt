// lib/run-states.mjs —— run.mjs 流水线状态词的单一真源。
//
// 为什么需要它：run.mjs 的每个阶段都写 `status: 'ok' | 'skipped' | 'fail' | 'error'`，
// 24 处字面量散在一个文件里，runlog.mjs 的 phasesOf 又要按另一套派生逻辑读它们
// （`record.typecheck.status ?? (record.typecheck.skipped ? 'skipped' : null)`）。
// 后果不是「不好看」，而是**改一个状态名要改 N 处**：给某个阶段加一个终态，
// 要同时改 run.mjs 的写入点、runlog.mjs 的派生、run-log.mjs 的展示——漏一处
// 就是一个静默失配的状态（消费方读到 null，报告看起来和正常的一样）。
//
// 设计原则（对齐 argo 的 engine_states.py）：
//   - 每个状态**只有一个名字**，写入点从这里取，不手写写字面量。
//   - 按**阶段**组织：一个阶段的全部状态与转换条件放在一起，读一遍就能理解它的生命周期。
//   - 只定义词表与纯判定函数（is_xxx），不碰 IO、不碰持久化。
//
// 覆盖的阶段：
//   1. 通用阶段态（env / version / guides / typesDiff / scan / audit）
//      ok / skipped / error
//   2. typecheck：ok / skipped / fail（工具链缺失是 skipped 不是 fail）
//   3. smoke：ok / skipped / fail / error（未构建拦截是 error，与冒烟执行失败同态）
//   4. realSmoke：ok / skipped / fail / inconclusive（不定论是独立终态，不是 fail）
//   5. 运行摘要 phases：scan / smoke / typecheck / realSmoke 的四态投影（含 null）

/** 通用阶段状态。 */
export const STAGE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  ERROR: 'error',
})

/** typecheck 阶段状态。 */
export const TYPECHECK_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
})

/** 冒烟阶段状态。 */
export const SMOKE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
  ERROR: 'error',
})

/** 真冷启动状态。inconclusive 是独立终态：不定论不等于失败。 */
export const REAL_SMOKE_STATUS = Object.freeze({
  OK: 'ok',
  SKIPPED: 'skipped',
  FAIL: 'fail',
  INCONCLUSIVE: 'inconclusive',
})

/** 所有合法的状态值并集。自检用它做「字面量 == 词表」的对账。 */
export const ALL_STATUSES = Object.freeze([
  ...new Set([
    ...Object.values(STAGE_STATUS),
    ...Object.values(TYPECHECK_STATUS),
    ...Object.values(SMOKE_STATUS),
    ...Object.values(REAL_SMOKE_STATUS),
  ]),
])

/**
 * 阶段状态是否算「失败」（影响退出码 2）。
 * @param {string} status
 * @returns {boolean}
 */
export function isFailureStatus(status) {
  return status === STAGE_STATUS.ERROR || status === TYPECHECK_STATUS.FAIL || status === SMOKE_STATUS.FAIL || status === SMOKE_STATUS.ERROR
}

/**
 * 阶段状态是否算「未知」（--strict 下按失败处理）。
 * skipped 是未知：没验成与验干净是两回事。
 * @param {string} status
 * @returns {boolean}
 */
export function isUnknownStatus(status) {
  return status === STAGE_STATUS.SKIPPED
}

/**
 * 运行摘要 phases 的四态投影。
 *
 * 消费方（run-log.mjs list / doctor）按这份摘要判断「扫描没跑」与「扫描满分」，
 * 所以派生逻辑只有一份。record 的形状是 run.mjs 的 report。
 * @param {object} record 运行记录
 * @returns {{ scan: string|null, smoke: string|null, typecheck: string|null, realSmoke: string|null }}
 */
export function phasesOf(record) {
  return {
    scan: record.scan?.error ? STAGE_STATUS.ERROR : record.scan?.skipped ? STAGE_STATUS.SKIPPED : record.scan ? STAGE_STATUS.OK : null,
    smoke: record.smoke == null ? null : record.smoke.skipped ? STAGE_STATUS.SKIPPED : record.smoke.success ? SMOKE_STATUS.OK : SMOKE_STATUS.FAIL,
    // --no-typecheck 产生的 { skipped: true } 没有 status 字段，也要归入 skipped
    typecheck: record.typecheck == null ? null : record.typecheck.status ?? (record.typecheck.skipped ? TYPECHECK_STATUS.SKIPPED : null),
    realSmoke: record.realSmoke == null ? null : record.realSmoke.skipped ? REAL_SMOKE_STATUS.SKIPPED : (record.realSmoke.status ?? null),
  }
}
