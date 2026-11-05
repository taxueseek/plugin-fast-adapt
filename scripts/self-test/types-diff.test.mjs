// types-diff.test.mjs —— 宿主类型差分与自动接缝引擎（方案 C）自检用例。

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test, tmpPluginDir } from './harness.mjs'
import {
  extractSymbolsFromDts,
  extractPackageSignature,
  diffTypeSignatures,
  synthesizeGuidesFromDiff,
  saveCachedSignature,
  loadCachedSignature,
} from '../lib/types-diff.mjs'

test('extractSymbolsFromDts：从类型声明中提取导出符号，注释不误报', () => {
  const dts = [
    '// export declare function fakeInComment(): void',
    'export declare function installBundle(spec: string): Promise<void>;',
    'export declare class HostContext {',
    '  readonly id: string;',
    '}',
    'export interface PluginConfig {',
    '  enabled: boolean;',
    '}',
    'export type SessionId = string;',
    'export const DEFAULT_TIMEOUT = 5000;',
    'export { helperA, helperB as renamedB };',
  ].join('\n')

  const symbols = extractSymbolsFromDts(dts)
  const names = symbols.map((s) => s.name)

  assert.ok(!names.includes('fakeInComment'), '注释里的 export 不应计入')
  assert.ok(names.includes('installBundle'), '应提取函数 installBundle')
  assert.ok(names.includes('HostContext'), '应提取类 HostContext')
  assert.ok(names.includes('PluginConfig'), '应提取接口 PluginConfig')
  assert.ok(names.includes('SessionId'), '应提取类型别名 SessionId')
  assert.ok(names.includes('DEFAULT_TIMEOUT'), '应提取常量 DEFAULT_TIMEOUT')
  assert.ok(names.includes('helperA'), '应提取导出 helperA')
  assert.ok(names.includes('renamedB'), '应提取重命名导出 renamedB')
})

test('extractPackageSignature：正确提取 package.json 子路径与类型入口', () => {
  const dir = tmpPluginDir('pkg-sig')
  try {
    const pkg = {
      name: '@deepseek-ai/dsh-test-suite',
      version: '1.2.0',
      exports: {
        '.': './lib/index.js',
        './client': './lib/client.js',
        './settings': './lib/settings.js',
      },
      types: 'lib/index.d.ts',
    }
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2))
    fs.writeFileSync(path.join(dir, 'lib', 'index.d.ts'), 'export declare function start(): void;\n')

    const sig = extractPackageSignature(dir)
    assert.strictEqual(sig.package, '@deepseek-ai/dsh-test-suite')
    assert.strictEqual(sig.version, '1.2.0')
    assert.ok(sig.subpaths.includes('.'), '应包含根导出')
    assert.ok(sig.subpaths.includes('./client'), '应包含 client 子路径')
    assert.ok(sig.subpaths.includes('./settings'), '应包含 settings 子路径')
    assert.strictEqual(sig.symbols.length, 1)
    assert.strictEqual(sig.symbols[0].name, 'start')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('diffTypeSignatures：精准识别消失的包、子路径与符号（P0 破坏性变更）', () => {
  const baseSig = {
    version: '0.2.1',
    packages: {
      '@deepseek-ai/dsh-core': {
        package: '@deepseek-ai/dsh-core',
        subpaths: ['.', './client', './legacy-api'],
        symbols: [
          { name: 'activeSession', kind: 'const' },
          { name: 'startCore', kind: 'function' },
          { name: 'removedMethod', kind: 'function' },
        ],
      },
      '@deepseek-ai/dsh-deprecated-pkg': {
        package: '@deepseek-ai/dsh-deprecated-pkg',
        subpaths: ['.'],
        symbols: [{ name: 'oldHelper', kind: 'function' }],
      },
    },
  }

  const targetSig = {
    version: '0.2.2',
    packages: {
      '@deepseek-ai/dsh-core': {
        package: '@deepseek-ai/dsh-core',
        subpaths: ['.', './client'], // ./legacy-api 消失
        symbols: [
          { name: 'activeSession', kind: 'const' },
          { name: 'startCore', kind: 'function' },
          // removedMethod 消失
        ],
      },
      // @deepseek-ai/dsh-deprecated-pkg 整个包消失
    },
  }

  const diff = diffTypeSignatures(baseSig, targetSig)
  assert.strictEqual(diff.fromVersion, '0.2.1')
  assert.strictEqual(diff.toVersion, '0.2.2')
  assert.strictEqual(diff.breakingCount, 3, '应捕获 3 处 P0 破坏性变更')

  const types = diff.changes.map((c) => c.type)
  assert.ok(types.includes('REMOVED_PACKAGE'), '捕获已移除包')
  assert.ok(types.includes('REMOVED_SUBPATH'), '捕获已移除子路径')
  assert.ok(types.includes('REMOVED_SYMBOL'), '捕获已移除符号')

  const removedSym = diff.changes.find((c) => c.type === 'REMOVED_SYMBOL')
  assert.strictEqual(removedSym.symbol, 'removedMethod')
  assert.strictEqual(removedSym.package, '@deepseek-ai/dsh-core')
})

test('synthesizeGuidesFromDiff：差分自动转换为虚拟指南，零人工文档依赖', () => {
  const mockDiff = {
    fromVersion: '0.2.1',
    toVersion: '0.2.2',
    breakingCount: 1,
    changes: [
      {
        type: 'REMOVED_SYMBOL',
        package: '@deepseek-ai/dsh-core',
        symbol: 'legacyRun',
        kind: 'function',
        severity: 'high',
        priority: 'P0',
        description: '导出符号「legacyRun」已从包「@deepseek-ai/dsh-core」中移除。',
      },
    ],
  }

  const guides = synthesizeGuidesFromDiff(mockDiff)
  assert.strictEqual(guides.length, 1)
  const g = guides[0]
  assert.strictEqual(g.version, '0.2.2')
  assert.strictEqual(g.virtual, true)
  assert.strictEqual(g.source, 'types-diff')
  assert.ok(g.anchors.packages.includes('@deepseek-ai/dsh-core'))
  assert.ok(g.anchors.members.includes('legacyRun'))
})

test('签名本地缓存存取闭环', () => {
  const version = '99.9.9-test-sig'
  const mockSig = { version, timestamp: 1234567, packages: {} }
  try {
    saveCachedSignature(version, mockSig)
    const loaded = loadCachedSignature(version)
    assert.deepStrictEqual(loaded, mockSig, '缓存读取与写入应严格一致')
  } finally {
    const p = path.join(process.env.HOME || '', '.cache', 'dsh-plugin-fast-adapt', 'signatures', `${version}.json`)
    try { fs.rmSync(p, { force: true }) } catch {}
  }
})
