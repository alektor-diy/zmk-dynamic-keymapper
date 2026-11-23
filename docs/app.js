import { ConnectionError, SerialDevice, delay, supportsUsage } from "./serial.js?v=full-keys";
import { setupEditors } from "./editors.js?v=bt-profiles";
import { fillKeycap, keycodes, keycodeText, packUsage, setUsageValue, unpackUsage } from "./keycodes.js?v=key-groups";
import { DemoDevice } from "./demo.js?v=full-keys";
import { captureBackup, planRestore, readBackupFile, settledInfo } from "./backup.js?v=full-keys";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
const supportsSerial = window.isSecureContext && typeof navigator.serial?.requestPort === "function";
const unavailableSerial = "Web Serial が利用できません。USB 接続には、HTTPS または localhost でデスクトップ版 Chrome や Edge を使ってください。";
const usageLabels = new Map();

for (let i = 0; i < 26; i++) usageLabels.set(4 + i, String.fromCharCode(65 + i));
for (const [i, label] of [..."1234567890"].entries()) usageLabels.set(0x1e + i, label);
for (const [i, label] of [
  "Enter", "Esc", "Backspace", "Tab", "Space", "-", "=", "[", "]", "\\", "Non-US #",
  ";", "'", "`", ",", ".", "/", "Caps Lock",
].entries()) usageLabels.set(0x28 + i, label);
for (let i = 1; i <= 12; i++) usageLabels.set(0x39 + i, `F${i}`);
for (const [i, label] of [
  "Print Screen", "Scroll Lock", "Pause", "Insert", "Home", "Page Up", "Delete", "End",
  "Page Down", "Right", "Left", "Down", "Up", "Num Lock", "Num /", "Num *", "Num -",
  "Num +", "Num Enter", "Num 1", "Num 2", "Num 3", "Num 4", "Num 5", "Num 6", "Num 7",
  "Num 8", "Num 9", "Num 0", "Num .", "Non-US \\", "Application",
].entries()) usageLabels.set(0x46 + i, label);
for (const [i, label] of [
  "左 Ctrl", "左 Shift", "左 Alt", "左 GUI", "右 Ctrl", "右 Shift", "右 Alt", "右 GUI",
].entries()) usageLabels.set(0xe0 + i, label);
for (let i = 13; i <= 24; ++i) usageLabels.set(0x68 + i - 13, `F${i}`);
for (const [i, label] of ["ろ", "かな", "¥", "変換", "無変換"].entries()) usageLabels.set(0x87 + i, label);
for (const code of keycodes) {
  const value = packUsage(code);
  if (!usageLabels.has(value)) usageLabels.set(value, keycodeText(code, "us").legend);
}

const usageLabel = output => caps?.actions.get(output) ?? usageLabels.get(output) ??
  keycodeText(unpackUsage(output) || output, "us").code;
const outputSupported = output => caps?.actions.has(output) || supportsUsage(output, caps);
function setOutputOptions() {
  elements.usage.replaceChildren(new Option("出力する動作を選択", ""));
  for (const [usage, label] of usageLabels) {
    const option = new Option(label, usage);
    option.disabled = !supportsUsage(usage, caps);
    elements.usage.add(option);
  }
  for (const [output, name] of caps?.actions ?? []) elements.usage.add(new Option(name, output));
}

let device = null;
let info = null;
let caps = null;
let combos = [];
let editingSlot = null;
let creatingCombo = false;
let comboSyncRequired = null;
let busy = false;
let choosingPort = false;
let legacyUnlock = false;
let connectionVersion = 0;
let backupContext = null;
let recovery = null;
let restoreInProgress = false;
let fileConnection = null;

function notice(message = "", kind = "info") {
  elements.notice.hidden = !message;
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
}

function comboResult(message = "", kind = "info") {
  const result = elements["combo-result"];
  result.hidden = !message;
  result.textContent = message;
  result.dataset.kind = kind;
}

function numbers(input) {
  const text = input.value.trim();
  return text ? text.split(/[,、\s]+/).map(value => /^\d+$/.test(value) ? Number(value) : NaN) : [];
}

function positions() {
  return numbers(elements.positions);
}

function validPosition(position) {
  return !!info && Number.isInteger(position) && position >= 0 && position < info.count;
}

function selectedCombo() {
  return combos.find(combo => combo.slot === editingSlot);
}

