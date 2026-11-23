import { delay, isUsage } from "./serial.js?v=settings-backup";

const format = "zmk-dynamic-keymapper";
const version = 1;
const uint32 = 0xffffffff;
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const sortedEntries = map => [...map].sort(([first], [second]) => first - second);
const encoder = new TextEncoder();

export async function readBackupFile(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error("設定ファイルが大きすぎます。");
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error("設定ファイルを JSON として読み込めませんでした。");
  }
  if (data?.format !== format || data.version !== version) {
    throw new Error("この設定ファイルの形式には対応していません。");
  }
  return data;
}

export async function settledInfo(device) {
  const deadline = Date.now() + 5000;
  let info = await device.info();
  while (info.status === "pending" && Date.now() < deadline) {
    await delay(100);
    info = await device.info();
  }
  if (info.status !== "active") {
    throw new Error(info.status === "invalid" ? "コンボ設定を読み込めません。コンボ画面で状態を確認してください。" :
      "設定が適用待ちです。キーを離してからやり直してください。");
  }
  return info;
}

export async function captureBackup(device, context, progress) {
  const { caps, keys, features, encoders } = context;
  const info = await settledInfo(device);
  const firmware = await device.backupIdentity();
  const layers = await device.keymapLayers(caps.layerCount, features.layerNameBytes);
  const behaviors = await device.keymapBehaviors(features.behaviorCount);
  const combos = await device.combos(info, caps);
  const macros = [];
  for (let slot = 0; slot < features.macroSlots; ++slot) {
    const macro = await device.macro(slot, features.macroSteps);
    if (macro === null) throw new Error(`マクロ ${slot} を読み込めませんでした。`);
    macros.push(macro.map(({ op, value }) => op * 65536 + value));
  }
  const keymap = [];
  for (const [index, layer] of layers.entries()) {
    progress?.(index + 1, layers.length);
    const bindings = [];
    for (const { position } of keys) {
      const { id, parameters } = await device.binding(layer.id, position);
      bindings.push([id, ...parameters]);
    }
    const rotations = [];
    for (const { encoder: sensor } of encoders) {
      const binding = await device.encoderBinding(layer.id, sensor);
      rotations.push(binding?.parameters ?? null);
    }
    keymap.push({ id: layer.id, name: layer.savedName, bindings, encoders: rotations });
  }
  const compatibility = {
    firmware,
    keys: keys.map(({ position, x, y, width, height, rotation, rx, ry }) =>
      [position, x, y, width, height, rotation, rx, ry]),
    layers: layers.map(({ id }) => id),
    encoders: encoders.map(({ encoder: sensor }) => sensor),
    comboLimits: [info.slots, caps.maxKeys, caps.layerCount],
    macroLimits: [features.macroSlots, features.macroSteps, features.macro],
    layerNameBytes: features.layerNameBytes,
    actions: sortedEntries(caps.actions),
    behaviors: sortedEntries(behaviors).map(([id, behavior]) => [
      id, behavior.name, ...behavior.parameters, behavior.editable,
      (behavior.operations ?? []).map(({ value, profileCount, name }) => [value, profileCount, name]),
    ]),
  };
  return { format, version, compatibility, settings: { keymap, combos, macros } };
}

function validateMacro(steps, limit) {
  if (!Array.isArray(steps) || steps.length > limit) return false;
  const held = new Set();
  for (const step of steps) {
    if (!integer(step, 0, 3 * 65536 + 5000)) return false;
    const op = step >>> 16;
    const value = step & 0xffff;
    if (op === 3) {
      if (!integer(value, 1, 5000)) return false;
    } else if (!isUsage(value) || (op === 2 ? !held.has(value) : held.has(value))) {
      return false;
    } else if (op === 1) {
      held.add(value);
    } else if (op === 2) {
      held.delete(value);
    }
  }
  return held.size === 0;
}

const sameChord = (first, second) =>
  Boolean(first && second && first.layers === second.layers && same(first.positions, second.positions));

function planCombos(before, after, compatibility) {
  const [slots, maxKeys, layerCount] = compatibility.comboLimits;
  if (!Array.isArray(after) || after.length > slots) throw new Error("コンボの件数が無効です。");
  const outputs = new Set(compatibility.actions.map(([id]) => id));
  const current = new Map(before.map(combo => [combo.slot, combo]));
  const desired = new Map();
  for (const combo of after) {
    const { slot, output, timeout, idle, layers, slow, positions } = combo ?? {};
    if (!integer(slot, 0, slots - 1) || desired.has(slot) || !(isUsage(output) || outputs.has(output)) ||
        !integer(timeout, 1, 65535) || !integer(idle, 0, 65535) ||
        !integer(layers, 0, 2 ** layerCount - 1) || !integer(slow, 0, 1) ||
        !Array.isArray(positions) || positions.length < 2 || positions.length > maxKeys ||
        positions.some((key, i) => !integer(key, 0, compatibility.keys.length - 1) ||
          (i > 0 && key <= positions[i - 1]))) {
      throw new Error("コンボ設定に無効な値があります。");
    }
    desired.set(slot, { slot, output, timeout, idle, layers, slow, positions });
  }
  const remove = [];
  const put = [];
  for (const [slot, old] of current) {
    if (!sameChord(old, desired.get(slot))) {
      remove.push({ command: `DEL ${slot}`, label: `コンボ ${slot}`, combo: true });
    }
  }
  for (const [slot, combo] of desired) {
    const old = current.get(slot);
    if (same(old, combo)) continue;
    if (!sameChord(old, combo) && [...desired].some(([otherSlot, other]) =>
      otherSlot !== slot && same(combo.positions, other.positions) &&
      (!combo.layers || !other.layers || (combo.layers & other.layers)))) {
      throw new Error(`コンボ ${slot} の組み合わせとレイヤーが重複しています。`);
    }
    const { output, timeout, idle, layers, slow, positions } = combo;
    put.push({ command: `PUT ${slot} ${output} ${timeout} ${idle} ${layers} ${slow} ${positions.join(" ")}`,
      label: `コンボ ${slot}`, combo: true });
  }
  return [...remove, ...put];
}

