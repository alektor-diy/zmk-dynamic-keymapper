# ZMK Studio の対応状況と拡張候補

調査日 2026-11-20。公式 ZMK と ZMK Studio の `main`、およびファームウェアが固定するメッセージ定義を照合した。以下の「対応」は比較対象にしたソースで GUI とファームウェアの経路を確認したもの。配布済みの全バージョンやブラウザーでの動作は未検証。

| 調査対象 | 確認したリビジョン |
| --- | --- |
| ZMK firmware | [`4de313367288aad5aeaa1243890e40dc813f7008`](https://github.com/zmkfirmware/zmk/tree/4de313367288aad5aeaa1243890e40dc813f7008) |
| ZMK Studio GUI | [`1bb6bb84a370c8917d8e4db15207087b26b3a844`](https://github.com/zmkfirmware/zmk-studio/tree/1bb6bb84a370c8917d8e4db15207087b26b3a844) |
| ZMK Studio メッセージ定義 | [`6cb4c283e76209d59c45fbcb218800cd19e9339d`](https://github.com/zmkfirmware/zmk-studio-messages/tree/6cb4c283e76209d59c45fbcb218800cd19e9339d) |
| ZMK が使用する Zephyr | `v4.1.0+zmk-fixes`。[ZMK の `app/west.yml`](https://github.com/zmkfirmware/zmk/blob/4de3133/app/west.yml) |

## 機能一覧

実用性・難易度は、本プロジェクトから動的編集を提供する場合の設計評価。難易度「低」は既存の編集経路で完結、「中」は外部モジュールが所有するデータや Behavior で完結、「高」は公式実装の変更や同等の入力処理の再実装が必要になる水準。

| 項目 | Studio の対応と実装上の制約 | 公式の予定 | 動的編集の実用性 | 難易度と判断 |
| --- | --- | --- | --- | --- |
| 物理キーへの Behavior 割り当て | **対応**。ビルド済みの標準・ユーザー定義 Behavior を選び、公開メタデータに沿って引数を設定。変更は入力に即時反映し、保存操作で永続化する。 | 提供済み | 高。日常的な割り当て変更 | 低。Studio を利用 |
| レイヤー名・並べ替え・有効枠の追加／削除／復元 | **対応**。GUI と RPC を確認。レイヤーの表示順と ID は別。追加は Devicetree で用意された空き枠を使用する。 | 提供済み | 高。運用中のレイヤー整理 | 低。Studio を利用 |
| ビルド済み枠を超えるレイヤーの追加 | **未対応**。テーブルと状態ビットマスクはビルド時に確定する。 | 予定なし | 中。空き枠の事前確保で対応できる場合がある | 高。対象外 |
| 物理レイアウトの選択・定義 | **部分対応**。定義済みレイアウトを選択して保存できる。座標・スキャン構成・位置マップの新規定義は Devicetree に属する。 | 選択は提供済み。新規定義は予定なし | 選択は中。新規定義は機構変更の頻度次第 | 選択は低、定義は高。Studio を利用 |
| コンボ | **未対応**。位置、対象レイヤー、タイムアウト、先行アイドル、リリース条件、出力の編集 RPC がない。標準のコンボ定義はビルド時に確定する。 | 計画あり | 高。コンボ未定義の機器で新規作成し、組み合わせと出力を調整できる | 高。任意の二つの物理位置を選ぶ新規作成・編集・削除を PoC に採用 |
| マクロ | **部分対応**。ビルド済みマクロの割り当てと、メタデータに現れる呼び出し引数を編集できる。手順、待機時間、押下／解放モードなどの定義は編集できない。 | 高度な Behavior 設定として計画あり | 高。定型操作やタイミングを調整しやすい | 制限付きの外部 Behavior は中、公式マクロと同等の編集は高 |
| Hold-Tap | **部分対応**。`&mt`、`&lt` 等の割り当てと引数は編集できる。タッピング時間、判定方式、先行アイドル、トリガー位置、子 Behavior は Devicetree のインスタンス設定。 | Behavior 設定の計画あり。個別項目の時期は未確認 | 高。誤入力の傾向に合わせた試行に向く | ビルド済みプロファイル切替は中、任意値の編集は高 |
| その他の Behavior 設定（Tap Dance 等） | **部分対応**。定義済み Behavior は割り当てられる。Tap Dance の候補列などの実装固有プロパティに対する汎用の設定 RPC はない。 | 基本・高度なプロパティの編集は計画あり。未定義 Behavior の新規作成は予定なし | 中〜高。Behavior ごとの利用頻度による | 高。効果と拡張点を個別に評価 |
| 条件付きレイヤー | **未対応**。条件と発火先は Devicetree 由来の定数。Studio のレイヤー操作で条件自体は編集できない。 | 計画あり | 中。レイヤー構造の試行に有用 | 中〜高。連鎖、ロック、既存ルールとの所有権の整理が必要 |
| エンコーダーの割り当て | **未対応**。センサーバインディングは物理キーのバインディングとは別経路で、Studio に編集 RPC がない。 | 低優先度 | 中。対応ハードウェアで用途あり | 中〜高。専用の回転 Behavior で範囲を限定できる |
| キーマップのインポート／エクスポート | **未対応**。調査対象の公式 GUI にファイル操作はなく、既存のキーマップ取得／更新 RPC は利用できる。 | 計画あり。公開 PR あり | 中〜高。移行や共有に有用 | 中。公式側の進捗を優先 |
| ホストのキー配列に応じた表示 | **未対応**。Studio は HID Usage を割り当てる。公式のホストロケール選択は計画段階。 | 計画あり | 中。表示と OS の配列を合わせやすくなる | GUI 側の課題。ファームウェアの動的設定からは対象外 |
| ビルド設定・スキャン・USB/BLE 構成 | **対象の編集 UI なし**。Kconfig、Devicetree、ドライバーの初期化で決まる項目が多い。 | 調査対象の公式 Studio 機能一覧に記載なし | 項目次第 | 高。設定項目ごとに明示的な実行時 API がある場合のみ再評価 |

## 判定に使ったソース

- GUI の `src/keyboard/Keyboard.tsx` は `setLayerBinding`、`setLayerProps`、`moveLayer`、`addLayer`、`removeLayer`、`restoreLayer`、`setActivePhysicalLayout` を呼び出す。`src/behaviors/BehaviorBindingPicker.tsx` と `BehaviorParametersPicker.tsx` が Behavior と引数の選択を扱い、`src/App.tsx` が保存・破棄・復元を呼ぶ。[キーボード UI](https://github.com/zmkfirmware/zmk-studio/blob/1bb6bb8/src/keyboard/Keyboard.tsx) · [Behavior UI](https://github.com/zmkfirmware/zmk-studio/tree/1bb6bb8/src/behaviors) · [App](https://github.com/zmkfirmware/zmk-studio/blob/1bb6bb8/src/App.tsx)
- ファームウェアの `app/src/studio/behavior_subsystem.c` は `list_all_behaviors()` と `get_behavior_details()` を公開する。後者が返すメタデータはバインディング引数の候補・型であり、任意の Devicetree プロパティを読み書きする仕組みは含まれない。`app/src/studio/keymap_subsystem.c` にキーのバインディング操作があり、センサー操作は含まれない。[Behavior RPC](https://github.com/zmkfirmware/zmk/blob/4de3133/app/src/studio/behavior_subsystem.c) · [Keymap RPC](https://github.com/zmkfirmware/zmk/blob/4de3133/app/src/studio/keymap_subsystem.c) · [メッセージ定義](https://github.com/zmkfirmware/zmk-studio-messages/tree/6cb4c28/proto/zmk)
- Studio の接続は USB シリアルと BLE。参照した GUI の `src/App.tsx` では Web BLE はブラウザー API が利用可能な Linux に限定し、デスクトップ版は Tauri 側の接続実装を利用する。USB 利用には設定済みのファームウェアが必要で、編集 RPC は通常 `&studio_unlock` で解除する。[公式 Studio ガイド](https://zmk.dev/docs/features/studio) · [GUI の接続選択](https://github.com/zmkfirmware/zmk-studio/blob/1bb6bb8/src/App.tsx)
- 公式機能表の「計画あり」から実装時期は判断できない。インポート／エクスポートは調査時点で公開 PR #171 と #179 がいずれも Open。コンボ、Behavior 設定、条件付きレイヤーについては、調査した公式版で利用可能になった証拠は確認できなかった。[公式機能表](https://zmk.dev/docs/features/studio#capabilities) · [Studio PR #171](https://github.com/zmkfirmware/zmk-studio/pull/171) · [Studio PR #179](https://github.com/zmkfirmware/zmk-studio/pull/179)

初期の優先対象は、事前定義ゼロの状態から物理キー位置と出力を選べるコンボ編集。静的コンボとの混在や高度な判定条件には公式の拡張点を検討する。用途を絞ったマクロ編集は次の機能候補として残す。[技術調査](feasibility.md) · [開発計画](roadmap.md)
