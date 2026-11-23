const SELECT_BASE = 0x400;
const DISCONNECT_BASE = 0x500;
const commands = new Map([
  [0x601, "次のプロファイルへ"],
  [0x602, "前のプロファイルへ"],
  [0x604, "すべてのペアリングを解除"],
  [0x600, "選択中のペアリングを解除"],
]);
const outputs = new Map([
  [0x610, "USB / BLE を切り替え"],
  [0x611, "USB に切り替え"],
  [0x612, "BLE に切り替え"],
  [0x613, "出力を停止"],
]);

export function bluetoothActions(profiles, outputCommands) {
  const select = Array.from({ length: profiles }, (_, index) => [SELECT_BASE + index, `BT${index + 1}`]);
  const disconnect = Array.from({ length: profiles }, (_, index) =>
    [DISCONNECT_BASE + index, `BT${index + 1} を切断`]);
  const availableOutputs = [...outputs].filter(([id]) => outputCommands & (1 << (id - 0x610)));
  return new Map([...select, ...(profiles ? commands : []), ...disconnect, ...availableOutputs]);
}

export function isBluetoothAction(value) {
  return Number.isInteger(value) &&
    ((value >= SELECT_BASE && value < 0x600) || commands.has(value) || outputs.has(value));
}

export function bluetoothActionLabel(value) {
  if (value >= SELECT_BASE && value < DISCONNECT_BASE) return `BT${value - SELECT_BASE + 1}`;
  if (value >= DISCONNECT_BASE && value < 0x600) return `BT${value - DISCONNECT_BASE + 1} を切断`;
  return commands.get(value) ?? outputs.get(value);
}
