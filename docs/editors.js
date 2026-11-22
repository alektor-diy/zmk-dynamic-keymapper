import { fillKeycap, fullSizeKeys, keycodes, keycodeText } from "./keycodes.js?v=keyboard-palette";
import { ConnectionError } from "./serial.js?v=gui-renewal";

const MACRO_OPERATIONS = ["タップ", "押す", "離す", "待つ"];
const PAGES = ["keymap", "combos", "macros"];
const LAYOUT_SETTING = "zdkm-keyboard-layout";
const nameEncoder = new TextEncoder();
const supportsRichSelect = CSS.supports("appearance", "base-select") && CSS.supports("selector(::picker(select))");
const specialKeys = new Map([
  ["Transparent", "&trans"],
  ["None", "&none"],
]);

function detailedOption(name, detail, value) {
  if (!detail || !supportsRichSelect) return new Option(detail ? `${name} — ${detail}` : name, value);
  const option = new Option("", value);
  const copy = document.createElement("span");
  copy.className = "option-copy";
  const title = document.createElement("span");
  title.textContent = name;
  const description = document.createElement("small");
  description.textContent = detail;
  copy.append(title, " ", description);
  option.append(copy);
  return option;
}

function setDetailedOptions(select, options) {
  if (!supportsRichSelect) {
    select.replaceChildren(...options);
    return;
  }
  select.classList.add("detail-select");
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.append(document.createElement("selectedcontent"));
  select.replaceChildren(trigger, ...options);
}
const hiddenBehaviors = new Set([
  "Auto Mouse Toggle", "Trackball Swap",
  "auto-mouse-del", "auto-mouse-f7", "auto-mouse-f10", "auto-mouse-minus",
]);
const behaviorDescriptions = new Map([
  ["Key Press", "指定したキーを入力"],
  ["Mod-Tap", "長押しとタップで別のキーを入力"],
  ["Key Toggle", "指定キーの押下と解放を切り替え"],
  ["Sticky Key", "次の入力まで指定キーを保持"],
  ["Grave/Escape", "通常は Esc、Shift や GUI と押すと Grave"],
  ["Caps Word", "単語を大文字で入力"],
  ["Key Repeat", "直前のキー入力を繰り返す"],
  ["Mouse Key Press", "マウスのボタンを押す"],
  ["ZDKM Macro", "保存したマクロを実行"],
  ["Momentary Layer", "押している間だけレイヤーを有効化"],
  ["Layer-Tap", "長押しでレイヤー、タップでキー入力"],
  ["Toggle Layer", "レイヤーの有効・無効を切り替え"],
  ["Sticky Layer", "次の入力までレイヤーを有効化"],
  ["To Layer", "指定レイヤーへ切り替え"],
  ["Transparent", "下の有効レイヤーの割り当てを使う"],
  ["None", "この位置の入力を無効化"],
  ["Bluetooth", "Bluetooth の接続先やペアリングを操作"],
  ["Output Selection", "キー入力の出力先を USB または BLE に設定"],
  ["Reset", "キーボードを再起動"],
  ["Bootloader", "ファームウェアの書き込みモードに入る"],
  ["Studio Unlock", "ZMK Studio の設定ロックを解除"],
  ["zdkm_unlock", "ZDKM の設定書き込みを許可"],
  ["Backlight", "キーのバックライトを操作"],
  ["Underglow", "本体下部の RGB ライトを操作"],
  ["External Power", "外部電源出力を操作"],
]);

function keySequence(keys) {
  const points = keys.map(key => {
    const angle = key.rotation * Math.PI / 18000;
    const dx = key.x + key.width / 2 - key.rx;
    const dy = key.y + key.height / 2 - key.ry;
    return {
      position: key.position, height: key.height,
      x: key.rx + dx * Math.cos(angle) - dy * Math.sin(angle),
      y: key.ry + dx * Math.sin(angle) + dy * Math.cos(angle),
    };
  }).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows = [];
  for (const key of points) {
    const row = rows.at(-1);
    if (row && key.y - row[0].y < Math.min(key.height, row[0].height) / 2) row.push(key);
    else rows.push([key]);
  }
  return rows.flatMap(row => row.sort((a, b) => a.x - b.x || a.y - b.y).map(key => key.position));
}

