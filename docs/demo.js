import { decodeMacroStep } from "./keycodes.js?v=bt-actions";
import { bluetoothActions } from "./bluetooth.js";

const KEY_PRESS = 1;
const MACRO = 2;
const keyboardUsage = usage => 0x070000 + usage;
const binding = (id, first = 0, second = 0) => ({ id, parameters: [first, second] });
const key = usage => binding(KEY_PRESS, keyboardUsage(usage));
const letter = value => key(value.charCodeAt(0) - 61);
const geometry = (x, y) => ({ x, y, width: 100, height: 100, rotation: 0, rx: 0, ry: 0 });
const operation = (value, name, profileCount = 0) => ({ value, name, profileCount });

// SylvaTwin's matrix positions follow the physical rows, left half then right half.
export const demoKeys = [6, 6, 7, 7].flatMap((width, row) => [0, 1].flatMap(half =>
  Array.from({ length: width }, (_, column) =>
    geometry(column * 100 + (half ? 1700 - width * 100 : 0), row * 100))));

const stockCombos = [
  { slot: 0, output: 0x29, timeout: 50, idle: 0, layers: 0, slow: 0, positions: [13, 14] },
  { slot: 1, output: 576, timeout: 65, idle: 0, layers: 1, slow: 0, positions: [25, 26, 27] },
];

export class DemoDevice {
  constructor() {
    this.keys = demoKeys.map((key, position) => ({ ...key, position }));
    this.names = ["Base", "Symbols", "Navigation"];
    this.behaviors = new Map([
      [KEY_PRESS, { name: "Key Press", parameters: [2, 0], editable: true }],
      [MACRO, { name: "ZDKM Macro", parameters: [1, 0], editable: true }],
      [3, { name: "Mod-Tap", parameters: [2, 2], editable: true }],
      [4, { name: "Layer-Tap", parameters: [3, 2], editable: true }],
      [5, { name: "Momentary Layer", parameters: [3, 0], editable: true }],
      [6, { name: "Transparent", parameters: [0, 0], editable: true }],
      [7, { name: "None", parameters: [0, 0], editable: true }],
      [8, { name: "Mouse Key Press", parameters: [1, 0], editable: true }],
      [9, { name: "Bluetooth", parameters: [1, 1], editable: true, operations: [
        operation(1, "Next Profile"), operation(2, "Previous Profile"),
        operation(4, "Clear All Profiles"), operation(0, "Clear Selected Profile"),
        operation(3, "Select Profile", 5), operation(5, "Disconnect Profile", 5),
      ] }],
      [10, { name: "Output Selection", parameters: [1, 0], editable: true, operations: [
        operation(0, "Toggle Outputs"), operation(1, "USB Output"), operation(2, "BLE Output"),
      ] }],
    ]);
    const base = [
      key(0x29), ...[..."QWERTYUIOP"].map(letter), key(0x2a),
      key(0x2b), ...[..."ASDFGHJKL"].map(letter), key(0x38), key(0x28),
      key(0xe1), ...[..."ZXCVB"].map(letter), binding(8, 1), binding(8, 1), ...[..."NM"].map(letter),
      key(0x36), key(0x37), key(0x52), key(0xe5),
      key(0xe0), key(0xe3), key(0xe2), binding(7), key(0x4c), key(0x2c), binding(4, 1, keyboardUsage(0x40)),
      binding(4, 2, keyboardUsage(0x43)), binding(7), key(0x2d), binding(7), key(0x50), key(0x51), key(0x4f),
    ];
    const symbols = Array.from({ length: this.keys.length }, (_, pos) =>
      pos < 10 ? binding(KEY_PRESS, keyboardUsage(0x1e + pos)) : binding(6));
    const navigation = this.keys.map((_, pos) =>
      pos >= 18 && pos <= 21 ? binding(KEY_PRESS, keyboardUsage([0x50, 0x51, 0x52, 0x4f][pos - 18])) : binding(6));
    this.bindings = [base, symbols, navigation];
    this.encoderBindings = this.names.map(() => ({ parameters: [0x0c00e9, 0x0c00ea] }));
    this.comboTable = new Map(stockCombos.map(combo => [combo.slot, combo]));
    this.macros = new Map([[0, [11, 8, 15, 15, 18].map(value => ({ op: 0, value }))]]);
  }

  async info() {
    return { count: this.keys.length, slots: 10, timeout: 50, status: "active" };
  }

  async capabilities() {
    return {
      legacy: false, maxKeys: 20, layerCount: this.names.length, extendedKeys: true, keyRanges: [0xff, 0xfff],
      actions: new Map([[576, "ZDKM マクロ 0"], [577, "ZDKM マクロ 1"]]),
      bluetooth: bluetoothActions(5, 0b111),
    };
  }

  async editorCapabilities() {
    return { behaviorCount: this.behaviors.size, macroSlots: 2, macroSteps: 16, keyPress: KEY_PRESS,
      macro: MACRO, layerNameBytes: 19 };
  }

  async layout() { return this.keys; }
  async backupIdentity() { return ["sylvatwin-demo"]; }
  async checkRestoreCommand() {}
  async encoderLayout() { return [{ ...geometry(600, 50), encoder: 0 }]; }
  async encoderBinding(layer, index) { return index === 0 ? this.encoderBindings[layer] : null; }
  async combos() { return [...this.comboTable.values()].sort((a, b) => a.slot - b.slot); }
  async keymapBehaviors() { return new Map(this.behaviors); }
  async keymapLayers() {
    return this.names.map((name, id) => ({ id, name, savedName: name }));
  }
  async binding(layer, position) { return this.bindings[layer][position]; }
  async macro(slot) { return (this.macros.get(slot) ?? []).map(step => ({ ...step })); }

  async save(command) {
    const [operation, ...args] = command.trim().split(" ");
    if (operation === "LAYERSET") {
      const [layer, hex] = args;
      this.names[Number(layer)] = hex === "-" ? "" : new TextDecoder().decode(
        Uint8Array.from(hex.match(/../g), byte => Number.parseInt(byte, 16)));
      return;
    }
    const values = args.map(Number);
    switch (operation) {
    case "BINDSET": {
      const [layer, position, id, ...parameters] = values;
      this.bindings[layer][position] = { id, parameters };
      return;
    }
    case "ENCODERSET": {
      const [layer, index, ...parameters] = values;
      if (index !== 0 || !this.encoderBindings[layer] || parameters.length !== 2 ||
          parameters.some(code => !Number.isInteger(code) || code <= 0 || code > 0xffffffff)) {
        throw new Error("無効なエンコーダー設定です。");
      }
      this.encoderBindings[layer] = { parameters };
      return;
    }
    case "PUT": {
      const [slot, output, timeout, idle, layers, slow, ...positions] = values;
      this.comboTable.set(slot, { slot, output, timeout, idle, layers, slow, positions });
      return;
    }
    case "DEL":
      this.comboTable.delete(values[0]);
      return;
    case "RESET":
      this.comboTable = new Map(stockCombos.map(combo => [combo.slot, combo]));
      return;
    case "MACROSET": {
      const [slot, , ...steps] = values;
      this.macros.set(slot, steps.map(decodeMacroStep));
      return;
    }
    default:
      throw new Error("デモで処理できない操作です。");
    }
  }

  async close() {}
}
