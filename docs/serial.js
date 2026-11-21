export class ConnectionError extends Error {}
class ProtocolError extends Error {
  constructor(code) {
    super(RESPONSE_ERRORS[code] ?? "キーボードが要求を拒否しました。");
    this.code = code;
  }
}

const RESPONSE_ERRORS = {
  FRAME: "機器が通信データを読み取れませんでした。",
  LOCKED: "書き込み許可が切れました。もう一度保存してください。",
  INVALID: "キー位置または出力キーを確認してください。",
  DUPLICATE: "同じ組み合わせのコンボがすでにあります。",
  BUSY: "キーボードが設定を処理中です。すべてのキーを離して再読み込みしてください。",
  RESET_REQUIRED: "保存済みの設定を読み込めません。コンボ設定の初期化が必要です。",
  NO_SPACE: "キーボードの保存領域に空きがありません。",
  STORAGE: "キーボードへの書き込みに失敗しました。",
  UPGRADE: "このコンボを編集するには新しいバージョンの設定ツールを使ってください。",
  EDIT_BUSY: "設定を書き込めません。Studio の未保存変更を保存または破棄し、Studio を切断してから再試行してください。",
  KEYS_HELD: "すべてのキーを離してから、もう一度保存してください。",
  PROTECTED: "このキーには ZDKM の解除動作が割り当てられています。",
  RESTART: "保存状態を再読み込みできませんでした。キーボードを再起動して確認してください。",
};

const INFO_STATES = new Set(["active", "pending", "invalid", "loading"]);
const LEGACY_UNLOCK_TIMEOUT = 20000;
export const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function integer(value, minimum, maximum) {
  const n = Number(value);
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n) || n < minimum || n > maximum) {
    throw new ConnectionError("キーボードから想定外の値が返されました。");
  }
  return n;
}

export function isUsage(usage) {
  return Number.isInteger(usage) && ((usage >= 0x04 && usage <= 0x65) ||
    (usage >= 0xe0 && usage <= 0xe7));
}

export class SerialDevice {
  static async open(port) {
    try {
      await port.open({ baudRate: 115200 });
    } catch (error) {
      throw new ConnectionError("選択したポートを開けませんでした。他のブラウザー、Studio、CLI でこのポートを使っている場合は切断してください。", { cause: error });
    }
    let device;
    try {
      await port.setSignals({ dataTerminalReady: true });
      device = new SerialDevice(port);
      await device.withTimeout(async () => {
        await device.writer.write(device.encoder.encode("\nHELLO\n"));
        for (let attempt = 0; attempt < 3; attempt++) {
          if (await device.readLine() === "OK ZDKM 1") return;
        }
        throw new ConnectionError("ZDKM プロトコル v1 の応答がありません。");
      });
      return device;
    } catch (error) {
      if (device) await device.close();
      else if (port.readable || port.writable) await port.close().catch(() => {});
      throw new ConnectionError("接続できませんでした。ZDKM 専用の USB ポートを選んでください。", { cause: error });
    }
  }

  constructor(port) {
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
    this.buffer = "";
    this.closing = null;
    this.sessionToken = undefined;
    this.sessionWaitUnlimited = false;
  }