function hasUnsavedCombo() {
  return !comboSyncRequired && draft().dirty;
}

function warnBeforeUnload(event) {
  if (!hasUnsavedCombo() && !editors.hasDraft()) return;
  event.preventDefault();
  event.returnValue = "";
}

function draft() {
  const selected = positions();
  const output = Number(elements.usage.value);
  const timeout = Number(elements["combo-timeout"].value);
  const idle = Number(elements["combo-idle"].value);
  const layerIds = new Set(numbers(elements.layers));
  const layersValid = [...layerIds].every(layer => layer >= 0 && layer < caps?.layerCount);
  const layers = layersValid ? [...layerIds].reduce((mask, layer) => mask + 2 ** layer, 0) : 0;
  const slow = Number(elements["slow-release"].checked);
  const canonical = [...selected].sort((a, b) => a - b);
  const samePositions = combo => combo.positions.length === canonical.length &&
    combo.positions.every((key, i) => key === canonical[i]);
  const original = selectedCombo();
  const unchangedChord = original && original.layers === layers && samePositions(original);
  const duplicate = !unchangedChord && combos.some(combo => combo.slot !== editingSlot && samePositions(combo) &&
    (!combo.layers || !layers || (combo.layers & layers)));
  const valid = selected.length >= 2 && selected.length <= (caps?.maxKeys ?? 2) &&
      selected.every(validPosition) && new Set(selected).size === selected.length && output > 0 &&
      Number.isInteger(timeout) && timeout > 0 && timeout <= 65535 &&
      elements["combo-idle"].value !== "" && Number.isInteger(idle) && idle >= 0 && idle <= 65535 && layersValid;
  const dirty = creatingCombo || !!original &&
    (!valid || !unchangedChord || output !== original.output || timeout !== original.timeout ||
      idle !== original.idle || slow !== original.slow);
  return { canonical, output, timeout, idle, layers, slow, duplicate, valid, dirty,
    outputSupported: outputSupported(output) };
}

function canEdit() {
  return !!device && !busy && !comboSyncRequired && info?.status === "active";
}

function refreshEditor() {
  const editable = canEdit();
  const open = creatingCombo || editingSlot !== null;
  const values = positions();
  const selected = new Set(values.filter(validPosition));
  const data = draft();
  const extended = !!caps && !caps.legacy;
  elements["selection-count"].textContent = `${selected.size} / ${caps?.maxKeys ?? 2} 選択`;
  elements["editor-heading"].textContent = creatingCombo ? "新しいコンボ" :
    editingSlot === null ? "コンボの詳細" : `コンボ ${editingSlot}`;
  elements["editor-form"].hidden = !open;
  elements["combo-empty-detail"].hidden = open;
  elements["combo-empty-detail"].textContent = !device ? "USB で接続するか、デモを試してください。" :
    info?.status === "invalid" ? "設定を初期化するとコンボを編集できます。" :
      canEdit() ? "一覧からコンボを選ぶか、「追加」で作成してください。" :
        "設定を読み込むとコンボの詳細を表示できます。";
  const status = elements["combo-draft-state"];
  status.hidden = !open;
  status.dataset.dirty = String(data.dirty && !comboSyncRequired);
  const statusText = comboSyncRequired ? "保存済み・確認待ち" : data.dirty ? "未保存の変更あり" :
    info?.status === "pending" ? "保存済み・適用待ち" : "保存済み";
  if (status.textContent !== statusText) status.textContent = statusText;
  elements["combo-nav-dirty"].hidden = !data.dirty || comboSyncRequired;
  if (data.dirty && !comboSyncRequired) elements["show-combos"].setAttribute("aria-label", "コンボ（未保存の変更あり）");
  else elements["show-combos"].removeAttribute("aria-label");
  elements.clear.textContent = creatingCombo ? "追加を取り消す" : "変更を取り消す";
  elements.clear.disabled = !editable || !data.dirty;
  elements["combo-delete"].hidden = editingSlot === null;
  elements["combo-delete"].disabled = !editable;
  elements["combo-new"].disabled = !editable || creatingCombo || combos.length >= info.slots;
  elements.usage.disabled = !editable;
  elements["combo-pick-usage"].disabled = !editable;
  elements.save.disabled = !editable || !data.dirty || !data.valid || !data.outputSupported;
  elements.positions.disabled = !editable;
  elements["combo-scope"].hidden = !extended;
  elements.layers.disabled = !editable || !extended;
  elements["combo-layer-hint"].textContent = extended ?
    `0〜${caps.layerCount - 1} をカンマ区切りで入力。空欄は全レイヤー。` : "";
  elements.options.hidden = !extended;
  for (const control of elements.options.querySelectorAll("input")) {
    control.disabled = !editable || !extended;
  }
  for (const button of elements.keyboard.querySelectorAll("button")) {
    button.disabled = !editable;
    button.setAttribute("aria-pressed", String(selected.has(Number(button.dataset.position))));
  }
}

