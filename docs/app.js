import { ConnectionError, SerialDevice, delay } from "./serial.js?v=stock-combos";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(node => [node.id, node]));
const supportsSerial = window.isSecureContext && typeof navigator.serial?.requestPort === "function";
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

const usageLabel = output => caps?.actions.get(output) ?? usageLabels.get(output) ?? `HID 0x${output.toString(16)}`;
function setOutputOptions() {
  elements.usage.replaceChildren(new Option("出力する動作を選択", ""));
  for (const [usage, label] of usageLabels) elements.usage.add(new Option(label, usage));
  for (const [output, name] of caps?.actions ?? []) elements.usage.add(new Option(name, output));
}

const previewKeys = [];
for (let row = 0; row < 3; row++) {
  for (let column = 0; column < 12; column++) {
    const offset = column < 6 ? 0 : 134;
    previewKeys.push({
      x: column * 100 + offset, y: row * 100 + (column % 6) * 4,
      width: 100, height: 100, rotation: 0, rx: 0, ry: 0,
    });
  }
}
for (const [i, x] of [300, 400, 500, 734, 834, 934].entries()) {
  previewKeys.push({ x, y: 320 + (i % 3) * 5, width: 100, height: 100, rotation: 0, rx: 0, ry: 0 });
}

let device = null;
let info = null;
let caps = null;
let combos = [];
let editingSlot = null;
let busy = false;
let choosingPort = false;
let connectionVersion = 0;

function notice(message = "", kind = "info") {
  elements.notice.hidden = !message;
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
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
  const original = combos.find(combo => combo.slot === editingSlot);
  const unchangedChord = original && original.layers === layers && samePositions(original);
  const duplicate = !unchangedChord && combos.some(combo => combo.slot !== editingSlot && samePositions(combo) &&
    (!combo.layers || !layers || (combo.layers & layers)));
  return {
    canonical, output, timeout, idle, layers, slow, duplicate,
    valid: selected.length >= 2 && selected.length <= (caps?.maxKeys ?? 2) &&
      selected.every(validPosition) && new Set(selected).size === selected.length && output > 0 &&
      Number.isInteger(timeout) && timeout > 0 && timeout <= 65535 &&
      Number.isInteger(idle) && idle >= 0 && idle <= 65535 && layersValid,
  };
}

function canEdit() {
  return !!device && !busy && info?.status === "active";
}

function refreshEditor() {
  const editable = canEdit();
  const values = positions();
  const selected = new Set(values.filter(validPosition));
  const data = draft();
  elements["selection-count"].textContent = `${selected.size} / ${caps?.maxKeys ?? 2} 選択`;
  elements["editor-heading"].textContent = editingSlot === null ? "コンボを作成" : "コンボを編集";
  elements.clear.textContent = editingSlot === null ? "選択をクリア" : "編集をキャンセル";
  elements.clear.disabled = !editable;
  elements.usage.disabled = !editable;
  elements.save.disabled = !editable || !data.valid || (editingSlot === null && combos.length >= info.slots);
  elements.positions.disabled = !editable;
  elements.options.hidden = !caps || caps.legacy;
  for (const control of elements.options.querySelectorAll("input")) {
    control.disabled = !editable || caps.legacy;
  }
  for (const button of elements.keyboard.querySelectorAll("button")) {
    button.disabled = !editable;
    button.setAttribute("aria-pressed", String(selected.has(Number(button.dataset.position))));
  }
}

function resetEditor() {
  editingSlot = null;
  elements.positions.value = "";
  elements.usage.value = "";
  elements["combo-timeout"].value = info?.timeout ?? 50;
  elements["combo-idle"].value = 0;
  elements.layers.value = "";
  elements["slow-release"].checked = false;
}

