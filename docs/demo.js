const KEY_PRESS = 1;
const MACRO = 2;
const keyboardUsage = usage => 0x070000 + usage;
const letter = value => keyboardUsage(value.charCodeAt(0) - 61);
const binding = (id, first = 0, second = 0) => ({ id, parameters: [first, second] });
const stockCombos = [
  { slot: 0, output: 0x29, timeout: 50, idle: 0, layers: 0, slow: 0, positions: [13, 14] },
  { slot: 1, output: 576, timeout: 65, idle: 0, layers: 1, slow: 0, positions: [24, 25, 26] },
];

export class DemoDevice {
  constructor(layout) {
    this.keys = layout.map((key, position) => ({ ...key, position }));
    this.names = ["Base", "Symbols", "Navigation"];
    this.behaviors = new Map([
      [KEY_PRESS, { name: "Key Press", parameters: [2, 0], editable: true }],
      [MACRO, { name: "ZDKM Macro", parameters: [1, 0], editable: true }],
      [3, { name: "Mod-Tap", parameters: [2, 2], editable: true }],
      [4, { name: "Layer-Tap", parameters: [3, 2], editable: true }],
      [5, { name: "Momentary Layer", parameters: [3, 0], editable: true }],
      [6, { name: "Transparent", parameters: [0, 0], editable: true }],
      [7, { name: "None", parameters: [0, 0], editable: true }],
    ]);
    const base = [..."QWERTYUIOPXXASDFGHJKLXXXZXCVBNMXXXXX"]
      .map(value => binding(KEY_PRESS, letter(value)));
    for (const [position, usage] of [[10, 0x2f], [11, 0x30], [21, 0x33], [22, 0x34], [23, 0x28],
      [31, 0x36], [32, 0x37], [33, 0x38], [34, 0x52], [35, 0x2a]]) {
      base[position] = binding(KEY_PRESS, keyboardUsage(usage));
    }
    base.push(binding(3, keyboardUsage(0xe0), keyboardUsage(0x2b)), binding(4, 1, keyboardUsage(0x2c)),
      binding(MACRO, 0), binding(KEY_PRESS, keyboardUsage(0x28)),
      binding(5, 2), binding(KEY_PRESS, keyboardUsage(0x2a)));
    const symbols = Array.from({ length: this.keys.length }, (_, pos) =>
      pos < 10 ? binding(KEY_PRESS, keyboardUsage(0x1e + pos)) : binding(6));
    const navigation = this.keys.map((_, pos) =>
      pos >= 18 && pos <= 21 ? binding(KEY_PRESS, keyboardUsage([0x50, 0x51, 0x52, 0x4f][pos - 18])) : binding(6));
    this.bindings = [base, symbols, navigation];
    this.comboTable = new Map(stockCombos.map(combo => [combo.slot, combo]));
    this.macros = new Map([[0, [11, 8, 15, 15, 18].map(value => ({ op: 0, value }))]]);
  }

  async info() {
    return { count: this.keys.length, slots: 10, timeout: 50, status: "active" };
  }

  async capabilities() {
    return {
      legacy: false, maxKeys: 20, layerCount: this.names.length,
      actions: new Map([[576, "ZDKM マクロ 0"], [577, "ZDKM マクロ 1"]]),
    };
  }

  async editorCapabilities() {
    return { behaviorCount: this.behaviors.size, macroSlots: 2, macroSteps: 16, keyPress: KEY_PRESS,
      macro: MACRO, layerNameBytes: 19 };
  }

  async layout() { return this.keys; }
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
      this.names[Number(layer)] = new TextDecoder().decode(
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
      this.macros.set(slot, steps.map(step => ({ op: step >>> 16, value: step & 0xffff })));
      return;
    }
    default:
      throw new Error("デモで処理できない操作です。");
    }
  }

  async close() {}
}