function showCombo(combo, create = false) {
  if (!combo || editingSlot !== combo.slot) elements.options.open = false;
  editingSlot = combo?.slot ?? null;
  creatingCombo = create;
  elements.positions.value = combo?.positions.join(", ") ?? "";
  setUsageValue(elements.usage, combo?.output, combo ? usageLabel(combo.output) : "", combo && outputSupported(combo.output));
  elements["combo-timeout"].value = combo?.timeout ?? info?.timeout ?? 50;
  elements["combo-idle"].value = combo?.idle ?? 0;
  elements.layers.value = layerIds(combo?.layers).join(", ");
  elements["slow-release"].checked = !!combo?.slow;
}

function layerIds(mask) {
  return Array.from({ length: caps?.layerCount ?? 0 }, (_, layer) => layer)
    .filter(layer => mask & (1 << layer));
}

function selectPosition(position) {
  if (!canEdit()) return;
  const selected = [...new Set(positions().filter(validPosition))];
  const existing = selected.indexOf(position);
  if (existing >= 0) selected.splice(existing, 1);
  else if (selected.length < caps.maxKeys) selected.push(position);
  else {
    comboResult(`選択できるキーは最大 ${caps.maxKeys} 個です。選択済みのキーを外してください。`, "error");
    return;
  }
  elements.positions.value = selected.join(", ");
  comboResult();
  refreshEditor();
}

function bounds(keys) {
  const corners = keys.flatMap(key => {
    const angle = key.rotation * Math.PI / 18000;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [0, key.width].flatMap(dx => [0, key.height].map(dy => {
      const x = key.x + dx - key.rx;
      const y = key.y + dy - key.ry;
      return { x: key.rx + x * cos - y * sin, y: key.ry + x * sin + y * cos };
    }));
  });
  const x = Math.min(...corners.map(corner => corner.x)) - 6;
  const y = Math.min(...corners.map(corner => corner.y)) - 6;
  return {
    x, y,
    width: Math.max(...corners.map(corner => corner.x)) - x + 6,
    height: Math.max(...corners.map(corner => corner.y)) - y + 6,
  };
}

function drawKeyboard(keyboard, keys, preview, select, label) {
  const area = bounds(keys);
  keyboard.toggleAttribute("data-preview", preview);
  keyboard.toggleAttribute("inert", preview);
  keyboard.style.aspectRatio = `${area.width} / ${area.height}`;
  keyboard.style.setProperty("--minimum-width", preview ? "0px" : `${area.width * 0.29}px`);
  keyboard.replaceChildren(...keys.map(key => {
    const element = document.createElement(preview ? "div" : "button");
    element.className = "physical-key";
    if (key.encoder !== undefined) element.classList.add("physical-encoder");
    const gapX = Math.min(key.width * .07, 5);
    const gapY = Math.min(key.height * .07, 5);
    element.style.left = `${100 * (key.x + gapX - area.x) / area.width}%`;
    element.style.top = `${100 * (key.y + gapY - area.y) / area.height}%`;
    element.style.width = `${100 * (key.width - 2 * gapX) / area.width}%`;
    element.style.height = `${100 * (key.height - 2 * gapY) / area.height}%`;
    if (key.rotation) {
      element.style.transform = `rotate(${key.rotation / 100}deg)`;
      element.style.transformOrigin = `${100 * (key.rx - key.x - gapX) / (key.width - 2 * gapX)}% ${100 * (key.ry - key.y - gapY) / (key.height - 2 * gapY)}%`;
    }
    if (!preview) {
      element.type = "button";
      element.dataset.position = key.position;
      const display = label(key.position);
      if (typeof display === "object") {
        fillKeycap(element, display);
        element.title = [display.legend, display.code].filter(Boolean).join(" · ");
      } else {
        element.textContent = display;
      }
      const name = key.encoder === undefined ? `物理位置 ${key.position}` : `ロータリーエンコーダー ${key.encoder + 1}`;
      element.setAttribute("aria-label", `${name}${element.title ? " " + element.title : ""}`);
      element.addEventListener("click", () => select(key.position));
    }
    return element;
  }));
}

