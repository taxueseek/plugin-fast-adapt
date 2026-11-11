# plugin-fast-adapt

[English](README.md) | [简体中文](README.zh-CN.md) | 日本語

[![CI](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml/badge.svg)](https://github.com/taxueseek/plugin-fast-adapt/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-%3E%3D22.13-blue.svg)](package.json) [![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg)](#依存関係とセルフテスト) [![Self-test](https://img.shields.io/badge/self--test-270%20passing-brightgreen.svg)](#依存関係とセルフテスト)

> **DSH は新しいバージョンをリリースするたびに、既存のプラグインが起動できなくなることがあります。** このスキルはベンダー公式のアップグレードガイドを直接読み込み、プラグインのコードを走査して、どの破壊的変更に踏み込んだかと、ベンダー自身の修正手順を報告します。さらに、コマンド 1 つで動作するプラグインをゼロから生成して検証することもできます。**0.2.2-rc.1 まで対応、0.2.2-rc.2 で実機検証済み**: rc.1 にはまだ公式ガイド項目がないため、公式 Release Note を仮想ガイドとして取り込み、カバレッジは `complete=true` と判定されます。テスト時点で公式 npm チャネルのすべてより先行していた rc.2 ホストでも実機検証を行い、バージョン解決は正直に `ahead-of-upstream`（対応不要）と判定し、391 個のコアパッケージのエクスポート面差分は削除ゼロでした。ガイドもリリースノートも存在しないさらに新しいバージョンについては、台帳が「クリーンとは言い切れない」とはっきり告げます。ローカル環境への権威アンカー、Release Note からの破壊的変更抽出、フリート全体の多次元一括管理にも対応しています。

## 概要一目

| | |
| --- | --- |
| 上流が新バージョンをリリース | 変更不要ですぐ使える（ベンダーのソースとリリースノートを直接読む。手作りカードは不要） |
| DSH ホスト対応 | v0.1.7-rc.2 から **0.2.2-rc.1** まで（rc.1 は公式 Release Note を仮想ガイドに変換して補完）。ホスト **0.2.2-rc.2** は全公式チャネルより先行した状態で実機検証済み（391 パッケージのエクスポート面差分：削除ゼロ）。公式ソースが何もないさらに新しいバージョンでは、カバレッジ台帳が「クリーンとは言い切れない」と明示 |
| フリート管理ボード | Web / APP インストール済みプラグインとワークスペースのコードをワンクリック走査し、実行状態のライフサイクル行列で表示 |
| バージョンの権威 | デフォルトではローカルに実装されたホストバージョンに厳格にアンカー（プラン B：ネットワーク要求ゼロ） |
| 走査の誤検知 | 12 件 → 0（四層ノイズ低減 + 定数の語境界正規表現 + 仮想ガイド重複排除） |
| 変更 1 件の検証 | 3,600 秒の実ホストコールドスタート → ミリ秒級のインメモリスモークテスト（未ビルド成果物のハード遮断とホストモジュールのフォールバック付き） |
| ゴーストホスト | ディスクは新コードなのに実行中プロセスが旧コードを動かしているときに警告（バージョン文字列ではなくプロセス起動時刻を比較） |
| 偽グリーン検出 | `tsconfig` の `paths` が存在しない checkout を指しているときに警告（ローカルゲートが全緑でも実際には壊れている状態） |
| セルフテスト | 270 個のアサーション、オフラインで実行可能 |
| 外部依存 | 0（Node 組み込みモジュール + `git`/`npm` コマンドのみ） |
| クロスプラットフォーム | macOS、Linux 標準パス、Termux モバイル、コンテナ環境をネイティブサポート（XDG 準拠） |
| プラグイン生成 | コマンド 1 つで 5 形態の実行可能プラグインを生成し、生成時点で検証 |

## どんな問題を解くのか

DSH（DeepSeek Harness）は「すべての機能がプラグインとして存在する」AI ランタイムフレームワークです。困りごとは、新しいバージョンがリリースされるたびに既存プラグインが起動できなくなりうることです。定番の対策は手書きのアップグレードカードで、バージョン区間ごとに数十枚のカードを書き、何が壊れてどう直すかを記録します。この道には避けられない問題が 3 つあります。

1. **カードは書き終えた瞬間に古くなる**。上流の 1 回のジャンプで数千ファイルが変わることがあり、カードの間には未カバーの「コリドーギャップ」が残ります。
2. **大きな知識ベースは推論の余地を圧迫する**。論文の実測では、弱いモデル（qwen3.8-27b）がカードライブラリ一式を読み込んだ状態で回答すると、56 問の等権重差で -3.07 pp（7 問改善、18 問退化、31 問横ばい）でした。
3. **検証が高価**。変更のたびに実ホストのコールドスタート待ちが必要で（3,600 秒のタイムアウト実績あり）、ホスト更新後に profiles オーバーレイに残った旧パッケージがプラグインのロード競合を起こすこともあります。

本プロジェクトの選択は**知識を保守せず、知識の取り方を保守する**ことです。破壊的変更の権威ある記述はベンダーリポジトリの `docs/upgrade-guide/<version>/<topic>/guide.md` にあり、リリースごとに固定フォーマット（`## Change` が変更内容、`## Migration` が修正方法）で更新されます。バージョン情報は npm registry の `dist-tags` にあります。どちらも公式ソースなので、上流がリリースした瞬間にこのスキルは自動的に追いつきます。

### 利点

- **0.2.2-rc.1 まで対応、0.2.2-rc.2 で実機検証済み**：公式 `docs/upgrade-guide/` と Release Notes を直読みします。公式ガイドは 0.2.2-alpha.3 までしか書かれていないため、0.2.2-rc.1 は公式 Release Note（2 万 7 千字超、破壊的変更セクション完備）を仮想ガイドに変換して補完し、カバレッジは完全カバーと判定されます。0.2.2-rc.2 ホストは全公式 npm チャネルより先行した状態で 2026-11-12 に実機検証済み——バージョン解決は正直に「ahead-of-upstream」と判定し、391 個のコアパッケージのエクスポート面差分は削除ゼロ。仮想ガイドの自動生成と、三元バージョン台帳による高速照会にも対応
- **ローカル環境の権威アンカー（ネットワーク依存ゼロ）**：デフォルトのバージョン解決はローカルに実装済みの DSH ホストバージョンに厳格に収束（プラン B、外部ネットワーク要求ゼロ）。公式ソースのネットワーク揺らぎと GitHub レート制限を回避。明示的に `--check-upstream` を付けたときだけ上流を確認
- **フリート全体の多次元管理ボード**：`fleet-sweep.mjs` がワークスペースのソースコード、インストール済み Web プラグイン、APP デスクトッププラグイン、実行中のプロセスを一括走査し、5 段階ライフサイクル行列ボードを出力。`--apply-compat` による一括安全パッチにも対応
- **誤検知と初歩的ミスへのハードガード**:
  - 四層ノイズ低減 + 正規表現の語境界（`ABORTED` が `FS_ABORTED` に誤一致しない）
  - 仮想 Release ガイドと公式ガイドの自動重複排除
  - 未ビルド TypeScript プラグインのハード遮断（`lib/index.js` などの入口が見えなければ阻止して `pnpm run build` を案内）
  - ホスト同名内蔵パッケージの遮蔽（Bundle Resolution Shadow）検出
  - ホストコールドスタート終了コード 143（`SIGTERM`）を正常なグレースフルシャットダウンと判定し、擬似死の誤報を排除
  - スモークテストが Schemastery `Config({})` を自動解析してデフォルト値を埋め、node_modules 未設置の単一ファイルプラグインにはホスト依存を一時フォールバックマウント
- **クロスプラットフォームとコンテナ対応**：絶対パスのハードコードを排除し、Linux 標準パス（`/usr/lib/node_modules`）、Termux（`$PREFIX/lib/node_modules`）、`npm_config_prefix` に対応。環境変数 `DSH_HOST_PATH` / `DSH_LOCATION` での直接上書きと、XDG キャッシュ仕様の厳格な遵守
- **検証が安い**：インメモリ Cordis スモークテストはミリ秒から秒で結果を出し、実ホストのコールドスタート不要。実際の証拠が必要なときは `--real-smoke` でクリーンな profile への実インストール・実起動を追加
- **外部依存ゼロ**：Node 組み込みモジュールと `git`/`npm` コマンドのみ。TypeScript も AST ライブラリも HTTP クライアントも不要
- **再現可能**：270 個のアサーションをオフラインで実行可能。CI は ubuntu / macOS / Windows の 3 プラットフォームで実行し、タグを打つとリリースプレフライトが走る
- **適応だけではない**：`scaffold.mjs` がコマンド 1 つで 5 形態の実行可能プラグインを生成（実基底クラスでのロード検証付き）、`write-gate.mjs` が完成時に「出生証明書」を発行
- **サイレント失敗にも判定基準あり**：`ghostHost` はプロセス起動時刻とディスク変更時刻を比較して「ディスクは新版、メモリは旧版」を捕捉。`falseGreen` は `tsconfig` の `paths` が存在しない checkout を指すときの TypeScript のサイレントフォールバックを捕捉。どちらも報告のみで判断を代行せず、証拠は出力に書かれる
- **限界への誠実さ**：スモークテストの合格 ≠ ホスト互換。この一文はツールの出力自体に書かれている

## 4 つのレーン

メインエントリはルーティングだけを受け持ちます。各レーンは 1 つの仕事だけを担当し、意図に応じた文書だけを読み込めば、4 枚すべてを読む必要はありません:

```
SKILL.md                      メインスキル：レーン判定 + ワンコマンドパイプライン + レーン横断の規律
sub-skills/adapt/SKILL.md     アップグレード適応：バージョン解決 → ガイド取得 → ヒット走査 → シーム → スモーク → 監査
sub-skills/build/SKILL.md     プラグイン作成：scaffold 5 形態 + write-gate 検査門
sub-skills/diagnose/SKILL.md  環境と起動障害：env-doctor + log-doctor + env-heal
sub-skills/review/SKILL.md    コードレビューとアーキテクチャ監査：P0/P1/P2/P3 分級 + サブエージェント分離委譲
scripts/                      4 レーン共用のツールボックス。レーンごとに分割しない
references/                   ノイズ低減ルール、移行 SOP、CI テンプレート
```

`build`、`diagnose`、`review` にはトップレベルの別名も用意されており、独立してトリガーできます（作らなくても動作します。メインスキルが意図に応じてレーン文書を読みます）:

```sh
ln -s <repo>/sub-skills/build    ~/.agents/skills/dsh-plugin-build
ln -s <repo>/sub-skills/diagnose ~/.agents/skills/dsh-plugin-diagnose
ln -s <repo>/sub-skills/review   ~/.agents/skills/dsh-plugin-review
```

別名の目的は、「プラグインを作る」「入れたのに効かない」「コードをレビューして」といった独立した目標に、それぞれ独自のトリガー面を与えることです。宿主ローダーは `description` に 1024 文字のハード上限があり、超過すると切り詰めではなくスキル全体が破棄されます——この上限はセルフテストのゲートが守っています。

## インストール

skills CLI（推奨。コマンド 1 つで対応する agent にインストール）:

```sh
npx skills add taxueseek/plugin-fast-adapt
```

Claude Code marketplace:

```sh
/plugin marketplace add taxueseek/plugin-fast-adapt
/plugin install plugin-fast-adapt
```

npm（`plugin-fast-adapt` コマンド付き。ワンコマンドパイプラインへ転送）:

```sh
npx plugin-fast-adapt <plugin-dir>
```

手動インストール:

```sh
git clone https://github.com/taxueseek/plugin-fast-adapt.git
# リポジトリのルート（SKILL.md のある場所）を skill ディレクトリとして agent に接続
# Cursor ユーザー: cp -r plugin-fast-adapt/* .cursor/skills/plugin-fast-adapt/
```

## パイプライン

### 1. 単体プラグインパイプライン（run.mjs）

コマンド 1 つで全チェーンを実行（推奨）。実行のたびにローカルログを書き、三元バージョン台帳を更新します:

```sh
node scripts/run.mjs <plugin-dir>        # 環境→バージョン→ガイド→走査→ビルド検証→監査→スモーク→typecheck
node scripts/run.mjs <plugin-dir> --check-upstream # 上流の公式 npm と最新タグを明示的に確認
node scripts/run.mjs <plugin-dir> --real-smoke   # もう 1 段：クリーンな profile で実インストール・実起動（元リポジトリの verify-runtime にブリッジ）
node scripts/run.mjs <plugin-dir> --offline      # 公式ソースの取得をスキップ（npm を読まず clone しない）。ローカルのみの全工程
node scripts/run.mjs <plugin-dir> --no-clone     # バージョンは解決するがガイドを取得しない（ローカル clone があるとき）
node scripts/run.mjs <plugin-dir> --strict       # 走査が走らなかった・ガイドが対象バージョンをカバーしていないときに終了コード 2（CI 用）
node scripts/run-log.mjs list           # 過去の実行を振り返る（ツールのバージョン@commit 付き）
node scripts/run-log.mjs doctor         # 実行ログ × ホスト起動ログの突き合わせ（プラグインがエラーのときはまずこれ）
node scripts/run-log.mjs sanitize --latest --out share.json   # 共有前にサニタイズ
npm run release-check                   # リリース前プレフライト：バージョン一致、タグ、npm 公開状態、パッケージ内容、セルフテスト
```

### 2. フリート管理ボード（fleet-sweep.mjs）

DSH ホストの更新時やマルチプラグインの大規模リポジトリ運用時に、全プラグインを一括走査して分類します:

```sh
node scripts/fleet-sweep.mjs                   # 全域ボード：実行中・ワークスペース・Web設置済み・APP設置済み・無効化
node scripts/fleet-sweep.mjs --running         # 実行中ホストがロードしているプラグインのみ
node scripts/fleet-sweep.mjs --workspace       # ワークスペースのソースプラグインのみ
node scripts/fleet-sweep.mjs --web             # Web プラットフォームのプラグインのみ
node scripts/fleet-sweep.mjs --app             # デスクトップ (APP) のプラグインのみ
node scripts/fleet-sweep.mjs --disabled        # disabled 扱い・未活性のプラグインとその理由
node scripts/fleet-sweep.mjs --target 0.2.2-rc.1 --apply-compat # 破壊ヒットゼロの package.json を一括修整
```

詳細な操作 SOP とマルチプラットフォームの実践ガイドは [references/user-guide.md](references/user-guide.md) を参照。

ステップごとの単発実行も可能です（6 ステップの背骨は不変。run.mjs は以下をつなぐだけ。任意ステップは必要に応じて）:

```sh
# 1. ローカル環境の把握：インストール済みバージョン、オーバーレイの残骸、
#    プラグイン一覧、活性化準備度。サイレント失敗の判定基準 2 件付き：
#    ghostHost（プロセスは旧コードを動かしていないか）、falseGreen（tsconfig paths の偽グリーン）
#    --brief でパッチ行の原文を省略（80.5KB → 4.5KB）。行単位で見るなら外す
node scripts/env-doctor.mjs <plugin-dir> --brief

# 2. 対象バージョンの決定：公式の最新は何か、このマシンは追うべきか
node scripts/guide-sync.mjs <local-version>

# 2b. 上流ウォッチ（cron / agent ポーリングに直結可能）：1=新バージョンあり（ガイドを先取り）、0=不要、2=判定不能
node scripts/guide-sync.mjs --check

# 3. 走査ウィンドウ終点の公式アップグレードガイドを取得（管理付きブランチスナップショット優先。
#    --target を空のまま公式最新に追随させないこと）
node scripts/guide-sync.mjs <local-version> --target <scan-target> --clone

# 4. プラグインがどの変更に踏み込んだかを調べる
node scripts/code-scan.mjs <plugin-dir> <upgrade-guide-dir> <local-version> <target-version>

# 4b. シーム照会：あるパッケージ / API シンボルについて公式ガイドとローカルホストの
#     二重ソース判定（「削除済み」と結論するのは両者が一致したときだけ）
node scripts/seams.mjs dsh-settings
```

オーバーレイに旧パッケージの残骸があれば先に自己修復（デフォルト dry-run）:

```sh
node scripts/env-heal.mjs           # 報告のみ
node scripts/env-heal.mjs --apply   # ~/.dsh/.trash/<日付>/ へ移動。削除はしない
```

任意の 2 ステップで「作りながら検証、更新ついでに監査」を補完します:

```sh
# 5. 修正後の即時検証：インメモリ Cordis スモークで、モジュールロード・apply 契約・
#    ツール登録を検証。未宣言 inject のホストサービスアクセスは
#    （実 Cordis と同じ形の契約エラーで）阻止される
node scripts/quick-smoke.mjs <plugin-dir>

# 6. 更新のついでに 4 次元監査：性能・回復力・コンテキスト予算・ライフサイクル
node scripts/plugin-audit.mjs <plugin-dir>
node scripts/plugin-audit.mjs <plugin-dir> --guide <guide-root> <local-version> <target-version>
node scripts/plugin-audit.mjs <plugin-dir> --guide <guide-root> <local-version> <target-version> --peer-patch  # 検証済み peer パッチを印字

# 7. ホスト起動失敗のワンコマンド診断：StartupError / ポート占有 / 未宣言 inject / クライアント入口の死リンク
node scripts/log-doctor.mjs --pattern '^startup-' --limit 5

# 8. スキル面を下流スキルディレクトリへ同期（--check はドリフト確認のみ）
node scripts/sync-skill.mjs --dest <downstream-skill-dir> --check
```

## 走査精度：誤検知 12 件から 0 へ

初期版の素朴な正規表現は、ある実在プラグインに 12 件のヒットを報告しました。1 件ずつ確認した結果、**12 件すべて誤検知**でした。現在のバージョンは四層のノイズ低減を適用し、同じプラグインのヒットは 0 です:

- スキャナはステートマシンでコメントと文字列をスキップするため、コメント内の同名語はヒットしない
- 完全なメンバーチェーンを優先し、`ctx.tools` のような汎用的すぎる親チェーンは捨てる
- 汎用語（`register`、`resolve`、`readFile`）と短い名前はアンカー表に入らない。「旧 → 新」の置換ペアを認識し、プラグインが新シンボルを既に使っていれば報告しない
- 定数アンカーは `Change` セクションからのみ抽出。マッチにはオブジェクト部分の相互後尾関係を要求するため、`engines.dsh` が `result.dsh` と衝突しない
- パッケージ名の意味ゲート：パッケージ名は削除・改名の動詞と同じ文で言及されたときだけアンカーになる。文脈的な言及（「The mode fields of X accept only …」はフィールド値の話）はカウントしない——dsh-files で報告された 3 件の critical はすべてこの種の誤検知で、ゲート追加後にゼロになった

各ヒットには `severity`（package=critical、member=high、code=medium。リストの前から修正）、`evidence`（ヒット行の原文。誤検知の確認にファイルを開く必要がない）、出所アンカー（`guideFile`/`guideLine`。公式ガイドの原文位置に直結）が付きます。ルールと実測の根拠は [references/heuristics.md](references/heuristics.md) を参照。走査ルートはソースルートの和集合（`src` と同階層の `client`/`web`/`ui`）で、`lib`/`dist` のビルド成果物は二重に走査しません。スモークテストはモックのフォールバックを開示します。出力の `mockFallbacks` リストは、プラグインが触れたのにモックが提供していない属性を列挙します——このリストが長いほど結果の信頼度は下がります。**スモーク合格 ≠ ホスト互換**。この一文はドキュメントだけでなく出力にも書かれます。スモークはさらに、未宣言 `inject` のホストサービスアクセスを `inject_contract` 段階で阻止し、ロード即クラッシュのコードを黙って通しません。実ホストの証拠が必要なときは `run.mjs --real-smoke` を使います。元リポジトリ plugin-upgrade の `verify-runtime.mjs` にブリッジし、クリーンな profile でインストール → 起動 → 4 分類の帰属判定を行います（スクリプトがローカルにない場合は誠実にスキップし、導入方法を案内）。

## ゼロからプラグインを作る

```sh
node scripts/scaffold.mjs <namespace>/<name> --form tool|hook|service|config|llm-adapter [--out <dir>] [--harness <version>]
```

コマンド 1 つで 5 形態の実行可能プラグインを生成します: package.json（ビルド不要の純 ESM 不変条件）、形態ごとの完全な入口実装、`cordis.patch.yml` のマウント行、衝突耐性ルールを全量導出した `dsh-plugin.naming.json` 命名投影（生成物は上流 validate-names の `--strict` 検証に合格）。対象ディレクトリが空でなければ拒否し、不正な coordinate は書き込み前に拒否します。

入口に含まれる能力は動く出発点の実装です（エコーツール、観察式フック、サンプルサービスメソッド、デフォルト値付き設定、OpenAI 互換アダプタ）。自分の能力に差し替えてください。完全な契約は引き続き [plugin-write](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-write) の 5 つの form reference が契約の真源です。

検証は 2 層で走り、欠けた層はその層として報告します: tool と hook は依存ゼロのインメモリスモーク。5 形態すべてが実基底クラスのロード検証を行い、ホストがインストール済みなら入口を実際の `@deepseek-ai/*` 基底クラスに対して import し、基底クラス API の使い方が正しいかを確認します（Service 継承と `super(ctx, name)`、Schema の実検証、LlmAdapter 継承とルート登録）。ホスト未設置のときは誠実にスキップし、合格を偽りません。能力を書き終えたら、コマンド 1 つで検査門を通します:

```sh
node scripts/write-gate.mjs <plugin-dir>   # 出生証明書：ハードゲートは自動判定、ソフト指標は透過
```

ハードゲートは 3 つだけ（入口成果物の存在、スモーク合格、公式ガイドへの critical ヒットゼロ）。落ちれば終了コード 1。監査スコア、high/medium ヒット、mockFallbacks、未マウントの事実はすべて discretion 区へ入って「人の判断」用と表示され、ツールが「合格」と代弁することはありません。ガイドの自動発見は guide-sync キャッシュを使い（ネットワークゼロ）、新プラグインの検査対象は全履歴コリドーです。scaffold 直後は `--skip-smoke` で重複スモークを省けます。

## 依存関係とセルフテスト

外部依存ゼロ。Node 組み込みモジュール（`node:fs`、`node:path`、`node:os`、`node:child_process`）と `git`・`npm` コマンドのみ。

TypeScript も AST ライブラリも HTTP クライアントも不要。Node 22.13+ で動作（`import.meta.dirname` は 20.11+、オプションの型剥離は 22.13+。型剥離はデフォルト無効）。

セルフテスト:

```sh
npm test   # node scripts/self-test.mjs、270 個のアサーション
```

開発者はコミット前ゲートの有効化を推奨（1 回だけ）: `git config core.hooksPath .githooks`——コミットのたびにセルフテストが走り、下流同期のし忘れはその瞬間に止められます。

カバー範囲: スキャナの誤検知なし（コメントと文字列内の同語はヒットしない）、取りこぼしなし、バージョン発見法、置換ペア認識、エンドツーエンドのヒット（公式ガイドのファイル＋行番号の出所アンカー付き）、シーム照会の二重ソース判定（一致して削除済み / ホストに残っていて不一致 / 記録なしは正直に報告）、実行ログ × ホストログの突き合わせ、--real-smoke ブリッジ（fail → 終了コード 2、次の一手を案内）、上流ウォッチの終了コード、同期コミットコマンドの提案（同期パスだけを add して混入を防ぐ）、SOP 参照の完全性、dist-tags キャッシュの 3 状態、スモーク検証（未宣言 inject 契約の阻止を含む）、4 次元監査（peer パッチを含む）、活性化診断、ゴーストホストの 4 状態（stale/ok/unknown/no-running-host）とディスク時刻の出所、tsconfig paths 偽グリーン（extends 継承、JSONC コメント、ワイルドカード接頭辞、非ホスト alias の降格）、プラグインスキャフォールド（5 形態の生成、命名投影の文法、スモーク閉環、マウント層の認識可能性、不正入力と非空ディレクトリの拒否）、作成検査門（ハードゲートの阻止、ソフト指標の越権判定なし、スキップの意味、scaffold との接続）、ログ診断、下流同期ドリフト検査＋実機ゼロドリフトゲート、キャッシュルート注入（セルフテストは実ユーザーキャッシュを書かない）、runlog 台帳ルートの一回限り移行（旧 `~/.cache` ルートを `~/.local/state` へ）、セルフテストのサイズゲート、走査性能回帰ゲート、事故フィクスチャの全量回帰（`fixtures/` と `references/incident-ledger.md` の双方向対帳。締めた判定基準の両側を固定）、状態語彙表の単一真源対帳（`lib/run-states.mjs`）、文書階層の対帳（過程報告はスキル面に入らない）。セルフテスト自体はネットワークゼロ・外部依存ゼロで、どのマシンでも動きます。

自分のプラグインリポジトリにコミット時ゲート（スモーク/typecheck のハード門＋監査のソフト門）を付けたい場合は [references/ci-snippet.md](references/ci-snippet.md) を参照。

## スクリプト

| スクリプト | 責務 |
| --- | --- |
| `scripts/cli.mjs` | npm 入口（`npx plugin-fast-adapt`）。run.mjs へ転送 |
| `scripts/run.mjs` | 全チェーンのワンコマンド編成（環境→バージョン→ガイド→走査→監査→スモーク→typecheck）。統一レポートとローカル実行ログを出力。`scan.coverage` はガイドがどの版までカバーしたかを記録し、`--strict` は走査の未知を失敗扱い。`--real-smoke` は元リポジトリの verify-runtime にブリッジして実コールドブート層を追加 |
| `scripts/run-log.mjs` | 実行ログの閲覧（list/show）、突き合わせ（doctor：実行ログ × ホスト起動ログ）、サニタイズ書き出し（sanitize） |
| `scripts/seams.mjs` | シーム照会：パッケージ名 / API シンボルの公式ガイドアンカー表とローカルホストの二重ソース判定 |
| `scripts/scaffold.mjs` | ゼロからプラグイン生成：コマンド 1 つで 5 形態の実行可能プラグインを出力（package.json 不変条件＋形態別の完全入口＋マウント層＋命名投影）。生成時点で検証 |
| `scripts/write-gate.mjs` | 完成プラグインの検査：スモーク＋活性化準備＋4 次元監査＋公式ガイド走査を編成して「出生証明書」を出す。ハードゲートは 3 つだけ自動判定し、ソフト指標は透過して決めない |
| `scripts/env-doctor.mjs` | ローカル DSH 環境の探査（バージョン、オーバーレイ、プラグイン、プロセス、活性化準備度、ゴーストホスト、tsconfig 偽グリーン） |
| `scripts/env-heal.mjs` | オーバーレイ旧パッケージの自己修復（デフォルト dry-run） |
| `scripts/guide-sync.mjs` | 対象バージョンの決定 + 公式アップグレードガイドの取得（デフォルトブランチの管理付きスナップショット、TTL 1 時間。タグはオフライン時のフォールバックで `frozen` 印付き） |
| `scripts/release-check.mjs` | リリース前プレフライト：バージョン一致、タグ、npm 公開状態、`npm pack` 内容、セルフテスト、ワークツリー。読み取り専用でタグも公開もしない |
| `scripts/code-scan.mjs` | プラグインコードを公式変更アンカーに対して走査 |
| `scripts/quick-smoke.mjs` | 修正後の即時検証（インメモリ Cordis スモーク、モックフォールバックの開示付き） |
| `scripts/plugin-audit.mjs` | 4 次元の性能・アーキテクチャ監査。公式ガイドとの交差チェック可能。`--peer-patch` は検証済み peer パッチを印字 |
| `scripts/standards-scan.mjs` | 上流の常設ルール検出（機械判定可能な 7 項目、defensive-patterns の出所付き）。`--rules` でルール表を出力 |
| `scripts/codemod.mjs` | 決定論的なコード・パッケージ面の自動修復（Loader 入口のエクスポート面、peer 依存、トップレベル await）。デフォルト dry-run、`--apply` で書き込み＋バックアップ |
| `scripts/types-diff.mjs` | ホスト .d.ts とエクスポート面の差分。基線バージョンごとに仮想ガイドを合成して書き出し |
| `scripts/fix-peer-deps.mjs` | ホストコアパッケージを dependencies から peerDependencies へ一括移動。デフォルト dry-run、`--apply` で書き込み＋バックアップ |
| `scripts/fleet-sweep.mjs` | フリート全体の一括管理と巡回。行列ボードと JSON レポートを出力。`--apply-compat` は台帳一括書き込みの前にバックアップ |
| `scripts/log-doctor.mjs` | `~/.dsh/logs/` のホスト障害をワンコマンド解析（startup ヘッダ / 失敗プラグイン / 待ちサービス / シグナル集計） |
| `scripts/sync-skill.mjs` | スキル面を下流スキルディレクトリへ同期。`--check` でドリフト確認 |
| `scripts/self-test.mjs` | セルフテスト |
| `scripts/lib/scanner.mjs` | 語彙スキャナ、バージョン比較と semver 範囲判定（依存ゼロ） |
| `scripts/lib/guide-parser.mjs` | 公式ガイドの解析とアンカー抽出（削除動詞の意味ゲート付き） |
| `scripts/lib/runlog.mjs` | 実行ログの書き込み、索引、サニタイズ |
| `scripts/lib/host-modules.mjs` | ローカルホストの `@deepseek-ai/*` 基底クラスモジュールを解決し、実基底クラスロード検証を行う |
| `scripts/lib/package-json.mjs` | `package.json` 読み取りの単一真源：UTF-8 BOM 剥離、寛容 / 厳格の 2 モード、missing/corrupt/ok の 3 状態 |
| `scripts/lib/cache-root.mjs` | キャッシュルートの単一真源（`DSH_PFA_CACHE_DIR` > `DSH_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`）。セルフテストで隔離可能 |
| `scripts/lib/backup.mjs` | 3 つの自動修復入口が共用するバックアップ規約：`{ backupDir, backupFiles, backupRel }`。変更がなければ `NO_BACKUP` |
| `references/user-guide.md` | 完全実戦ガイド（ローカルアンカー、クロスプラットフォーム対応、Web/APP フリート管理行列、初歩的ミスのガード） |
| `references/legacy-migration-sop.md` | 旧プラグイン移行 SOP（公式ガイドが届かない区間の対照マニュアル） |
| `references/heuristics.md` | 走査ノイズ低減ルールと実測の根拠 |
| `references/incident-ledger.md` | 事故台帳：実際の誤検知 / 取りこぼしを 1 行ずつ、`fixtures/` 下の最小再現スライスへ紐付け |
| `references/ci-snippet.md` | プラグインリポジトリ向け CI ゲートテンプレート（スモーク/typecheck のハード門＋監査のソフト門） |

## セキュリティ姿勢

- `env-doctor`、`code-scan`、`plugin-audit`、`log-doctor`、`seams` は厳格に読み取り専用。`run-log` はデフォルト読み取り専用で、`sanitize --out <ファイル>` だけがサニタイズ結果を指定パスに書き込みます
- `env-heal` はデフォルト dry-run。実際に動くときも移動だけで削除しない（`~/.dsh/.trash/<日付>/` へ）
- `sync-skill` は明示的に指定された下流スキルディレクトリにだけ書き込み、固定のスキル面（`SKILL.md`/`README*`/`references`/`scripts`/`sub-skills`）のみをコピーします。`--check`/`--dry-run` で事前確認できます
- DSH 本体は変更しない。`~/.dsh` 下の設定と profile 宣言にも触れない
- プラグインコードの自動修復は、判定が純粋に機械的である 3 類に限られ、必ず先にバックアップを取ります: `codemod`（Loader 入口のエクスポート面、トップレベル await）、`fix-peer-deps`（ホストコアパッケージの peer 移動）、`fleet-sweep --apply-compat`（`package.json` の互換台帳と peer 範囲の一括書き込み）。いずれもデフォルトは報告のみで、`--apply`/`--apply-compat` を付けたときだけ書き込み、元ファイルは `<plugin>/.pfa-backup/<timestamp>/` にバックアップされます。それ以外は一律、ヒットと公式の修正方法を報告するだけ。`plugin-audit --peer-patch` も印字のみで適用しない
- `.pfa-backup/` は自動修復前のローカル現場であり、リリースゲートの `FORBIDDEN_PACK` と scaffold 生成の `.gitignore` に入っています。`npm pack` がそれを tarball に入れてしまう実測があり、バックアップには修正前の `package.json` が入るためです
- キャッシュルートは注入可能（`DSH_PFA_CACHE_DIR` > `DSH_CACHE_DIR` > `XDG_CACHE_HOME` > `~/.cache`）。セルフテストは起動時に一時ディレクトリへ向け、実ユーザーキャッシュを書きません
- ネットワークは「公式ソースの取得」だけに使います: バージョン解決は npm の dist-tags を読み、ガイド取得は公式リポジトリを clone。どちらにもタイムアウトがあり、失敗は黙ってスキップせず明示的に報告します。dist-tags は 1 時間キャッシュされ、失敗時は旧キャッシュに `stale` 印付きで退避。ガイドは既存のローカル clone を優先して再利用し、`--no-clone` で取得をスキップできます

## 旧プラグインの扱い

公式アップグレードガイドは dsh-v0.1.7-rc.2 までしか遡れません。それより古いプラグインは[旧プラグイン移行 SOP](references/legacy-migration-sop.md) に従います: 元プロジェクトの [plugin-upgrade skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-upgrade) の手作りカードコリドー（dsh-v0.1.0-rc.8 以降）を差分ソースとして使い、8 段階の checklist を進めます（モード決定 → 読み取り専用の準備 → ゴーストホスト確認 → コリドー組立 → 7 類のタッチポイント → 計画確認 → 実施 → 6 層検証）。文書はカードをコピーせず参照するだけで、カードの改名はセルフテストの死リンク断言に止められます。

## 既知の限界

- 公式アップグレードガイドはすべての破壊的変更をカバーしない（パッケージ廃止の類は実測で見つからない）。その類は `env-doctor` のオーバーレイ巡回が受け持つ
- 同名シンボルは依然衝突しうる（プラグインの `path.resolve()` とガイドの `runtime.resolve()`）。前後のコードを見る人間の判断が必要
- 静的マッチングのみで、実行時の振る舞いは検証しない。スモークのモックは一般的なホスト面だけをカバー
- ゴーストホスト判定は CLI ホストの主プロセスのみ: Windows には `ps etime` がなく、デスクトップ APP の Electron renderer は判定対象外。どちらも理由付きで `unknown` と記録し、推測しない

## 由来と役割分担

本プロジェクトは [oh-my-dsh/dsh-plugin-upgrade-skill](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill)（AI エージェントに DSH プラグインの更新を教えるスキル集合。[arXiv 論文](https://arxiv.org/abs/2609.30120)付き）から git subtree で独立リポジトリとして切り出され、それ以降は独立して進化しています。2026-10-26 時点で、元プロジェクトには 198 枚のアップグレードカード、12 個のスキル、自動採点の benchmark 65 問が蓄積されています。

2 つのプロジェクトは代替ではなく補完関係です:

| 側面 | 上流 | 本プロジェクト |
| --- | --- | --- |
| 差分ソース | 手作りのアップグレードカード群 | 公式 `docs/upgrade-guide/` + npm `dist-tags`。上流とともに自動更新 |
| 新バージョンのリリース | カードの補完待ち。その間コリドーギャップ | 変更不要ですぐ使える |
| 変更 1 件の検証 | 実ホストのコールドスタート。実測 3,600 秒 | インメモリ Cordis スモーク。ミリ秒から秒 |
| オーバーレイ旧パッケージ | 手作業の切り分け | `env-doctor` 巡回 + `env-heal` 自己修復（デフォルト dry-run） |
| 弱いモデル | カード一式をコンテキストへ。-3.07 pp | 6 個の独立スクリプト。各ステップの小さな出力 1 つ |
| コードレベルの走査 | なし | アンカーマッチ + 四層ノイズ低減 |
| フリート一括巡回 | `plugin-fleet-sweep` が広さを受け持つ | 6 ステップパイプラインが深さを受け持つ |

ホスト更新後のプラグイン一括巡回は上流の [plugin-fleet-sweep](https://github.com/oh-my-dsh/dsh-plugin-upgrade-skill/tree/main/skills/plugin-fleet-sweep)（広さ）が担い、検出された個体は本プロジェクトの 6 ステップパイプラインに戻って深掘りされます（深さ）。公式ガイドが届かない歴史コリドー（v0.1.7-rc.2 より前）では、本プロジェクトの SOP は元プロジェクトのカードとスクリプトを参照します——ガイドのある区間は本プロジェクトの `code-scan`、ない区間は元プロジェクトの `plan-migration.mjs` とカード、実行時検証は元プロジェクトの `verify-runtime.mjs`（本プロジェクトの `run.mjs --real-smoke` から直接ブリッジ可能）を使います。