export function planRestore(current, desired) {
  const compatibility = current.compatibility;
  if (!desired.compatibility || !Object.entries(compatibility).every(([key, value]) =>
    same(desired.compatibility[key], value))) {
    throw new Error("設定ファイルとキーボードの配列またはファームウェア構成が一致しません。");
  }
  const { keymap, macros, combos } = desired.settings ?? {};
  if (!Array.isArray(keymap) || keymap.length !== current.settings.keymap.length ||
      !Array.isArray(macros) || macros.length !== current.settings.macros.length) {
    throw new Error("設定ファイルのレイヤー数またはマクロ数が一致しません。");
  }
  const behaviorIds = new Map(compatibility.behaviors.map(([id, name]) => [id, name]));
  const firmwareChecks = compatibility.firmware !== null;
  const changes = [];
  const clearMacros = [];
  for (const [slot, steps] of macros.entries()) {
    if (!validateMacro(steps, compatibility.macroLimits[1])) throw new Error(`マクロ ${slot} が無効です。`);
    if (same(steps, current.settings.macros[slot])) continue;
    (steps.length ? changes : clearMacros).push({
      command: ["MACROSET", slot, steps.length, ...steps].join(" "), label: `マクロ ${slot}`,
    });
  }
  for (const [index, old] of current.settings.keymap.entries()) {
    const layer = keymap[index];
    if (layer?.id !== old.id || typeof layer.name !== "string" ||
        !Array.isArray(layer.bindings) || layer.bindings.length !== old.bindings.length ||
        !Array.isArray(layer.encoders) || layer.encoders.length !== old.encoders.length) {
      throw new Error("レイヤーの構成が一致しません。");
    }
    if (layer.name !== old.name) {
      const bytes = encoder.encode(layer.name);
      if (!compatibility.layerNameBytes || bytes.length > compatibility.layerNameBytes ||
          /[\u0000-\u001f\u007f]/.test(layer.name) || layer.name.trim() !== layer.name ||
          new TextDecoder().decode(bytes) !== layer.name || (!bytes.length && !firmwareChecks)) {
        throw new Error(`レイヤー ${layer.id} の名前を復元できません。`);
      }
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("") || "-";
      changes.push({ command: `LAYERSET ${layer.id} ${hex}`, check: `LAYERCHECK ${layer.id} ${hex}`,
        label: `レイヤー ${layer.id} の名前` });
    }
    for (const [position, binding] of layer.bindings.entries()) {
      if (same(binding, old.bindings[position])) continue;
      const label = `レイヤー ${layer.id} のキー ${position}`;
      if (!Array.isArray(binding) || binding.length !== 3 ||
          !binding.every(value => integer(value, 0, uint32)) ||
          !(behaviorIds.has(binding[0]) || (firmwareChecks && same(binding, [65535, 0, 0])))) {
        throw new Error(`${label}の割り当てを復元できません。`);
      }
      const original = (behaviorIds.get(old.bindings[position][0]) ?? "").toLowerCase().replace(/[ _-]/g, "");
      if (original === "zdkmunlock" && binding[0] !== old.bindings[position][0]) {
        throw new Error(`${label}の ZDKM 解除キーは上書きできません。`);
      }
      const args = [layer.id, position, ...binding].join(" ");
      changes.push({ command: `BINDSET ${args}`, check: `BINDCHECK ${args}`, label });
    }
    for (const [sensor, codes] of layer.encoders.entries()) {
      if (same(codes, old.encoders[sensor])) continue;
      const label = `レイヤー ${layer.id} のエンコーダー ${sensor + 1}`;
      if (!old.encoders[sensor] || !Array.isArray(codes) || codes.length !== 2 ||
          !codes.every(value => integer(value, 1, uint32))) {
        throw new Error(`${label}の割り当てを復元できません。`);
      }
      const args = [layer.id, compatibility.encoders[sensor], ...codes].join(" ");
      changes.push({ command: `ENCODERSET ${args}`, check: `ENCODERCHECK ${args}`, label });
    }
  }
  const comboChanges = planCombos(current.settings.combos, combos, compatibility);
  return [...changes, ...comboChanges, ...clearMacros];
}