function positionLabel(combo) {
  return `位置 ${combo.positions.join(" + ")}`;
}

function openCombo(combo, create = false) {
  showCombo(combo, create);
  comboResult();
  renderState();
  elements["editor-heading"].focus();
}

function renderComboRow(combo) {
  const row = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "saved-row";
  button.disabled = busy || !!comboSyncRequired;
  if (combo.slot === editingSlot) button.setAttribute("aria-current", "true");
  const slot = document.createElement("span");
  slot.textContent = `コンボ ${combo.slot}`;
  const chord = document.createElement("strong");
  chord.textContent = `${positionLabel(combo)} → ${usageLabel(combo.output)}`;
  const scope = document.createElement("span");
  scope.textContent = combo.layers ? `レイヤー ${layerIds(combo.layers).join(", ")}` : "全レイヤー";
  button.append(slot, chord, scope);
  button.addEventListener("click", () => {
    if (combo.slot !== editingSlot) {
      confirmDiscard("別のコンボを開くと、いまの編集内容は失われます。", () => openCombo(combo));
    }
  });
  row.append(button);
  return row;
}

function connectionTarget(attached) {
  if (!attached) return "";
  if (attached instanceof DemoDevice) return "サンプルキーボード";
  const { usbVendorId, usbProductId } = attached.port.getInfo();
  if (usbVendorId === undefined || usbProductId === undefined) return "ZDKM 専用ポート";
  const ids = [usbVendorId, usbProductId].map(id => id.toString(16).padStart(4, "0"));
  return `ZDKM 専用ポート · ${ids.join(":")}`;
}

function renderState() {
  const demo = device instanceof DemoDevice;
  const awaitingUnlock = elements["unlock-dialog"].open;
  const connection = elements["connection-state"];
  connection.textContent = demo ? "デモモード" : awaitingUnlock ? "ロック解除待ち" : device ? "USB 接続中" :
    choosingPort ? "ポート選択待ち" : busy ? "接続を処理中" : "未接続";
  connection.dataset.state = demo ? "demo" : awaitingUnlock ? "working" : device ? "online" : busy ? "working" : "offline";
  const target = connectionTarget(device);
  elements["connection-target"].textContent = target;
  elements["connection-target"].hidden = !target;
  elements.connect.textContent = device && !demo ? "切断" : choosingPort ? "キャンセル" : "USB で接続";
  elements.connect.disabled = !supportsSerial || demo || (busy && !device && !choosingPort);
  elements.demo.textContent = demo ? "デモを終了" : "デモを試す";
  elements.demo.disabled = busy || (!!device && !demo);
  elements["backup-export"].disabled = !backupContext || busy;
  elements["backup-import"].disabled = !backupContext || busy;
  elements["backup-recovery"].hidden = !recovery;
  elements["demo-notice"].hidden = !demo;
  elements["legacy-unlock-notice"].hidden = !legacyUnlock;
  for (const id of ["save", "map-save", "macro-save"]) {
    elements[id].textContent = demo ? "デモに保存" : "キーボードに保存";
  }
  elements.refresh.disabled = !device || busy;
  elements.recovery.hidden = info?.status !== "invalid";
  elements.reset.disabled = busy || !!comboSyncRequired;
  elements["slot-count"].textContent = info ? `${combos.length} / ${info.slots} 件` : "";
  elements["list-empty"].hidden = !!combos.length || info?.status === "invalid";
  elements["list-empty"].textContent = info ? "保存済みコンボはありません。" :
    device ? "コンボを読み込んでいます。" : "キーボードは未接続です。";
  elements["combo-list"].replaceChildren(...combos.map(renderComboRow));
  refreshEditor();
  editors.refresh();
}