  async withTimeout(operation) {
    if (this.closing) throw new ConnectionError("USB 接続が終了しました。");
    let timer;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ConnectionError("キーボードからの応答がありません。")), 2500);
      });
      return await Promise.race([operation(), deadline]);
    } catch (error) {
      if (error instanceof ConnectionError) throw error;
      throw new ConnectionError("USB 通信が切断されました。", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  async readLine() {
    for (;;) {
      const end = this.buffer.indexOf("\n");
      if (end >= 0 && end <= 160) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        return line;
      }
      if (this.buffer.length > 160) throw new ConnectionError("USB から長すぎる応答を受信しました。");
      const { value, done } = await this.reader.read();
      if (done) throw new ConnectionError("USB 接続が終了しました。");
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async request(command, expected, count = 0) {
    const line = await this.withTimeout(async () => {
      await this.writer.write(this.encoder.encode(command + "\n"));
      return this.readLine();
    });
    const [kind, response, ...values] = line.split(/ +/);
    if (kind === "ERR") throw new ProtocolError(response);
    if (kind !== "OK" || !expected.includes(response) || (count !== null && values.length !== count)) {
      throw new ConnectionError("キーボードから想定外の応答が返されました。");
    }
    return { response, values, line };
  }

  async capabilities() {
    let values;
    try {
      ({ values } = await this.request("CAPS", ["CAPS"], 3));
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "UNKNOWN") {
        return { legacy: true, maxKeys: 2, layerCount: 0, actions: new Map() };
      }
      throw error;
    }
    const [maxKeys, layerCount, count] = [
      integer(values[0], 2, 20), integer(values[1], 1, 32), integer(values[2], 0, 327),
    ];
    const actions = new Map();
    for (let i = 0; i < count; i++) {
      const { values: [code, ...label] } = await this.request(`ACTION ${i}`, ["ACTION"], null);
      const id = integer(code, 257, 583);
      if (!label.length || actions.has(id)) throw new ConnectionError("無効な Behavior 一覧を受信しました。");
      actions.set(id, label.join(" "));
    }
    return { legacy: false, maxKeys, layerCount, actions };
  }

  async editorCapabilities() {
    try {
      const { values } = await this.request("FEATURES", ["FEATURES"], 5);
      const [behaviorCount, macroSlots, macroSteps, keyPress, macro] = values.map((value, i) =>
        integer(value, i < 3 ? 1 : 0, [65535, 8, 16, 65534, 65534][i]));
      let layerNameBytes = 0;
      try {
        const info = await this.request("LAYEREDIT", ["LAYEREDIT"], 1);
        layerNameBytes = integer(info.values[0], 0, 73);
      } catch (error) {
        if (!(error instanceof ProtocolError && error.code === "UNKNOWN")) throw error;
      }
      return { behaviorCount, macroSlots, macroSteps, keyPress, macro, layerNameBytes };
    } catch (error) {
      if (error instanceof ProtocolError && error.code === "UNKNOWN") return null;
      throw error;
    }
  }

  async keymapLayers(count, layerNameBytes) {
    const layers = [];
    for (let index = 0; index < count; index++) {
      const { values: [id], line } = await this.request(`LAYER ${index}`, ["LAYER"], null);
      const layer = integer(id, 0, 255);
      if (layer === 255) continue;
      if (layer >= count || layers.some(item => item.id === layer)) {
        throw new ConnectionError("無効なレイヤー一覧を受信しました。");
      }
      const label = line.slice(`OK LAYER ${id} `.length);
      const savedName = !layerNameBytes && label === "-" ? "" : label;
      layers.push({ id: layer, name: savedName || `レイヤー ${layer}`, savedName });
    }
    return layers;
  }

  async keymapBehaviors(count) {
    const behaviors = new Map();
    for (let index = 0; index < count; index++) {
      const { values: [id, first, second, supported, ...label] } =
        await this.request(`BEHAVIOR ${index}`, ["BEHAVIOR"], null);
      const code = integer(id, 0, 65535);
      if (code === 65535) continue;
      behaviors.set(code, {
        name: label.join(" "), parameters: [integer(first, 0, 3), integer(second, 0, 3)],
        editable: !!integer(supported, 0, 1),
      });
    }
    return behaviors;
  }

  async binding(layer, position) {
    const { values: [id, ...parameters] } = await this.request(`BIND ${layer} ${position}`, ["BIND"], 3);
    return { id: integer(id, 0, 65535), parameters: parameters.map(value => integer(value, 0, 0xffffffff)) };
  }

  async macro(slot, limit) {
    const { values: [count, ...items] } = await this.request(`MACRO ${slot}`, ["MACRO"], null);
    if (count === "INVALID" && items.length === 0) return null;
    if (integer(count, 0, limit) !== items.length) throw new ConnectionError("無効なマクロを受信しました。");
    return items.map(item => {
      const code = integer(item, 0, 3 * 65536 + 5000);
      const op = code >>> 16;
      const value = code & 0xffff;
      if (op === 3 ? value < 1 || value > 5000 : !isUsage(value)) {
        throw new ConnectionError("無効なマクロ操作を受信しました。");
      }
      return { op, value };
    });
  }

  async info() {
    const { values: [count, slots, timeout, status] } = await this.request("INFO", ["INFO"], 4);
    if (!INFO_STATES.has(status)) throw new ConnectionError("キーボードの状態を読み取れませんでした。");
    return {
      count: integer(count, 1, 4096),
      slots: integer(slots, 1, 64),
      timeout: integer(timeout, 10, 200),
      status,
    };
  }

  async layout(count) {
    const keys = [];
    for (let position = 0; position < count; position++) {
      const { values } = await this.request(`KEY ${position}`, ["KEY"], 7);
      const [x, y, width, height, rotation, rx, ry] = values.map(value => integer(value, -32768, 32767));
      if (width <= 0 || height <= 0) throw new ConnectionError("無効なキーの寸法を受信しました。");
      keys.push({ position, x, y, width, height, rotation, rx, ry });
    }
    return keys;
  }

  async combos(info, caps) {
    const combos = [];
    for (let slot = 0; slot < info.slots; slot++) {
      let record;
      if (caps.legacy) {
        const { values } = await this.request(`SLOT ${slot}`, ["SLOT"], 3);
        const [first, second, output] = values.map(value => integer(value, 0, 65535));
        if (output) record = { output, timeout: info.timeout, idle: 0, layers: 0, slow: 0, positions: [first, second] };
      } else {
        const { values } = await this.request(`COMBO ${slot}`, ["COMBO"], null);
        const [output, timeout, idle, layers, slow, count, ...positions] =
          values.map(value => integer(value, 0, 0xffffffff));
        if (values.length < 6 || count !== positions.length ||
            (count && (count < 2 || count > caps.maxKeys || timeout < 1 || timeout > 65535 ||
              idle > 65535 || layers >= 2 ** caps.layerCount || slow > 1))) {
          throw new ConnectionError("無効なコンボ設定を受信しました。");
        }
        if (count) record = { output, timeout, idle, layers, slow, positions };
      }
      if (!record) continue;
      if ((!isUsage(record.output) && !caps.actions.has(record.output)) ||
          record.positions.some((position, i, all) => position >= info.count || (i > 0 && position <= all[i - 1]))) {
        throw new ConnectionError("無効なコンボ設定を受信しました。");
      }
      combos.push({ slot, ...record });
    }
    return combos;
  }

  async supportsSessionUnlock() {
    if (this.sessionToken === undefined) {
      try {
        await this.request("SESSION", ["SESSION"]);
        try {
          await this.request("SESSIONWAIT", ["SESSIONWAIT"]);
          this.sessionWaitUnlimited = true;
        } catch (error) {
          if (!(error instanceof ProtocolError && error.code === "UNKNOWN")) throw error;
        }
        const nonce = crypto.getRandomValues(new Uint8Array(16));
        this.sessionToken = Array.from(nonce, byte => byte.toString(16).padStart(2, "0")).join("");
      } catch (error) {
        if (!(error instanceof ProtocolError && error.code === "UNKNOWN")) throw error;
        this.sessionToken = null;
      }
    }
    return this.sessionToken !== null;
  }

  async unlockSession(onArmed) {
    const token = this.sessionToken;
    const { response } = await this.request(`ARMSESSION ${token}`, ["ARMED", "UNLOCKED"]);
    if (response === "UNLOCKED") return;
    onArmed(this.sessionWaitUnlimited ? "キーボードの ZDKM 解除キーを押してください。" :
      "20秒以内にキーボードの ZDKM 解除キーを押してください。");
    await this.waitForUnlock(`SESSIONAUTH ${token}`, this.sessionWaitUnlimited ? Infinity : LEGACY_UNLOCK_TIMEOUT);
  }

  async save(command, notify) {
    if (await this.supportsSessionUnlock()) {
      await this.unlockSession(notify);
      await this.request(`WRITE ${this.sessionToken} ${command}`, ["SAVED"]);
    } else {
      await this.request("ARM", ["ARMED"]);
      notify("20秒以内にキーボードの ZDKM 解除キーを押してください。");
      await this.waitForUnlock("AUTH");
      await this.request(command, ["SAVED"]);
    }
    notify("保存しました。すべてのキーを離すと適用されます。");
  }

  async waitForUnlock(query, timeout = LEGACY_UNLOCK_TIMEOUT) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const { response } = await this.request(query, ["LOCKED", "UNLOCKED"]);
      if (response === "UNLOCKED") return;
      await delay(140);
    }
    throw new Error("書き込み許可がタイムアウトしました。もう一度操作してください。");
  }

  close() {
    this.closing ??= this.closeStreams();
    return this.closing;
  }

  async closeStreams() {
    await this.port.setSignals({ dataTerminalReady: false }).catch(() => {});
    await Promise.allSettled([this.reader.cancel(), this.writer.abort()]);
    this.reader.releaseLock();
    this.writer.releaseLock();
    await this.port.close().catch(() => {});
  }
}