function selectPosition(position) {
  if (!canEdit()) return;
  const selected = [...new Set(positions().filter(validPosition))];
  const existing = selected.indexOf(position);
  if (existing >= 0) selected.splice(existing, 1);
  else if (selected.length < caps.maxKeys) selected.push(position);
  else {
    notice(`選択できるキーは最大 ${caps.maxKeys} 個です。選択済みのキーを外してください。`, "error");
    return;
  }
  elements.positions.value = selected.join(", ");
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

function renderKeyboard(keys, preview = false) {
  const area = bounds(keys);
  const keyboard = elements.keyboard;
  keyboard.toggleAttribute("data-preview", preview);
  keyboard.toggleAttribute("inert", preview);
  keyboard.style.aspectRatio = `${area.width} / ${area.height}`;
  keyboard.style.setProperty("--minimum-width", preview ? "0px" : `${area.width * 0.29}px`);
  keyboard.replaceChildren(...keys.map(key => {
    const element = document.createElement(preview ? "div" : "button");
    element.className = "physical-key";
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
      element.textContent = key.position;
      element.setAttribute("aria-label", `物理位置 ${key.position}`);
      element.addEventListener("click", () => selectPosition(key.position));
    }
    return element;
  }));
  elements["keyboard-placeholder"].hidden = !preview;
}

function action(label, style, callback) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.className = `${style} compact`;
  button.disabled = !canEdit();
  button.addEventListener("click", callback);
  return button;
}

function edit(combo) {
  editingSlot = combo.slot;
  elements.positions.value = combo.positions.join(", ");
  elements.usage.value = combo.output;
  elements["combo-timeout"].value = combo.timeout;
  elements["combo-idle"].value = combo.idle;
  elements.layers.value = Array.from({ length: caps.layerCount }, (_, layer) => layer)
    .filter(layer => combo.layers & (1 << layer)).join(", ");
  elements["slow-release"].checked = !!combo.slow;
  renderState();
  elements.positions.focus();
}

function renderState() {
  const connection = elements["connection-state"];
  connection.textContent = device ? "USB 接続中" : choosingPort ? "ポート選択待ち" : busy ? "接続を処理中" : "未接続";
  connection.dataset.state = device ? "online" : busy ? "working" : "offline";
  elements.connect.textContent = device ? "切断" : choosingPort ? "キャンセル" : "USB で接続";
  elements.connect.disabled = !supportsSerial || (busy && !device && !choosingPort);
  elements["device-details"].hidden = !info;
  elements.refresh.disabled = !device || busy;
  elements.recovery.hidden = info?.status !== "invalid";
  elements.reset.disabled = busy;
  if (info) {
    elements["position-count"].textContent = info.count;
    elements.timeout.textContent = `${info.timeout} ms`;
  }
  elements["slot-count"].textContent = info ? `${combos.length} / ${info.slots} 件` : "接続すると一覧を表示します。";
  elements["list-empty"].hidden = !!combos.length || info?.status === "invalid";
  elements["list-empty"].textContent = info ? "保存済みコンボはありません。" : "キーボードは未接続です。";
  elements["combo-list"].replaceChildren(...combos.map(combo => {
    const row = document.createElement("li");
    row.className = "combo-row";
    row.dataset.selected = String(combo.slot === editingSlot);
    const description = document.createElement("div");
    description.className = "combo-description";
    const name = document.createElement("strong");
    name.textContent = usageLabel(combo.output);
    const keys = document.createElement("span");
    keys.textContent = `位置 ${combo.positions.join(" + ")}`;
    description.append(name, keys);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      action("編集", "secondary", () => edit(combo)),
      action("削除", "danger", () => {
        confirmChange("コンボを削除", `位置 ${combo.positions.join(" + ")} のコンボを削除します。`, `DEL ${combo.slot}`);
      }),
    );
    row.append(description, actions);
    return row;
  }));
  refreshEditor();
}

async function disconnect(message = "", kind = "info") {
  const previous = device;
  const version = ++connectionVersion;
  device = null;
  info = null;
  caps = null;
  combos = [];
  choosingPort = false;
  busy = !!previous;
  if (elements["delete-dialog"].open) elements["delete-dialog"].close("cancel");
  resetEditor();
  setOutputOptions();
  renderKeyboard(previewKeys, true);
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
    notice("物理キーの配置を読み込んでいます。");
    const current = await attached.info();
    const capabilities = await attached.capabilities();
    const keys = await attached.layout(current.count);
    const saved = await attached.combos(current, capabilities);
    if (version !== connectionVersion) return;
    info = current;
    caps = capabilities;
    combos = saved;
    setOutputOptions();
    resetEditor();
    renderKeyboard(keys);
    notice();
    showInfoStatus();
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
    }
  }
}