async function disconnect(message = "", kind = "info") {
  if (kind === "error" && (hasUnsavedCombo() || editors.hasDraft())) {
    message += " 編集中の内容は画面から失われました。";
  }
  const previous = device;
  const version = ++connectionVersion;
  device = null;
  info = null;
  caps = null;
  backupContext = null;
  combos = [];
  comboSyncRequired = null;
  choosingPort = false;
  legacyUnlock = false;
  busy = !!previous;
  if (elements["unlock-dialog"].open) elements["unlock-dialog"].close("disconnect");
  editors.setConnection(null, [], 0);
  if (elements["delete-dialog"].open) elements["delete-dialog"].close("cancel");
  if (elements["discard-dialog"].open) elements["discard-dialog"].close("cancel");
  if (elements["backup-dialog"].open) elements["backup-dialog"].close("cancel");
  showCombo();
  comboResult();
  setOutputOptions();
  elements.keyboard.replaceChildren();
  renderState();
  notice(message, kind);
  if (previous) await previous.close();
  if (version === connectionVersion) {
    busy = false;
    renderState();
  }
}

function showInfoStatus() {
  if (info.status === "pending") notice("保存済みの設定が適用待ちです。すべてのキーを離して再読み込みしてください。");
  else if (info.status === "loading") notice("キーボードが設定を読み込み中です。少し待ってから再読み込みしてください。");
  else if (info.status === "invalid") notice("キーボードの保存済みコンボが現在の設定と互換性がありません。", "error");
}

async function loadDevice(attached, version) {
  const current = await attached.info();
  const capabilities = await attached.capabilities();
  const keys = await attached.layout(current.count);
  const saved = await attached.combos(current, capabilities);
  const editorCaps = await attached.editorCapabilities();
  const encoders = editorCaps ? await attached.encoderLayout() : [];
  if (version !== connectionVersion) return;
  info = current;
  caps = capabilities;
  backupContext = editorCaps && !capabilities.legacy && current.count <= 256
    ? { caps, keys, features: editorCaps, encoders } : null;
  combos = saved;
  editors.setConnection(editorCaps, keys, capabilities.layerCount, encoders, capabilities);
  setOutputOptions();
  showCombo(combos[0]);
  drawKeyboard(elements.keyboard, keys, false, selectPosition, position => position);
  notice();
  showInfoStatus();
}

async function startDemo() {
  if (device instanceof DemoDevice && !busy) {
    await disconnect(supportsSerial ? "" : unavailableSerial, "info");
    return;
  }
  if (device || busy) return;
  const version = ++connectionVersion;
  busy = true;
  const sample = new DemoDevice();
  device = sample;
  renderState();
  try {
    await loadDevice(sample, version);
  } catch {
    if (version === connectionVersion) await disconnect("デモを読み込めませんでした。", "error");
  } finally {
    if (version === connectionVersion) {
      busy = false;
      renderState();
      editors.loadPage();
    }
  }
}

async function unlockOnConnect(attached, version) {
  const supported = await attached.supportsSessionUnlock();
  if (version !== connectionVersion) return false;
  if (!supported) {
    legacyUnlock = true;
    return true;
  }
  const dialog = elements["unlock-dialog"];
  const message = elements["unlock-status"];
  const retry = elements["unlock-retry"];
  dialog.returnValue = "cancel";
  dialog.showModal();
  renderState();
  while (dialog.open && version === connectionVersion) {
    retry.hidden = true;
    message.textContent = "キーボードに解除をリクエストしています。";
    try {
      await attached.unlockSession(prompt => {
        if (dialog.open && version === connectionVersion) {
          message.textContent = prompt;
        }
      });
    } catch (error) {
      if (!dialog.open || version !== connectionVersion) return false;
      if (error instanceof ConnectionError) throw error;
      message.textContent = error.message;
      retry.hidden = false;
      retry.focus();
      const again = await new Promise(resolve => {
        const listeners = new AbortController();
        const finish = result => {
          listeners.abort();
          resolve(result);
        };
        retry.addEventListener("click", () => finish(true), { signal: listeners.signal });
        dialog.addEventListener("close", () => finish(false), { signal: listeners.signal });
      });
      if (!again) return false;
      continue;
    }
    if (!dialog.open || version !== connectionVersion) return false;
    dialog.close("unlocked");
    return true;
  }
  return false;
}

