# zmk-dynamic-keymapper

ZMK 向けの動的設定モジュールです。  
Web GUI 上で動的にキーマップ、コンボ、マクロを編集できます。  
ファームウェアを再書き込みする必要がなく、保存内容はキーボード本体に保持されます。

## 導入方法

公式 ZMK v0.3に対応しています。  
v0.4での動作は未確認です。


利用したいキーボードのFW上で以下の設定を行ってください。
1. `config/west.yml` の `manifest.projects` にこのモジュールを追加します。
```west.yml
  projects:
    - name: zmk-dynamic-keymapper
      url: https://github.com/alektor-diy/zmk-dynamic-keymapper
      revision: main
```

2． 普段使う `.keymap` の冒頭に `#include <zdkm.dtsi>` を追加します。
```<任意の文字列>.keymap
#include <zdkm.dtsi>
```

3. 任意のキーに `&zdkm_unlock` を割り当てます。これはZMK Dynamic Keymapper上で設定を書き込む際に使用します。
```<任意の文字列>.keymap
&zdkm_unlock
```

設定後、FWをビルドして書き込みます。  
分割キーボードの場合は central 側のみ書き込めば利用可能です。  

## Web GUI

Chrome または Edge で [ZMK Dynamic Keymapper](https://alektor-diy.github.io/zmk-dynamic-keymapper/) を開き、`USB で接続` から ZDKM 専用の USB ポートを選びます。  
解除ダイアログが表示されたら、キーボード上の `&zdkm_unlock` キーを押してロックを解除してください。

### Bluetooth 操作と出力先の割り当て

キーマップの「動作の詳細設定」で「Bluetooth」または「Output Selection」を選ぶと、プロファイル選択や USB / BLE 切り替えを操作名で割り当てられます。プロファイルの選択・切断では、本体が対応するプロファイルが候補に表示されます。割り当てた操作は、キーボード上でそのキーを押すと実行されます。

操作名の選択には対応する ZDKM ファームウェアが必要です。ビルド時は `#include <zdkm.dtsi>` を `#include <behaviors.dtsi>` より前に置くと、初期キーマップに割り当てがない場合もこれらの動作を利用できます。旧ファームウェアでは従来の数値入力を使えます。

### ロータリーエンコーダー

`.keymap` の `sensor-bindings` に `&inc_dec_kp` を使うレイヤーでは、キーマップ画面で時計回りと反時計回りに別々のキーコードを割り当てられます。設定はレイヤーごとに本体に保存されます。実機で使うには、この機能を含む ZDKM ファームウェアが必要です。

「デモを試す」から、左側にエンコーダーを搭載した52キーの SylvaTwin で操作を試せます。
