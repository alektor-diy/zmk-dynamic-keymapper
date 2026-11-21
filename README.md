# zmk-dynamic-keymapper

ZMK 向けの動的設定モジュールです。ひとつの Web GUI でキーマップ、コンボ、マクロを編集できます。保存内容はキーボード本体に保持されます。

## 導入方法

公式 ZMK v0.3、USB CDC ACM と永続 Settings バックエンドのあるボード、全キーの座標が定義された単一の物理レイアウトに対応します。

1. `config/west.yml` の `manifest.projects` にこのモジュールを追加し、普段使う `.keymap` の冒頭に `#include <zdkm.dtsi>` を追加します。
2. キーマップ上の好きな位置に `&zdkm_unlock` を割り当てます。たとえば設定用レイヤーの空きキーに置きます。

`west.yml` の追加例です。URL と revision は、取得する ZDKM のリポジトリとリリースに置き換えてください。

```yaml
    - name: zmk-dynamic-keymapper
      url: https://github.com/<owner>/zmk-dynamic-keymapper
      revision: <release-tag>
```

既存の `zmk,combos` 定義はそのまま残します。ZDKM が有効なコンボを読み取り、キー位置・タイムアウト・対象レイヤー・先行アイドル・解放条件・出力を初期設定として読み込みます。以前の検証用キーマップで `combos` ノードを無効にしていた場合は、元の有効な定義を使用してください。

設定後は普段の手順でビルドして書き込みます。分割機ではキーマップを処理する central が設定先です。ZMK Studio を使う場合は既存の `studio-rpc-usb-uart` snippet を使い続け、GUI では ZDKM 専用ポートを選択します。

ローカルの作業ツリーは、既存の `west build` の CMake 引数に `-DZMK_EXTRA_MODULES=<このリポジトリの絶対パス>` を指定して組み込めます。

## Web GUI

Chrome または Edge で GUI を開き、`USB で接続` から ZDKM 専用の USB ポートを選びます。保存や削除の案内が出たら20秒以内にキーボード上の `&zdkm_unlock` を押し、すべてのキーを離してください。

- **キーマップ**でレイヤーと物理キーを選び、フルサイズのキー候補または組み込み済みの Behavior から割り当てを選びます。OS の入力配列に合わせて US または JIS を選ぶと、レジェンドが切り替わります。各キーには ZMK のコード名も表示されます。割り当ての変更は ZMK 標準のキーマップ設定に保存され、Studio でも同じ設定を読み取れます。Studio で編集中の場合は、変更を保存または破棄してから切断してください。解除キーの割り当ては GUI で保護されます。
- **コンボ**で発火する物理キーと出力を選びます。「判定オプション」で判定時間、対象レイヤー、先行アイドル、解放条件を設定できます。
- **マクロ**で枠を選び、「タップ」「押す」「離す」「待つ」を並べて保存します。8枠あり、1枠につき最大16手順、1回の待機は1〜5000 msです。保存した枠はキーマップで `ZDKM Macro` を選んで割り当てるか、コンボの出力一覧から選べます。実行中に編集した手順は次回の実行から反映されます。同時再生は1件までです。

`.keymap` に記述した既存の ZMK マクロは、コンパイル済みの Behavior として引き続き動作します。GUI で手順を編集できるのは ZDKM のマクロ枠です。既存のマクロを GUI で管理する場合は、手順を空き枠に入力して割り当て先をその枠に変更してください。

キーマップとマクロを利用するには、この機能を含むファームウェアと GUI が必要です。既に `#include <zdkm.dtsi>` と `&zdkm_unlock` を設定している場合は、west manifest が更新後の ZDKM を参照していれば追加のキーボード設定は不要です。