async function connect() {
  busy = true;
  choosingPort = true;
  const version = ++connectionVersion;
  renderState();
  notice("ブラウザーのポート選択画面で ZDKM 専用ポートを選んでください。");
  const chooserReminder = setTimeout(() => {
    if (version === connectionVersion && choosingPort) {
      notice("ポート選択画面が見えない場合は、Chrome のウィンドウ上部と、このサイトのシリアルポートの権限を確認してください。", "error");
    }
  }, 8000);
  try {
    // Call the picker before awaiting anything so Chrome keeps the click's user activation.
    const port = await navigator.serial.requestPort();
    if (version !== connectionVersion) return;
    choosingPort = false;
    renderState();
    notice("選択した USB ポートを開いています。");
    const attached = await SerialDevice.open(port);
    if (version !== connectionVersion) {
      await attached.close();
      return;
    }
    device = attached;
    renderState();
    if (!await unlockOnConnect(attached, version) || version !== connectionVersion) return;
    renderState();
    notice("物理キーの配置を読み込んでいます。");
    await loadDevice(attached, version);
  } catch (error) {
    if (version !== connectionVersion) return;
    if (error.name === "NotFoundError") {
      await disconnect("ポートが選択されませんでした。USB 接続を確認し、もう一度選択してください。");
    } else if (error.name === "SecurityError" || error.name === "NotAllowedError") {
      await disconnect("ブラウザーがシリアルポート選択を許可しませんでした。このサイトのポート権限を確認してください。", "error");
    } else {
      await disconnect(error instanceof ConnectionError ? error.message : "ポート選択画面を開けませんでした。ページを読み直して再試行してください。", "error");
    }
  } finally {
    clearTimeout(chooserReminder);
    if (version === connectionVersion) {
      choosingPort = false;
      busy = false;
      renderState();
      editors.loadPage();
    }
  }
}

async function run(operation, reportError) {
  const attached = device;
  if (!attached || busy) return;
  busy = true;
  renderState();
  notice();
  try {
    await operation(attached);
  } catch (error) {
    if (device !== attached) return;
    const message = reportError?.(error) ?? error.message;
    if (error instanceof ConnectionError) await disconnect(message, "error");
    else if (!reportError) notice(message, "error");
  } finally {
    if (device === attached) {
      busy = false;
      renderState();
    }
  }
}

function downloadBackup(backup, prefix) {
  const blob = new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${prefix}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showBackupProgress(attached, message) {
  return (index, count) => {
    if (device === attached) notice(`${message}（レイヤー ${index} / ${count}）`);
  };
}

function confirmRestore(count) {
  const dialog = elements["backup-dialog"];
  const draft = hasUnsavedCombo() || editors.hasDraft() ? "実行すると編集中の変更は破棄されます。" : "";
  elements["backup-description"].textContent =
    `キーボードの設定をファイルの内容で上書きします（${count} 件の書き込み）。${draft}`;
  dialog.returnValue = "cancel";
  return new Promise(resolve => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
    dialog.showModal();
  });
}

async function importBackup(file) {
  let refreshed = false;
  await run(async attached => {
    const context = backupContext;
    notice("設定ファイルを確認しています。");
    const desired = await readBackupFile(file);
    if (device !== attached) return;
    const previous = await captureBackup(attached, context, showBackupProgress(attached, "現在の設定を読み込み中"));
    if (device !== attached) return;
    const changes = planRestore(previous, desired);
    if (!changes.length) {
      notice("設定ファイルの内容は現在の設定と同じです。");
      return;
    }
    if (previous.compatibility.firmware !== null) {
      notice("キーボードで書き込み内容を検証しています。");
      for (const change of changes) {
        if (device !== attached) return;
        if (!change.check) continue;
        try {
          await attached.checkRestoreCommand(change.check);
        } catch (error) {
          if (error instanceof ConnectionError) throw error;
          throw new Error(`${change.label}を復元できません。 ${error.message}`, { cause: error });
        }
      }
    }
    if (device !== attached || !await confirmRestore(changes.length) || device !== attached) {
      if (device === attached) notice();
      return;
    }

    const target = JSON.stringify(desired);
    const port = attached.port ?? attached;
    if (recovery?.target !== target || recovery.port !== port) {
      recovery = { backup: previous, target, port };
    }
    restoreInProgress = true;
    renderState();
    let completed = 0;
    try {
      for (const change of changes) {
        if (device !== attached) return;
        notice(`設定を復元中（${completed + 1} / ${changes.length}）`);
        await attached.save(change.command, (message, phase) => {
          if (device === attached && phase !== "saved") notice(message);
        });
        ++completed;
        if (change.combo) await settledInfo(attached);
      }
      const restored = await captureBackup(attached, context, showBackupProgress(attached, "復元した設定を確認中"));
      if (device !== attached) return;
      if (planRestore(restored, desired).length) throw new Error("読み戻した設定がファイルの内容と一致しません。");
      await loadDevice(attached, connectionVersion);
      refreshed = device === attached;
      if (device === attached) notice("設定を復元しました。", "success");
    } catch (error) {
      if (device !== attached) return;
      if (!(error instanceof ConnectionError)) {
        await loadDevice(attached, connectionVersion).then(() => {
          refreshed = device === attached;
        }).catch(() => {});
      }
      const message = `復元が途中で止まりました（${completed} / ${changes.length} 件の書き込みを確認）。` +
        `同じファイルで再試行するか、「復元前の設定を書き出す」で元の設定を保存できます。 ${error.message}`;
      if (error instanceof ConnectionError) throw new ConnectionError(message, { cause: error });
      throw new Error(message, { cause: error });
    } finally {
      restoreInProgress = false;
    }
  });
  if (refreshed) {
    const { textContent, dataset: { kind } } = elements.notice;
    editors.loadPage();
    notice(textContent, kind);
  }
}