export function setupEditors({ elements, drawKeyboard, usageLabels, run, notice, state }) {
  let page = "keymap";
  let keyboardLayout = "us";
  try {
    if (localStorage.getItem(LAYOUT_SETTING) === "jis") keyboardLayout = "jis";
  } catch {
    // Layout switching also works when browser storage is unavailable.
  }
  let features = null;
  let keys = [];
  let encoders = [];
  let keyOrder = [];
  let layerCount = 0;
  let layers = null;
  let behaviors = new Map();
  let layer = null;
  let bindings = [];
  let encoderBindings = [];
  let position = null;
  let activeKeyParameter = null;
  let savedMapDraft = "";
  let mapSyncRequired = false;
  let slot = null;
  let macroRecords = null;
  let steps = null;
  let macroDirty = false;
  let macroSyncRequired = false;

  function result(editor, text = "", kind = "info") {
    const item = elements[`${editor}-result`];
    item.textContent = text;
    item.hidden = !text;
    item.dataset.kind = kind;
  }

  function reportError(editor, error, acknowledged) {
    const message = acknowledged ?
      `書き込みを確認しました。再読み込みして現在の設定を確認してください。 ${error.message}` :
      error instanceof ConnectionError ? `処理結果を確認できませんでした。 ${error.message}` : error.message;
    result(editor, message, "error");
    return message;
  }

  function mapDraft() {
    const fields = elements["map-parameters"].querySelectorAll("[data-parameter]");
    return JSON.stringify([elements["map-behavior"].value, ...Array.from(fields, field =>
      field.hasAttribute("data-key-parameter") ? [field.value, field.dataset.keyValue] : field.value)]);
  }

  function mapDirty() {
    return position !== null && !mapSyncRequired && mapDraft() !== savedMapDraft;
  }

  function macroHasDraft() {
    return !macroSyncRequired && (macroDirty || (slot !== null && !macroRecords?.has(slot)));
  }

  function layerNameDirty() {
    return !elements["rename-layer-form"].hidden &&
      elements["layer-name"].value.trim() !== layers?.find(entry => entry.id === layer)?.savedName;
  }

  function hasDraft() {
    return mapDirty() || macroHasDraft() || layerNameDirty();
  }

  function markNavDraft(pageName, marker, name, dirty) {
    elements[marker].hidden = !dirty;
    if (dirty) elements[pageName].setAttribute("aria-label", `${name}（未保存の変更あり）`);
    else elements[pageName].removeAttribute("aria-label");
  }

  function button(label, handler, style = "secondary") {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `${style} compact`;
    item.textContent = label;
    item.addEventListener("click", handler);
    return item;
  }

  function editable() {
    const { device, busy, info } = state();
    return !!(features && device && !busy && info?.status !== "loading");
  }

  function keyText(value) {
    return keycodeText(value, keyboardLayout);
  }

  function keyOption(value) {
    const { legend, code } = keyText(value);
    return legend === code ? legend : `${legend} · ${code}`;
  }

  const encoderPosition = index => `encoder-${index}`;
  const selectedEncoder = () => encoders.find(item => item.position === position);

  function bindingText(binding) {
    if (!binding || binding.id === 65535) return { legend: "—" };
    const { id, parameters } = binding;
    if (id === features.keyPress) return keyText(parameters[0]);
    if (id === features.macro) return { legend: `マクロ ${parameters[0]}` };
    const behavior = behaviors.get(id);
    if (!behavior) return { legend: `Behavior ${id}` };
    const codes = [];
    const args = parameters.flatMap((value, i) => {
      const kind = behavior.parameters[i];
      if (!kind && !value) return [];
      if (kind === 2) {
        const { legend, code } = keyText(value);
        codes.push(code);
        return [legend];
      }
      return [value];
    });
    return { legend: [behavior.name, ...args].join(" "), code: codes.join(" ") };
  }

  function refresh() {
    const { device, busy, info } = state();
    const available = !!device && (page === "combos" || (!!features && info?.status !== "loading"));
    for (const name of PAGES) {
      const control = elements[`show-${name}`];
      control.setAttribute("aria-pressed", String(name === page));
      control.disabled = busy;
      elements[`${name}-panel`].hidden = name !== page || !available;
    }
    const availability = elements["editor-availability"];
    availability.hidden = available;
    availability.textContent = !device ? "USB でキーボードを接続してください。" :
      !features ? "この画面を使うには新しい ZDKM ファームウェアが必要です。" :
        "キーボードの設定を読み込み中です。コンボ画面で再読み込みしてください。";

    const enabled = editable();
    elements["map-refresh"].disabled = !enabled;
    elements["rename-layer"].hidden = !features?.layerNameBytes;
    elements["rename-layer"].disabled = !enabled || layer === null;
    for (const control of elements["rename-layer-form"].querySelectorAll("button, input")) {
      control.disabled = !enabled;
    }
    updateLayerName();
    for (const group of ["map-layers", "map-keyboard", "map-encoders", "map-form"]) {
      for (const control of elements[group].querySelectorAll("button, select, input")) {
        control.disabled = !enabled || control.hasAttribute("data-unavailable");
      }
    }
    const encoder = selectedEncoder();
    const detail = elements["map-assignment"].open;
    const canPick = position !== null && ((encoder || detail) && activeKeyParameter !== null ||
      behaviors.get(features?.keyPress)?.editable);
    for (const key of elements["map-form"].querySelectorAll(".palette-key")) {
      const available = key.dataset.special ? !encoder && position !== null &&
        specialBehavior(key.dataset.special) !== undefined : canPick;
      key.disabled = !enabled || mapSyncRequired || !available;
    }
    elements["map-save"].disabled = !enabled || mapSyncRequired || !mapDirty();
    elements["map-cancel"].disabled = !enabled || mapSyncRequired || !mapDirty();
    for (const control of elements["map-assignment"].querySelectorAll("select, input")) {
      control.disabled = !enabled || mapSyncRequired;
    }
    if (encoder) elements["map-behavior"].disabled = true;
    for (const row of elements["macro-list"].querySelectorAll("button")) row.disabled = !enabled || macroSyncRequired;
    elements["macro-refresh"].disabled = !enabled;
    elements["macro-new"].disabled = !enabled || macroSyncRequired || !macroRecords || macroRecords.size >= features.macroSlots ||
      (slot !== null && !macroRecords.has(slot));
    elements["macro-delete"].disabled = !enabled || macroSyncRequired || slot === null;
    elements["macro-add"].disabled = !enabled || macroSyncRequired || !steps || steps.length >= (features?.macroSteps ?? 0);
    elements["macro-save"].disabled = !enabled || macroSyncRequired || !macroDirty || !steps?.length;
    elements["macro-cancel"].disabled = !enabled || !macroHasDraft();
    const macroState = elements["macro-draft-state"];
    macroState.hidden = slot === null;
    const changed = macroHasDraft();
    markNavDraft("show-keymap", "map-nav-dirty", "キーマップ", mapDirty() || layerNameDirty());
    markNavDraft("show-macros", "macro-nav-dirty", "マクロ", changed);
    const label = macroSyncRequired ? "保存済み・確認待ち" : changed ? "未保存の変更あり" :
      macroRecords?.get(slot) === null ? "読み込みエラー" : "保存済み";
    macroState.dataset.dirty = String(changed);
    if (macroState.textContent !== label) macroState.textContent = label;
    for (const control of elements["macro-steps"].querySelectorAll("button, select, input")) {
      control.disabled = !enabled || macroSyncRequired || control.hasAttribute("data-unavailable");
    }
  }

  function setConnection(capabilities, layout, count, encoderLayout = []) {
    features = capabilities;
    keys = layout;
    encoders = encoderLayout.map(item => ({ ...item, position: encoderPosition(item.encoder) }));
    keyOrder = keySequence(layout);
    layerCount = count;
    layers = null;
    behaviors.clear();
    layer = null;
    position = null;
    activeKeyParameter = null;
    savedMapDraft = "";
    mapSyncRequired = false;
    bindings = [];
    encoderBindings = [];
    slot = null;
    macroRecords = null;
    steps = null;
    macroDirty = false;
    macroSyncRequired = false;
    result("map");
    result("macro");
    macroStatus("");
    updateMapSelection();
    closeLayerRename();
    drawPaletteTargets();
    markPalette();
    for (const id of ["map-layers", "map-keyboard", "map-encoders", "macro-steps"]) elements[id].replaceChildren();
    elements["map-encoders"].hidden = true;
    elements["macro-list"].replaceChildren();
    elements["macro-form"].hidden = true;
    elements["macro-list-empty"].hidden = false;
    elements["macro-list-empty"].textContent = "保存済みマクロを読み込んでいます。";
    elements["map-assignment"].open = false;
    elements["macro-capacity"].textContent = "";
    if (elements["macro-delete-dialog"].open) elements["macro-delete-dialog"].close("cancel");
    if (!features && layout.length) page = "combos";
  }

  function drawPhysicalKeys() {
    const choose = key => {
      if (key === position || !discardMapDraft()) return;
      if (!mapSyncRequired) result("map");
      selectKey(key);
    };
    const placed = encoders.filter(item => item.x !== undefined);
    drawKeyboard(elements["map-keyboard"], [...keys, ...placed], false, choose, key => {
      if (typeof key === "number") return bindingText(bindings[key]);
      const encoder = placed.find(item => item.position === key);
      return { legend: "↻ ↺", code: encoderText(encoder.encoder) };
    });
    const controls = encoders.filter(item => item.x === undefined && encoderBindings[item.encoder]);
    elements["map-encoders"].hidden = !controls.length;
    elements["map-encoders"].replaceChildren(...controls.map(({ encoder, position: key }) => {
      const item = button(`ロータリーエンコーダー ${encoder + 1}`, () => choose(key));
      item.dataset.position = key;
      item.title = encoderText(encoder);
      return item;
    }));
    markKey();
  }

  function encoderText(index) {
    const current = encoderBindings[index];
    if (!current) return "—";
    const [clockwise, counterclockwise] = current.parameters.map(keyOption);
    return `↻ ${clockwise} / ↺ ${counterclockwise}`;
  }

  function drawLayers() {
    elements["map-layers"].replaceChildren(...layers.map(entry => {
      const item = button(entry.name, () => openKeymap(entry.id));
      item.setAttribute("aria-pressed", String(layer === entry.id));
      return item;
    }));
  }

  function drawKeymap() {
    drawLayers();
    drawPhysicalKeys();
  }

  async function loadKeymap(attached, requested, updateCatalog) {
    const available = !layers || updateCatalog ? await attached.keymapLayers(layerCount, features.layerNameBytes) : layers;
    const catalog = !layers || updateCatalog ? await attached.keymapBehaviors(features.behaviorCount) : behaviors;
    if (attached !== state().device) return;
    const selected = available.some(entry => entry.id === requested) ? requested : available[0]?.id;
    const current = [];
    if (selected === undefined) {
      notice("編集できるレイヤーがありません。", "error");
      return;
    }
    for (const key of keys) {
      if (attached !== state().device) return;
      current[key.position] = key.position <= 255 ? await attached.binding(selected, key.position) : null;
    }
    const rotations = [];
    for (const { encoder } of encoders) {
      if (attached !== state().device) return;
      rotations[encoder] = await attached.encoderBinding(selected, encoder);
    }
    if (attached !== state().device) return;
    layers = available;
    behaviors = catalog;
    const encoder = selectedEncoder();
    if (layer !== selected || (encoder && !rotations[encoder.encoder])) {
      if (encoder) elements["map-assignment"].open = false;
      position = null;
      activeKeyParameter = null;
      closeLayerRename();
      drawPaletteTargets();
      markPalette();
    }
    layer = selected;
    bindings = current;
    encoderBindings = rotations;
    mapSyncRequired = false;
    drawKeymap();
    if (position !== null && canAssign(position)) selectKey(position);
    else {
      position = null;
      activeKeyParameter = null;
      updateMapSelection();
      markPalette();
    }
    if (updateCatalog) closeLayerRename();
  }

  function openKeymap(requested = layer, updateCatalog = false) {
    if (!editable() || (requested === layer && !updateCatalog && layers) || !discardMapDraft(true)) return;
    void run(async attached => {
      await loadKeymap(attached, requested, updateCatalog);
      if (attached === state().device) result("map", updateCatalog ? "キーマップを再読み込みしました。" : "");
    });
  }

  function canAssign(key) {
    const encoder = encoders.find(item => item.position === key);
    if (encoder) return !!encoderBindings[encoder.encoder];
    const binding = bindings[key];
    return !!binding && behaviors.get(binding.id)?.name.toLowerCase().replace(/[ _-]/g, "") !== "zdkmunlock";
  }

  function discardMapDraft(includeLayerName = false) {
    const rename = includeLayerName && layerNameDirty();
    return !(mapDirty() || rename) || window.confirm("保存していないキーマップの変更を取り消しますか？");
  }

  function markKey() {
    for (const item of document.querySelectorAll("#map-keyboard button, #map-encoders button")) {
      const value = item.dataset.position;
      const key = /^\d+$/.test(value) ? Number(value) : value;
      item.setAttribute("aria-pressed", String(key === position));
      item.toggleAttribute("data-unavailable", !canAssign(key));
    }
  }

  function closeLayerRename() {
    elements["rename-layer-form"].hidden = true;
    elements["rename-layer"].setAttribute("aria-expanded", "false");
  }

  function updateLayerName() {
    const name = elements["layer-name"].value.trim();
    const bytes = nameEncoder.encode(name);
    const max = features?.layerNameBytes ?? 0;
    elements["layer-name-size"].textContent = `${bytes.length} / ${max} バイト (UTF-8)`;
    elements["save-layer-name"].disabled = !editable() || !bytes.length || bytes.length > max ||
      /[\x00-\x1f\x7f]/.test(name) || name === layers?.find(entry => entry.id === layer)?.savedName;
    return bytes;
  }

  function paramLabel(kind, index, id) {
    if (selectedEncoder()) return index === 0 ? "時計回り" : "反時計回り";
    const behavior = behaviors.get(id)?.name;
    if (id === features.macro) return "マクロ枠";
    if (behavior === "Mod-Tap") return index === 0 ? "長押しのキー" : "タップのキー";
    if (behavior === "Layer-Tap") return index === 0 ? "長押しのレイヤー" : "タップのキー";
    if (kind === 3) return "対象レイヤー";
    if (kind === 2 && id === features.keyPress) return "キー";
    return `${kind === 2 ? "キー " : "パラメーター "}${index + 1}`;
  }

  const normalizeQuery = value => value.normalize("NFKC").toLowerCase().trim();

  function parameterValue(field) {
    return field.hasAttribute("data-key-parameter") ? field.dataset.keyValue ?? "" : field.value;
  }

  function closeKeySuggestions(field) {
    field.parentElement.querySelector(".key-suggestions").hidden = true;
    field.setAttribute("aria-expanded", "false");
    field.removeAttribute("aria-activedescendant");
  }

  function setKeyParameter(field, code) {
    if (code === undefined) delete field.dataset.keyValue;
    else field.dataset.keyValue = code;
    field.value = code === undefined ? "" : keyText(code).code;
    field.setCustomValidity("");
    closeKeySuggestions(field);
  }

  function setupKeyParameter(group, field, label, value, index) {
    group.classList.add("key-parameter");
    field.type = "text";
    field.autocomplete = "off";
    field.spellcheck = false;
    field.placeholder = "キー名・コードを入力";
    field.dataset.keyParameter = index;
    const popup = document.createElement("div");
    popup.className = "key-suggestions";
    const list = document.createElement("div");
    list.id = `${field.id}-suggestions`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${label.textContent}の候補`);
    const empty = document.createElement("p");
    empty.className = "key-no-match";
    empty.textContent = "一致するキーがありません。";
    empty.setAttribute("role", "status");
    popup.append(list, empty);
    group.append(label, field, popup);
    field.setAttribute("role", "combobox");
    field.setAttribute("aria-autocomplete", "list");
    field.setAttribute("aria-controls", list.id);
    setKeyParameter(field, value);

    let active = -1;
    const choose = code => {
      setKeyParameter(field, code);
      field.focus();
      markPalette();
      showMapDraft();
    };
    const showSuggestions = () => {
      const query = normalizeQuery(field.value);
      active = -1;
      field.removeAttribute("aria-activedescendant");
      if (!query) {
        closeKeySuggestions(field);
        return;
      }
      const choices = [];
      const exact = [];
      for (const code of keycodes) {
        const { legend, shifted, code: name } = keyText(code);
        const hidName = usageLabels.get(code - 0x070000);
        const parts = [name, legend, shifted, hidName, `0x${code.toString(16)}`].filter(Boolean).map(normalizeQuery);
        if (parts[0] === query) exact.push(code);
        else if (parts.some(part => part.includes(query))) choices.push(code);
      }
      list.replaceChildren(...[...exact, ...choices].map((code, optionIndex) => {
        const { legend, code: name } = keyText(code);
        const option = document.createElement("div");
        option.id = `${list.id}-${optionIndex}`;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", "false");
        option.textContent = name === legend ? name : `${name} · ${legend}`;
        option.addEventListener("mousedown", event => event.preventDefault());
        option.addEventListener("click", () => choose(code));
        return option;
      }));
      empty.hidden = !!list.children.length;
      list.hidden = !list.children.length;
      popup.hidden = false;
      field.setAttribute("aria-expanded", "true");
    };
    field.addEventListener("focus", () => {
      setActiveKeyParameter(index);
      if (!parameterValue(field)) showSuggestions();
    });
    field.addEventListener("blur", () => closeKeySuggestions(field));
    field.addEventListener("input", () => {
      delete field.dataset.keyValue;
      field.setCustomValidity(field.value ? "候補からキーを選んでください。" : "");
      if (document.activeElement === field) showSuggestions();
    });
    field.addEventListener("keydown", event => {
      if (event.isComposing) return;
      if (event.key === "Escape" && !popup.hidden) {
        event.preventDefault();
        closeKeySuggestions(field);
      } else if (event.key === "Enter" && !popup.hidden) {
        event.preventDefault();
        (list.children[active] ?? list.firstElementChild)?.click();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        if (popup.hidden) showSuggestions();
        if (!list.children.length || popup.hidden) return;
        event.preventDefault();
        list.children[active]?.setAttribute("aria-selected", "false");
        const direction = event.key === "ArrowDown" ? 1 : -1;
        active = Math.min(list.children.length - 1, Math.max(0, active + direction));
        const option = list.children[active];
        option.setAttribute("aria-selected", "true");
        field.setAttribute("aria-activedescendant", option.id);
        option.scrollIntoView({ block: "nearest" });
      }
    });
  }

  function setActiveKeyParameter(index) {
    activeKeyParameter = index;
    for (const target of elements["map-palette-targets"].querySelectorAll("button")) {
      target.setAttribute("aria-pressed", String(Number(target.dataset.target) === index));
    }
    markPalette();
  }

  function makeParameter(kind, value, index, id) {
    const group = document.createElement("div");
    const picker = kind === 3 || id === features.macro;
    const field = document.createElement(picker ? "select" : "input");
    field.id = `map-param-${index}`;
    field.dataset.parameter = index;
    field.required = true;
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = paramLabel(kind, index, id);
    if (kind === 2) {
      setupKeyParameter(group, field, label, value, index);
      return group;
    }
    if (picker) {
      const options = id === features.macro ?
        Array.from({ length: features.macroSlots }, (_, i) => [i, `マクロ ${i}`]) :
        layers.map(entry => [entry.id, entry.name]);
      if (value === undefined) field.add(new Option("選択してください", ""));
      else if (!options.some(([code]) => code === value)) {
        field.add(new Option(`0x${value.toString(16)}`, value));
      }
      for (const [code, text] of options) field.add(new Option(text, code));
      field.value = value ?? "";
    } else {
      field.type = "number";
      field.min = "0";
      field.max = "4294967295";
      field.step = "1";
      field.value = value ?? 0;
    }
    group.append(label, field);
    return group;
  }

  function drawPaletteTargets(id) {
    const group = elements["map-palette-targets"];
    const indexes = selectedEncoder() ? [0, 1] :
      behaviors.get(id)?.parameters.flatMap((kind, index) => kind === 2 ? [index] : []) ?? [];
    group.hidden = position === null || !elements["map-assignment"].open || id === features?.keyPress || !indexes.length;
    const label = document.createElement("span");
    label.textContent = "パレットの入力先";
    group.replaceChildren(label, ...indexes.map(index => {
      const target = button(paramLabel(2, index, id), () => setActiveKeyParameter(index));
      target.dataset.target = index;
      target.setAttribute("aria-pressed", String(index === activeKeyParameter));
      return target;
    }));
  }

  function setBindingDraft(id, values = [], preferred = null) {
    const select = elements["map-behavior"];
    select.value = id ?? "";
    const types = selectedEncoder() ? [2, 2] : behaviors.get(id)?.parameters ?? [];
    elements["map-parameters"].replaceChildren(...types.flatMap((kind, index) =>
      kind ? [makeParameter(kind, values[index], index, id)] : []));
    const first = types.indexOf(2);
    activeKeyParameter = types[preferred] === 2 ? preferred : first < 0 ? null : first;
    drawPaletteTargets(id);
    refresh();
    markPalette();
  }

  function refreshBindingInputs() {
    const selected = elements["map-behavior"].value;
    const values = [];
    const group = elements["map-parameters"];
    const queries = [];
    for (const field of group.querySelectorAll("[data-parameter]")) {
      const value = parameterValue(field);
      const index = Number(field.dataset.parameter);
      if (value !== "") values[index] = Number(value);
      else if (field.hasAttribute("data-key-parameter") && field.value) queries.push([index, field.value]);
    }
    setBindingDraft(selected === "" ? undefined : Number(selected), values, activeKeyParameter);
    for (const [index, query] of queries) {
      const field = group.querySelector(`[data-key-parameter="${index}"]`);
      field.value = query;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function markPalette() {
    const binding = bindings[position];
    const detail = elements["map-assignment"].open;
    const parameter = elements["map-parameters"].querySelector(`[data-key-parameter="${activeKeyParameter}"]`);
    const code = detail && parameter ? parameterValue(parameter) :
      binding?.id === features?.keyPress ? String(binding?.parameters[0]) : undefined;
    const behavior = detail ? elements["map-behavior"].value : binding?.id;
    for (const entry of elements["map-form"].querySelectorAll(".palette-key")) {
      const special = entry.dataset.special;
      const id = special ? specialBehavior(special) : undefined;
      const selected = special ? id !== undefined && String(id) === String(behavior) : entry.dataset.code === code;
      entry.setAttribute("aria-pressed", String(position !== null && selected));
    }
  }

  function updateMapSelection() {
    const selected = position !== null;
    const encoder = selectedEncoder();
    elements["map-assignment"].hidden = !selected;
    elements["map-assignment"].toggleAttribute("data-encoder", !!encoder);
    elements["map-assignment-title"].textContent = encoder ? "回転方向の割り当て" : "動作の詳細設定";
    elements["map-behavior-field"].hidden = !!encoder;
    elements["map-auto-label"].hidden = !!encoder;
    const current = bindingText(bindings[position]);
    const description = [...new Set([current.legend, current.code].filter(Boolean))].join(" · ");
    elements["map-current"].textContent = encoder ? `ロータリーエンコーダー ${encoder.encoder + 1} · 現在 ${encoderText(encoder.encoder)}` : selected ?
      `位置 ${position} · 現在 ${description}` :
      "上のキーボードから変更するキーを選んでください。";
  }

  function selectKey(key) {
    if (!canAssign(key)) return;
    const previousEncoder = selectedEncoder();
    position = key;
    markKey();
    updateMapSelection();
    const encoder = selectedEncoder();
    if (encoder) {
      elements["map-assignment"].open = true;
      setBindingDraft(undefined, encoderBindings[encoder.encoder].parameters);
      savedMapDraft = mapDraft();
      refresh();
      return;
    }
    if (previousEncoder) elements["map-assignment"].open = false;
    const current = bindings[key];
    const select = elements["map-behavior"];
    const catalog = [...behaviors].filter(([, behavior]) => behavior.editable && !hiddenBehaviors.has(behavior.name))
      .sort(([, a], [, b]) => a.name.localeCompare(b.name));
    setDetailedOptions(select, [new Option("選択してください", ""), ...catalog.map(([id, { name }]) =>
      detailedOption(name, behaviorDescriptions.get(name) ?? "ファームウェア固有の動作", id))]);
    const canReplace = catalog.some(([id]) => id === current.id);
    setBindingDraft(canReplace ? current.id : undefined, current.parameters);
    savedMapDraft = mapDraft();
    refresh();
  }

  async function applyBinding(id, params, advance = false, initiator = null) {
    if (!editable() || mapSyncRequired || position === null) return;
    const target = position;
    const targetLayer = layer;
    const encoder = selectedEncoder();
    const name = encoder ? `ロータリーエンコーダー ${encoder.encoder + 1}` : `位置 ${target}`;
    const current = encoder ? encoderBindings[encoder.encoder] : bindings[target];
    const matches = existing => existing && (encoder || existing.id === id) &&
      params.every((value, index) => existing.parameters[index] === value);
    const complete = (saved, unchanged = false) => {
      if (encoder) encoderBindings[encoder.encoder] = saved;
      else bindings[target] = saved;
      const next = advance ? keyOrder.slice(keyOrder.indexOf(target) + 1).find(canAssign) : undefined;
      if (!unchanged) drawPhysicalKeys();
      selectKey(next ?? target);
      const message = unchanged ? `${name} は同じ割り当てです。` : `${name} の割り当てを保存しました。`;
      const progression = !advance ? "" : next === undefined ? " このレイヤーの最後のキーです。" : ` 次は位置 ${next} です。`;
      result("map", message + progression, unchanged ? "info" : "success");
    };
    if (matches(current)) {
      complete(current, true);
      return;
    }
    await run(async attached => {
      result("map", `${name} の割り当てを保存しています。`);
      const command = encoder ? `ENCODERSET ${targetLayer} ${encoder.encoder}` : `BINDSET ${targetLayer} ${target} ${id}`;
      await attached.save(`${command} ${params.join(" ")}`, (message, phase) => {
        if (attached === state().device && phase !== "saved") result("map", message);
      });
      if (attached !== state().device) return;
      mapSyncRequired = true;
      const saved = encoder ? await attached.encoderBinding(targetLayer, encoder.encoder) : await attached.binding(targetLayer, target);
      if (attached !== state().device) return;
      if (!matches(saved)) throw new Error("キーボードの割り当てが保存内容と一致しません。");
      mapSyncRequired = false;
      complete(saved);
    }, error => {
      if (!mapSyncRequired && advance) {
        elements["map-assignment"].open = true;
        setBindingDraft(id, params);
      }
      return reportError("map", error, mapSyncRequired);
    });
    if (initiator && !initiator.disabled) initiator.focus({ preventScroll: true });
    refresh();
  }

  function renderPalette() {
    const groups = fullSizeKeys(keyboardLayout);
    const shown = new Set();
    const caps = groups.map((group, index) => {
      const block = document.createElement("div");
      block.className = "palette-block";
      block.style.setProperty("--columns", [60, 12, 16][index]);
      for (const { code, column, row, width, height } of group) {
        shown.add(code);
        const entry = paletteKey(code);
        entry.dataset.row = row;
        entry.style.gridArea = `${row} / ${column} / span ${height} / span ${width}`;
        entry.toggleAttribute("data-jis-enter", keyboardLayout === "jis" && index === 0 && height === 2);
        block.append(entry);
      }
      return block;
    });
    elements["map-palette"].replaceChildren(...caps);
    elements["map-extra-keys"].replaceChildren(...keycodes.filter(code => !shown.has(code)).map(paletteKey));
    elements["map-special-keys"].replaceChildren(...Array.from(specialKeys, ([name, code]) => {
      const entry = button("", () => {
        const id = specialBehavior(name);
        if (id !== undefined) assignFromPalette(id, [0, 0], entry);
      });
      entry.classList.add("palette-key");
      entry.dataset.special = name;
      entry.title = behaviorDescriptions.get(name);
      fillKeycap(entry, { legend: name, code });
      return entry;
    }));
    elements["map-us"].setAttribute("aria-pressed", String(keyboardLayout === "us"));
    elements["map-jis"].setAttribute("aria-pressed", String(keyboardLayout === "jis"));
    markPalette();
  }

  function specialBehavior(name) {
    const token = name.toLowerCase();
    const code = specialKeys.get(name).slice(1);
    for (const [id, behavior] of behaviors) {
      if (behavior.editable && behavior.parameters.every(kind => !kind) &&
          [token, code].includes(behavior.name.trim().toLowerCase().replace(/^&/, ""))) return id;
    }
  }

  function assignFromPalette(id, params, entry) {
    const detail = elements["map-assignment"];
    if (!detail.open && !discardMapDraft()) return;
    if (!detail.open && elements["map-auto"].checked) {
      void applyBinding(id, params, true, entry);
    } else {
      detail.open = true;
      setBindingDraft(id, params);
      showMapDraft();
    }
  }

  function paletteKey(code) {
    const entry = button("", () => {
      if (selectedEncoder()) elements["map-assignment"].open = true;
      if (!elements["map-assignment"].open || activeKeyParameter === null) {
        assignFromPalette(features.keyPress, [code, 0], entry);
      } else {
        const field = elements["map-parameters"].querySelector(`[data-key-parameter="${activeKeyParameter}"]`);
        setKeyParameter(field, code);
        markPalette();
        showMapDraft();
      }
    });
    entry.classList.add("palette-key");
    entry.dataset.code = code;
    entry.title = keyOption(code);
    fillKeycap(entry, keyText(code));
    return entry;
  }

  function showMapDraft() {
    const dirty = mapDirty();
    result("map", dirty ? "未保存の変更があります。" : "", "dirty");
    refresh();
  }

  function changeLayout(layout) {
    if (keyboardLayout === layout) return;
    keyboardLayout = layout;
    try {
      localStorage.setItem(LAYOUT_SETTING, layout);
    } catch {
      // A browser session can still use the selected layout.
    }
    renderPalette();
    if (layers) drawPhysicalKeys();
    if (position !== null) {
      refreshBindingInputs();
      updateMapSelection();
    }
    refresh();
  }

  function macroStatus(text) {
    elements["macro-status"].textContent = text;
    elements["macro-status"].hidden = !text;
  }

  function currentDraft() {
    const held = new Set();
    for (const { op, value } of steps) {
      if (op === 3) {
        if (!Number.isInteger(value) || value < 1 || value > 5000) return null;
      } else if (!usageLabels.has(value)) {
        return null;
      } else if (op === 2) {
        if (!held.delete(value)) return null;
      } else if (held.has(value)) {
        return null;
      } else if (op === 1) {
        held.add(value);
      }
    }
    return held.size ? null : steps.map(step => step.op * 65536 + step.value);
  }

  function drawMacro() {
    elements["macro-steps"].replaceChildren(...(steps ?? []).map((step, index) => {
      const row = document.createElement("li");
      row.className = "macro-step";
      const body = document.createElement("div");
      const op = document.createElement("select");
      op.setAttribute("aria-label", `手順 ${index + 1} の操作`);
      op.replaceChildren(...MACRO_OPERATIONS.map((name, code) => new Option(name, code)));
      op.value = step.op;
      op.addEventListener("change", () => {
        const next = Number(op.value);
        if ((step.op === 3) !== (next === 3)) step.value = next === 3 ? 100 : 4;
        step.op = next;
        macroDirty = true;
        drawMacro();
        elements["macro-steps"].children[index].querySelector("select").focus();
      });
      const value = document.createElement(step.op === 3 ? "input" : "select");
      if (step.op === 3) {
        value.type = "number";
        value.min = "1";
        value.max = "5000";
        value.required = true;
        value.setAttribute("aria-label", `手順 ${index + 1} の待機時間 (ms)`);
      } else {
        value.setAttribute("aria-label", `手順 ${index + 1} のキー`);
        setDetailedOptions(value, [...usageLabels.keys()].map(code => {
          const { legend, code: name } = keyText(0x070000 + code);
          return detailedOption(legend, `&kp ${name}`, code);
        }));
      }
      value.value = step.value;
      let field = value;
      if (step.op === 3) {
        field = document.createElement("div");
        field.className = "macro-wait";
        field.append(value, "ms");
      }
      value.addEventListener("input", () => {
        step.value = Number(value.value);
        macroDirty = true;
        refresh();
      });
      const actions = document.createElement("div");
      actions.className = "row-actions";
      for (const [direction, icon, label] of [[-1, "↑", "上へ"], [1, "↓", "下へ"]]) {
        const target = index + direction;
        const move = button(icon, () => {
          [steps[index], steps[target]] = [steps[target], steps[index]];
          macroDirty = true;
          drawMacro();
          elements["macro-steps"].children[target].querySelector("select").focus();
        });
        move.toggleAttribute("data-unavailable", target < 0 || target >= steps.length);
        move.setAttribute("aria-label", `手順 ${index + 1} を${label}`);
        actions.append(move);
      }
      actions.append(button("削除", () => {
        steps.splice(index, 1);
        macroDirty = true;
        if (!steps.length && macroRecords.has(slot)) macroStatus("手順をすべて消す場合は「マクロを削除」を使ってください。");
        drawMacro();
      }, "danger"));
      body.append(op, field, actions);
      row.append(body);
      return row;
    }));
    refresh();
  }

  function showMacro(requested) {
    slot = requested;
    const record = macroRecords.get(slot);
    steps = slot === null ? null : record?.map(step => ({ ...step })) ?? [];
    macroDirty = false;
    const available = [...macroRecords.keys()].sort((a, b) => a - b);
    elements["macro-list"].replaceChildren(...available.map(index => {
      const row = document.createElement("li");
      const entry = button("", () => {
        if (index === slot || !discardMacroDraft()) return;
        result("macro");
        showMacro(index);
        elements["macro-detail-heading"].focus();
      });
      entry.className = "saved-row";
      if (index === slot) entry.setAttribute("aria-current", "true");
      const name = document.createElement("strong");
      name.textContent = `マクロ ${index}`;
      const stored = macroRecords.get(index);
      const summary = document.createElement("span");
      summary.textContent = stored ? stored.slice(0, 3).map(step =>
        step.op === 3 ? `${step.value} ms 待つ` :
          `${keyText(0x070000 + step.value).legend} を${MACRO_OPERATIONS[step.op]}`
      ).join(" → ") + (stored.length > 3 ? " …" : "") : "手順を読み込めません";
      const count = document.createElement("span");
      if (stored) count.textContent = `${stored.length} 手順`;
      entry.append(name, summary);
      if (stored) entry.append(count);
      row.append(entry);
      return row;
    }));
    elements["macro-list-empty"].hidden = !!available.length;
    elements["macro-list-empty"].textContent = "保存済みマクロはありません。";
    elements["macro-capacity"].textContent = `${macroRecords.size} / ${features.macroSlots} 枠を使用中`;
    const creating = slot !== null && !macroRecords.has(slot);
    elements["macro-detail-heading"].textContent = slot === null ? "マクロの詳細" :
      creating ? `新しいマクロ · 枠 ${slot}` : `マクロ ${slot}`;
    elements["macro-form"].hidden = slot === null;
    elements["macro-delete"].hidden = slot === null || creating;
    elements["macro-cancel"].textContent = creating ? "追加を取り消す" : "変更を取り消す";
    macroStatus(slot === null ? "「マクロを追加」から作成できます。" :
      record === null ? "このマクロを読み込めませんでした。手順を追加して保存すると置き換わります。" :
      record === undefined ? "手順を追加して保存してください。" : "");
    drawMacro();
  }

  function openMacros(reload = false) {
    if (editable()) void run(async attached => {
      const records = new Map();
      for (let index = 0; index < features.macroSlots; ++index) {
        const record = await attached.macro(index, features.macroSteps);
        if (attached !== state().device) return;
        if (record === null || record.length) records.set(index, record);
      }
      macroRecords = records;
      macroSyncRequired = false;
      showMacro(records.has(slot) ? slot : records.keys().next().value ?? null);
      if (reload) result("macro", "保存済みマクロを再読み込みしました。", "success");
    }, error => reportError("macro", error, macroSyncRequired));
  }

  function loadPage() {
    if (page === "keymap" && !layers) openKeymap();
    if (page === "macros" && macroRecords === null) openMacros();
  }

  for (const name of PAGES) {
    elements[`show-${name}`].addEventListener("click", () => {
      page = name;
      refresh();
      loadPage();
    });
  }
  elements["map-refresh"].addEventListener("click", () => openKeymap(layer, true));
  elements["rename-layer"].addEventListener("click", () => {
    const current = layers.find(entry => entry.id === layer);
    elements["layer-name"].value = current.savedName;
    elements["rename-layer-form"].hidden = false;
    elements["rename-layer"].setAttribute("aria-expanded", "true");
    updateLayerName();
    elements["layer-name"].select();
  });
  elements["layer-name"].addEventListener("input", () => {
    updateLayerName();
    markNavDraft("show-keymap", "map-nav-dirty", "キーマップ", mapDirty() || layerNameDirty());
  });
  elements["cancel-layer-name"].addEventListener("click", () => {
    closeLayerRename();
    refresh();
    elements["rename-layer"].focus();
  });
  elements["rename-layer-form"].addEventListener("submit", event => {
    event.preventDefault();
    const bytes = updateLayerName();
    if (elements["save-layer-name"].disabled) return;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    void run(async attached => {
      await attached.save(`LAYERSET ${layer} ${hex}`, message => {
        if (attached === state().device) notice(message);
      });
      const saved = await attached.keymapLayers(layerCount, features.layerNameBytes);
      if (attached !== state().device) return;
      layers = saved;
      drawLayers();
      closeLayerRename();
      if (position !== null) refreshBindingInputs();
      notice("レイヤー名を保存しました。");
    });
  });
  elements["map-behavior"].addEventListener("change", event => {
    setBindingDraft(event.target.value ? Number(event.target.value) : undefined);
    showMapDraft();
  });
  elements["map-cancel"].addEventListener("click", () => {
    selectKey(position);
    result("map");
  });
  elements["map-assignment"].addEventListener("toggle", () => {
    drawPaletteTargets(Number(elements["map-behavior"].value));
    markPalette();
    refresh();
  });
  elements["map-us"].addEventListener("click", () => changeLayout("us"));
  elements["map-jis"].addEventListener("click", () => changeLayout("jis"));
  elements["map-parameters"].addEventListener("input", event => {
    if (!event.target.matches("[data-parameter]")) return;
    markPalette();
    showMapDraft();
  });
  elements["map-form"].addEventListener("submit", event => {
    event.preventDefault();
    if (!editable() || position === null || !mapDirty()) return;
    const id = Number(elements["map-behavior"].value);
    const params = [0, 0];
    for (const field of elements["map-parameters"].querySelectorAll("[data-parameter]")) {
      const value = parameterValue(field);
      if (value === "") return;
      params[Number(field.dataset.parameter)] = Number(value);
    }
    void applyBinding(id, params, false, elements["map-save"]);
  });
  function discardMacroDraft() {
    return !macroHasDraft() || window.confirm("保存していないマクロの変更を取り消しますか？");
  }

  elements["macro-refresh"].addEventListener("click", () => {
    if (discardMacroDraft()) openMacros(true);
  });
  elements["macro-new"].addEventListener("click", () => {
    if (!editable() || !discardMacroDraft()) return;
    for (let index = 0; index < features.macroSlots; ++index) {
      if (macroRecords.has(index)) continue;
      result("macro");
      showMacro(index);
      elements["macro-detail-heading"].focus();
      break;
    }
  });
  elements["macro-cancel"].addEventListener("click", () => {
    result("macro");
    showMacro(macroRecords.has(slot) ? slot : macroRecords.keys().next().value ?? null);
  });
  elements["macro-delete"].addEventListener("click", () => {
    if (!editable() || slot === null || !macroRecords.has(slot) || macroSyncRequired) return;
    const dialog = elements["macro-delete-dialog"];
    elements["macro-delete-heading"].textContent = `マクロ ${slot} を削除`;
    elements["macro-delete-draft"].hidden = !macroHasDraft();
    dialog.returnValue = "cancel";
    const device = state().device;
    const target = slot;
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "confirm" || device !== state().device) return;
      void run(async attached => {
        await attached.save(`MACROSET ${target} 0`, (message, phase) => {
          if (attached === state().device && phase !== "saved") result("macro", message);
        });
        if (attached !== state().device) return;
        macroSyncRequired = true;
        const saved = await attached.macro(target, features.macroSteps);
        if (attached !== state().device) return;
        if (!saved || saved.length) throw new Error("マクロが削除されたことを確認できませんでした。");
        macroSyncRequired = false;
        macroRecords.delete(target);
        showMacro(macroRecords.keys().next().value ?? null);
        result("macro", `マクロ ${target} を削除しました。`, "success");
        elements["macro-detail-heading"].focus();
      }, error => reportError("macro", error, macroSyncRequired));
    }, { once: true });
    dialog.showModal();
  });
  elements["macro-add"].addEventListener("click", () => {
    if (!editable() || !steps || steps.length >= features.macroSteps) return;
    steps.push({ op: 0, value: 4 });
    macroDirty = true;
    macroStatus("");
    drawMacro();
    elements["macro-steps"].lastElementChild.querySelector("select").focus();
  });
  elements["macro-form"].addEventListener("submit", event => {
    event.preventDefault();
    if (!editable() || macroSyncRequired || !steps?.length || !macroDirty) return;
    const draft = currentDraft();
    if (!draft) {
      result("macro", "「押す」と「離す」をキーごとに対応させ、待機時間を 1〜5000 ms にしてください。", "error");
      return;
    }
    const target = slot;
    void run(async attached => {
      result("macro", `マクロ ${target} を保存しています。`);
      await attached.save(`MACROSET ${target} ${draft.length} ${draft.join(" ")}`, (message, phase) => {
        if (attached === state().device && phase !== "saved") result("macro", message);
      });
      if (attached !== state().device) return;
      macroSyncRequired = true;
      const saved = await attached.macro(target, features.macroSteps);
      if (attached !== state().device) return;
      if (!saved || saved.length !== draft.length || saved.some((step, index) =>
        step.op * 65536 + step.value !== draft[index])) throw new Error("読み取ったマクロが保存内容と一致しません。");
      macroSyncRequired = false;
      macroRecords.set(target, saved);
      showMacro(target);
      result("macro", `マクロ ${target} を保存しました。`, "success");
      elements["macro-detail-heading"].focus();
    }, error => reportError("macro", error, macroSyncRequired));
  });

  renderPalette();
  updateMapSelection();
  return { setConnection, refresh, loadPage, hasDraft };
}