async function run(operation) {
  const attached = device;
  if (!attached || busy) return;
  busy = true;
  renderState();
  notice();
  try {
    await operation(attached);
  } catch (error) {
    if (device !== attached) return;
    if (error instanceof ConnectionError) await disconnect(error.message, "error");
    else notice(error.message, "error");
  } finally {
    if (device === attached) {
      busy = false;
      renderState();
    }
  }
}

async function reload() {
  await run(async attached => {
    const current = await attached.info();
    const saved = await attached.combos(current, caps);
    if (device !== attached) return;
    info = current;
    combos = saved;
    if (editingSlot !== null && !combos.some(combo => combo.slot === editingSlot)) resetEditor();
    showInfoStatus();
  });
}

async function change(command) {
  await run(async attached => {
    await attached.save(command, message => {
      if (device === attached) notice(message);
    });
    const deadline = Date.now() + 5000;
    let current = await attached.info();
    while (current.status === "pending" && Date.now() < deadline) {
      await delay(150);
      current = await attached.info();
    }
    const saved = await attached.combos(current, caps);
    if (device !== attached) return;
    info = current;
    combos = saved;
    resetEditor();
    notice(info.status === "active" ? "変更をキーボードに保存して適用しました。" : "");
    showInfoStatus();
  });
}

function confirmChange(title, message, command) {
  const dialog = elements["delete-dialog"];
  elements["delete-heading"].textContent = title;
  elements["delete-description"].textContent = message;
  dialog.querySelector('[value="confirm"]').textContent = command === "RESET" ? "初期化する" : "削除する";
  dialog.returnValue = "cancel";
  const attached = device;
  dialog.addEventListener("close", () => {
    if (dialog.returnValue === "confirm" && device === attached) void change(command);
  }, { once: true });
  dialog.showModal();
}

elements.connect.addEventListener("click", () => { void (device || choosingPort ? disconnect() : connect()); });
elements.refresh.addEventListener("click", () => { void reload(); });
elements.clear.addEventListener("click", () => {
  resetEditor();
  renderState();
  elements.positions.focus();
});
for (const input of [elements.positions, elements.usage, ...elements.options.querySelectorAll("input")]) {
  input.addEventListener("input", refreshEditor);
}
elements["editor-form"].addEventListener("submit", event => {
  event.preventDefault();
  if (!canEdit()) return;
  const data = draft();
  if (!data.valid) return;
  if (data.duplicate) {
    notice("同じ位置の組み合わせが対象レイヤーにあります。一覧から編集してください。", "error");
    return;
  }
  const slot = editingSlot ?? Array.from({ length: info.slots }, (_, index) => index)
    .find(index => !combos.some(combo => combo.slot === index));
  if (slot === undefined) return;
  const keys = data.canonical.join(" ");
  const command = caps.legacy ? `SET ${slot} ${keys} ${data.output}` :
    `PUT ${slot} ${data.output} ${data.timeout} ${data.idle} ${data.layers} ${data.slow} ${keys}`;
  void change(command);
});
elements.reset.addEventListener("click", () => {
  confirmChange("コンボ設定を初期化", "GUI で保存したコンボ設定を取り消し、ファームウェアの初期設定に戻します。", "RESET");
});
if (supportsSerial) {
  navigator.serial.addEventListener("disconnect", event => {
    if (device && (event.port ?? event.target) === device.port) {
      void disconnect("キーボードの USB 接続が切れました。", "error");
    }
  });
} else {
  notice("Web Serial が利用できません。デスクトップ版 Chrome または Edge で HTTPS または localhost から開いてください。", "error");
}
setOutputOptions();
resetEditor();
renderKeyboard(previewKeys, true);
renderState();