async function reload() {
  await run(async attached => {
    comboResult("保存済みコンボを読み込んでいます。");
    const current = await attached.info();
    const saved = await attached.combos(current, caps);
    if (device !== attached) return;
    updateSavedCombos(current, saved, comboSyncRequired ? comboSyncRequired.slot : editingSlot);
    comboResult("保存済みコンボを再読み込みしました。", "success");
    showInfoStatus();
  }, error => reportComboError("再読み込み", error));
}

function updateSavedCombos(current, saved, slot) {
  info = current;
  combos = saved;
  comboSyncRequired = null;
  showCombo(saved.find(combo => combo.slot === slot) ?? saved[0]);
}

function reportComboError(operation, error) {
  const message = comboSyncRequired ?
    `保存は完了しましたが、一覧を確認できませんでした。 ${error.message}` :
    error instanceof ConnectionError ? `${operation}の結果を確認できませんでした。再接続して保存済み一覧を確認してください。 ${error.message}` :
      `${operation}に失敗しました。 ${error.message}`;
  comboResult(message, "error");
  return message;
}

async function change(command, operation, slot = null) {
  await run(async attached => {
    comboResult(`${operation}しています。`);
    await attached.save(command, (message, phase) => {
      if (device === attached && phase !== "saved") comboResult(message);
    });
    if (device !== attached) return;
    comboSyncRequired = { slot };
    refreshEditor();
    comboResult("保存を確認しました。適用状態と一覧を確認しています。");
    const deadline = Date.now() + 5000;
    let current = await attached.info();
    while (current.status === "pending" && Date.now() < deadline) {
      await delay(150);
      current = await attached.info();
    }
    const saved = await attached.combos(current, caps);
    if (device !== attached) return;
    updateSavedCombos(current, saved, slot);
    if (current.status === "active") {
      const target = slot === null ? "" : `コンボ ${slot} を`;
      comboResult(`${target}${operation}しました。`, "success");
    } else if (current.status === "pending") {
      comboResult("保存済みの設定が適用待ちです。すべてのキーを離し、再読み込みしてください。");
    } else {
      comboResult("書き込みは完了しました。再読み込みして適用状態を確認してください。");
      showInfoStatus();
    }
    elements["editor-heading"].focus();
  }, error => reportComboError(operation, error));
}

function confirmDiscard(message, proceed, includeOtherEditors = false) {
  if (!hasUnsavedCombo() && !(includeOtherEditors && editors.hasDraft())) {
    proceed();
    return;
  }
  const dialog = elements["discard-dialog"];
  elements["discard-description"].textContent = message;
  dialog.returnValue = "cancel";
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm") proceed();
  }, { once: true });
  dialog.showModal();
}

function confirmChange(title, message, command, operation, slot = null) {
  const dialog = elements["delete-dialog"];
  elements["delete-heading"].textContent = title;
  elements["delete-description"].textContent = hasUnsavedCombo() ? `${message} 未保存の変更も失われます。` : message;
  dialog.querySelector('[value="confirm"]').textContent = command === "RESET" ? "初期化する" : "削除する";
  dialog.returnValue = "cancel";
  const attached = device;
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm" && device === attached) void change(command, operation, slot);
  }, { once: true });
  dialog.showModal();
}