GitHub Pages で配布する場合は、リポジトリの `Settings → Pages` で `Deploy from a branch` を選び、公開するブランチの `/docs` を指定します。この構成で `docs/index.html` がプロジェクトページの入口になります。[GitHub Pages の公開設定](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

リポジトリ直下で次を実行するとローカルでも使えます。

```sh
python -m http.server 8765 --bind 127.0.0.1 --directory docs
```

[ローカル GUI](http://localhost:8765/)

GUI が「起動待ち」のまま進まない場合は、Chrome のアドレスバーからローカル GUI の URL を直接開いてください。「ポート選択待ち」は、ブラウザーが表示するポート選択画面への応答待ちです。

## CLI からの操作

```sh
python -m pip install pyserial
python tools/zdkm.py --port COM7 info
python tools/zdkm.py --port COM7 layout
python tools/zdkm.py --port COM7 list
python tools/zdkm.py --port COM7 set 0 12 13 esc
python tools/zdkm.py --port COM7 set 0 4 5 tab
python tools/zdkm.py --port COM7 put 0 tab 4 5 6 --timeout 75 --layer 1 --prior-idle 100 --slow-release
python tools/zdkm.py --port COM7 delete 0
```

`COM7` は接続先のポートに置き換えてください。`layout` は座標と 0 始まりの位置 ID を返します。上の例では ID 12 と 13 を同時押しすると Esc が出る定義を作成し、同じスロットを ID 4 と 5 で Tab が出る定義に更新します。出力には基本的なキー名、英字、または HID Keyboard Usage ID を指定できます。

書き込みコマンドの案内が出てから20秒以内に `&zdkm_unlock` を押し、キーを離してください。保存済みの変更は、全キーを解放した時点で適用されます。`info` の `pending` は保存済みで適用待ち、`active` は適用済みです。`reset` は保存した変更を取り消し、ファームウェアの初期設定に戻します。

## コンボの判定と出力

- ZMK と同様に最初のキーから判定時間を測ります。短いコンボと長いコンボが重なる場合は長い方を待ち、長い方が時間切れなどで成立しなければ、すでに成立していた短い方を発火させます。どのコンボも成立しなかった場合は保留したキーを通常のキーマップへ送ります。[ZMK のコンボ仕様](https://zmk.dev/docs/keymaps/combos)
- 既定は判定時間50 ms、全レイヤー、先行アイドル無効、最初のキーの解放で出力を解放です。レイヤーを指定すると、最初のキーを押した時点の最上位のアクティブレイヤーで判定します。先行アイドルを有効にすると、指定時間内に通常の非修飾キーが入力されていた場合は発火しません。CLI と GUI では先行アイドルの無効を `0` と表します。
- 取り込んだ件数に加えて、既定で8件の空き枠を確保します。総数は最大64件です。同時に発火状態を保持できる件数は ZMK の `CONFIG_ZMK_COMBO_MAX_PRESSED_COMBOS` に従い、既定は4件です。新規に同じ物理位置の組を複数登録する場合は、対象レイヤーが互いに重ならない必要があります。

取り込んだコンボを GUI で編集・削除した内容は、再起動しても上書きされません。旧版の保存データがある場合は、その内容を優先し、同じキー位置と対象レイヤーが重ならない初期コンボを空き枠に追加します。取り込んだコンボの出力 Behavior を後から選び直すこともできます。コンボ定義の名前やバインディングの変更で保存済みの出力を解決できなくなった場合は、GUI が互換性エラーを表示します。

既存コンボの Behavior は取り込み時に出力候補に加わります。既存コンボで使っていない Behavior も、次のようにキーマップや overlay で追加できます。この例では `&mo 1` が選択肢に加わります。

```dts
/ {
    zdkm_layer_one {
        compatible = "zdkm,combo-action";
        action-id = <1>;
        display-name = "Hold layer 1";
        bindings = <&mo 1>;
    };
};
```

`action-id` は永続設定で参照するため一意に保ちます。CLI では `info` に表示されるコードを `put` の出力に指定します。この例のコードは `257` です。

## 検証

実機では次の順に確認できます。

1. 更新後の ZDKM を含めてファームウェアをビルドし、central に書き込みます。更新後の GUI から ZDKM 専用ポートに接続します。
2. キーマップで解除キー以外の使っていないキーを選び、一時的に別の文字に割り当てます。メモ帳で出力を確認します。
3. マクロ枠に「A をタップ」「100 ms 待つ」「B をタップ」を設定します。キーマップの別の空きキーと、必要に応じてコンボの出力に同じ枠を割り当てます。押すとメモ帳に `ab` が出ることを確認します。
4. キーボードを再起動し、GUI を再接続します。手順2と3の設定が表示され、同じ入力になることを確認します。

ホスト上で判定処理のテストを実行できます。

```sh
cc -std=c11 -Wall -Wextra -Werror -Iinclude src/combo.c tests/combo.c -o test-combo
./test-combo
```

[設計](docs/architecture.md) · [実機テスト項目](docs/roadmap.md)