elements.connect.addEventListener("click", () => {
  if (device || choosingPort) {
    confirmDiscard("切断すると、いまの編集内容は失われます。", () => { void disconnect(); }, true);
  } else {
    void connect();
  }
});
elements["unlock-dialog"].addEventListener("close", event => {
  if (event.currentTarget.returnValue === "cancel") void disconnect("ロック解除をキャンセルしたため、切断しました。");
});
elements.demo.addEventListener("click", () => {
  confirmDiscard("デモを終了すると、いまの編集内容は失われます。", () => { void startDemo(); }, true);
});
elements["backup-export"].addEventListener("click", () => {
  void run(async attached => {
    const backup = await captureBackup(attached, backupContext, showBackupProgress(attached, "設定を読み込み中"));
    if (device !== attached) return;
    downloadBackup(backup, "zdkm-settings");
    notice("設定を書き出しました。", "success");
  });
});
elements["backup-import"].addEventListener("click", () => {
  fileConnection = device;
  const field = elements["backup-file"];
  field.value = "";
  field.click();
});
elements["backup-file"].addEventListener("change", event => {
  const file = event.target.files[0];
  if (file && backupContext && device === fileConnection) void importBackup(file);
  fileConnection = null;
});
elements["backup-recovery"].addEventListener("click", () => {
  if (recovery) downloadBackup(recovery.backup, "zdkm-before-restore");
});
elements.refresh.addEventListener("click", () => {
  confirmDiscard("再読み込みすると、いまの編集内容は失われます。", () => { void reload(); });
});
elements["combo-new"].addEventListener("click", () => {
  confirmDiscard("新しいコンボを開くと、いまの編集内容は失われます。", () => openCombo(null, true));
});
elements["combo-pick-usage"].addEventListener("click", () => {
  if (canEdit()) editors.chooseUsage("コンボの出力キーを選ぶ", elements.usage);
});
elements.clear.addEventListener("click", () => {
  openCombo(selectedCombo() ?? combos[0]);
});
elements["editor-form"].addEventListener("input", () => {
  comboResult();
  refreshEditor();
});
elements["editor-form"].addEventListener("submit", event => {
  event.preventDefault();
  if (!canEdit()) return;
  const data = draft();
  if (!data.valid || !data.dirty || !data.outputSupported) return;
  if (data.duplicate) {
    comboResult("同じ位置の組み合わせが対象レイヤーにあります。一覧から編集してください。", "error");
    return;
  }
  const slot = editingSlot ?? Array.from({ length: info.slots }, (_, index) => index)
    .find(index => !combos.some(combo => combo.slot === index));
  if (slot === undefined) return;
  const keys = data.canonical.join(" ");
  const command = caps.legacy ? `SET ${slot} ${keys} ${data.output}` :
    `PUT ${slot} ${data.output} ${data.timeout} ${data.idle} ${data.layers} ${data.slow} ${keys}`;
  void change(command, "保存", slot);
});
elements["combo-delete"].addEventListener("click", () => {
  const combo = selectedCombo();
  if (!canEdit() || !combo) return;
  confirmChange("コンボを削除", `コンボ ${combo.slot}（${positionLabel(combo)} → ${usageLabel(combo.output)}）を削除します。`,
    `DEL ${combo.slot}`, "削除", combo.slot);
});
elements.reset.addEventListener("click", () => {
  const message = device instanceof DemoDevice ? "デモのコンボを初期状態に戻します。" :
    "GUI で保存したコンボ設定を取り消し、ファームウェアの初期設定に戻します。";
  confirmChange("コンボ設定を初期化", message, "RESET", "初期化");
});
const editors = setupEditors({
  elements, drawKeyboard, usageLabels, run, notice,
  state: () => ({ device, busy, info }),
});
window.addEventListener("beforeunload", warnBeforeUnload);
if (supportsSerial) {
  navigator.serial.addEventListener("disconnect", event => {
    if (device && (event.port ?? event.target) === device.port) {
      const message = restoreInProgress ?
        "復元中に USB 接続が切れました。再接続して同じファイルで再試行するか、復元前の設定を書き出してください。" :
        comboSyncRequired ? "保存は完了しました。USB 接続が切れたため、再接続して一覧を確認してください。" :
        "キーボードの USB 接続が切れました。再接続して保存済み一覧を確認してください。";
      void disconnect(message, "error");
    }
  });
} else {
  notice(unavailableSerial, "info");
}
setOutputOptions();
showCombo();
renderState();
