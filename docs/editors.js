import { fillKeycap, fullSizeKeys, keycodes, keycodeText } from "./keycodes.js?v=keyboard-palette";

const MACRO_OPERATIONS = ["タップ", "押す", "離す", "待つ"];
const PAGES = ["keymap", "combos", "macros"];
const LAYOUT_SETTING = "zdkm-keyboard-layout";
const nameEncoder = new TextEncoder();
const supportsRichSelect = CSS.supports("appearance", "base-select") && CSS.supports("selector(::picker(select))");

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
  ["zdkm_unlock", "ZDKM での書き込みを1回許可"],
  ["Backlight", "キーのバックライトを操作"],
  ["Underglow", "本体下部の RGB ライトを操作"],
  ["External Power", "外部電源出力を操作"],
]);

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
  let layerCount = 0;
  let layers = null;
  let behaviors = new Map();
  let layer = null;
  let bindings = [];
  let position = null;
  let activeKeyParameter = null;
  let slot = null;
  let macroRecords = null;
  let steps = null;
  let macroDirty = false;

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
    for (const name of PAGES) {
      const control = elements[`show-${name}`];
      control.setAttribute("aria-pressed", String(name === page));
      control.disabled = busy;
      elements[`${name}-panel`].hidden =
        name !== page || (name !== "combos" && (!features || !device || info?.status === "loading"));
    }
    const availability = elements["editor-availability"];
    availability.hidden = page === "combos" || !!(device && features && info?.status !== "loading");
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
    for (const group of ["map-layers", "map-keyboard", "map-form"]) {
      for (const control of elements[group].querySelectorAll("button, select, input")) {
        control.disabled = !enabled || control.hasAttribute("data-unavailable");
      }
    }
    const canPick = position !== null && behaviors.get(features?.keyPress)?.editable;
    for (const key of elements["map-form"].querySelectorAll(".palette-key")) {
      key.disabled = !enabled || (activeKeyParameter === null && !canPick);
    }
    elements["macro-slot"].disabled = !enabled || slot === null;
    elements["macro-refresh"].disabled = !enabled;
    elements["macro-new"].disabled = !enabled || !macroRecords || macroRecords.size >= features.macroSlots ||
      (slot !== null && !macroRecords.has(slot));
    elements["macro-delete"].disabled = !enabled || slot === null;
    elements["macro-add"].disabled = !enabled || !steps || steps.length >= (features?.macroSteps ?? 0);
    elements["macro-save"].disabled = !enabled || !macroDirty || !steps?.length;
    for (const control of elements["macro-steps"].querySelectorAll("button, select, input")) {
      control.disabled = !enabled || control.hasAttribute("data-unavailable");
    }
  }

  function setConnection(capabilities, layout, count) {
    features = capabilities;
    keys = layout;
    layerCount = count;
    layers = null;
    behaviors.clear();
    layer = null;
    position = null;
    activeKeyParameter = null;
    bindings = [];
    slot = null;
    macroRecords = null;
    steps = null;
    macroDirty = false;
    macroStatus("");
    updateMapSelection();
    closeLayerRename();
    drawPaletteTargets();
    markPalette();
    for (const id of ["map-layers", "map-keyboard", "macro-steps"]) elements[id].replaceChildren();
    elements["macro-slot"].replaceChildren();
    elements["macro-capacity"].textContent = "";
    if (elements["macro-delete-dialog"].open) elements["macro-delete-dialog"].close("cancel");
    if (!features && layout.length) page = "combos";
  }

  function drawPhysicalKeys() {
    drawKeyboard(elements["map-keyboard"], keys, false, selectKey, key => bindingText(bindings[key]));
    markKey();
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
    if (attached !== state().device) return;
    layers = available;
    behaviors = catalog;
    if (layer !== selected) {
      position = null;
      activeKeyParameter = null;
      closeLayerRename();
      drawPaletteTargets();
      markPalette();
    }
    layer = selected;
    bindings = current;
    drawKeymap();
    if (position !== null) selectKey(position);
    else updateMapSelection();
  }

  function openKeymap(requested = layer, updateCatalog = false) {
    if (editable()) void run(attached => loadKeymap(attached, requested, updateCatalog));
  }

  function markKey() {
    for (const item of elements["map-keyboard"].querySelectorAll("button")) {
      const key = Number(item.dataset.position);
      item.setAttribute("aria-pressed", String(key === position));
      item.toggleAttribute("data-unavailable", !bindings[key]);
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
    const behavior = behaviors.get(id)?.name;
    if (id === features.macro) return "マクロ枠";
    if (behavior === "Mod-Tap") return index === 0 ? "長押しのキー" : "タップのキー";
    if (behavior === "Layer-Tap") return index === 0 ? "長押しのレイヤー" : "タップのキー";
    if (kind === 3) return "対象レイヤー";
    if (kind === 2 && id === features.keyPress) return "キー";
    return `${kind === 2 ? "キー " : "パラメーター "}${index + 1}`;
  }

  const normalizeQuery = value => value.normalize("NFKC").toLowerCase().trim();

  function keyChoice(value, withBehavior) {
    const { legend, code } = keyText(value);
    return detailedOption(legend, withBehavior ? `&kp ${code}` : code, value);
  }

  function filterKeyOptions(field, query, selected) {
    const terms = normalizeQuery(query).split(/\s+/).filter(Boolean);
    const options = keycodes.filter(code => {
      const { legend, shifted, code: name } = keyText(code);
      const haystack = normalizeQuery([legend, shifted, name, `0x${code.toString(16)}`].join(" "));
      return terms.every(term => haystack.includes(term));
    });
    const choices = selected !== undefined && !options.includes(selected) ? [selected, ...options] : options;
    const placeholder = new Option(choices.length ? "選択してください" : "一致するキーがありません", "");
    setDetailedOptions(field, [placeholder, ...choices.map(code =>
      keyChoice(code, field.dataset.keyPress === "true"))]);
    field.value = selected ?? "";
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
    const picker = kind === 2 || kind === 3 || id === features.macro;
    const field = document.createElement(picker ? "select" : "input");
    field.id = `map-param-${index}`;
    field.dataset.parameter = index;
    field.required = true;
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = paramLabel(kind, index, id);
    if (kind === 2) {
      const search = document.createElement("input");
      search.type = "search";
      search.autocomplete = "off";
      search.placeholder = "名前・コードで検索";
      search.setAttribute("aria-label", `${label.textContent}を検索`);
      search.dataset.keySearch = index;
      field.dataset.keyParameter = index;
      field.dataset.keyPress = String(id === features.keyPress);
      for (const control of [search, field]) {
        control.addEventListener("focus", () => setActiveKeyParameter(index));
      }
      search.addEventListener("input", () => {
        const selected = field.value === "" ? undefined : Number(field.value);
        filterKeyOptions(field, search.value, selected);
      });
      search.addEventListener("keydown", event => {
        if (event.key !== "Enter" || event.isComposing) return;
        event.preventDefault();
        field.focus();
      });
      filterKeyOptions(field, "", value);
      group.classList.add("key-parameter");
      group.append(label, search, field);
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
    const indexes = behaviors.get(id)?.parameters.flatMap((kind, index) => kind === 2 ? [index] : []) ?? [];
    group.hidden = position === null || id === features?.keyPress || !indexes.length;
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
    const types = behaviors.get(id)?.parameters ?? [];
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
    for (const field of elements["map-parameters"].querySelectorAll("[data-parameter]")) {
      if (field.value !== "") values[Number(field.dataset.parameter)] = Number(field.value);
    }
    setBindingDraft(selected === "" ? undefined : Number(selected), values, activeKeyParameter);
  }

  function markPalette() {
    const code = position === null || activeKeyParameter === null ? undefined :
      elements["map-parameters"].querySelector(`[data-key-parameter="${activeKeyParameter}"]`)?.value;
    for (const entry of elements["map-form"].querySelectorAll(".palette-key")) {
      entry.setAttribute("aria-pressed", String(entry.dataset.code === code));
    }
  }

  function updateMapSelection() {
    const selected = position !== null;
    elements["map-assignment"].hidden = !selected;
    elements["map-selection"].textContent = selected ? `位置 ${position} の割り当て` : "割り当て候補";
    const current = bindingText(bindings[position]);
    elements["map-current"].textContent = selected ?
      `現在 ${[current.legend, current.code].filter(Boolean).join(" · ")}` :
      "上のキーボードから変更するキーを選んでください。";
  }

  function selectKey(key) {
    position = key;
    markKey();
    const current = bindings[key];
    updateMapSelection();
    const select = elements["map-behavior"];
    const catalog = [...behaviors].filter(([, behavior]) => behavior.editable && !hiddenBehaviors.has(behavior.name))
      .sort(([, a], [, b]) => a.name.localeCompare(b.name));
    setDetailedOptions(select, [new Option("選択してください", ""), ...catalog.map(([id, { name }]) =>
      detailedOption(name, behaviorDescriptions.get(name) ?? "ファームウェア固有の動作", id))]);
    const canReplace = catalog.some(([id]) => id === current.id);
    setBindingDraft(canReplace ? current.id : undefined, current.parameters);
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
    elements["map-us"].setAttribute("aria-pressed", String(keyboardLayout === "us"));
    elements["map-jis"].setAttribute("aria-pressed", String(keyboardLayout === "jis"));
    markPalette();
  }

  function paletteKey(code) {
    const entry = button("", () => {
      if (activeKeyParameter === null) {
        setBindingDraft(features.keyPress, [code]);
        return;
      }
      const group = elements["map-parameters"];
      const field = group.querySelector(`[data-key-parameter="${activeKeyParameter}"]`);
      group.querySelector(`[data-key-search="${activeKeyParameter}"]`).value = "";
      filterKeyOptions(field, "", code);
      markPalette();
    });
    entry.classList.add("palette-key");
    entry.dataset.code = code;
    entry.title = keyOption(code);
    fillKeycap(entry, keyText(code));
    return entry;
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
      body.append(op, value, actions);
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
    const options = available.map(index => new Option(`マクロ ${index}`, index));
    if (slot !== null && !macroRecords.has(slot)) options.push(new Option(`マクロ ${slot}（未保存）`, slot));
    if (!options.length) options.push(new Option("保存済みマクロなし", ""));
    elements["macro-slot"].replaceChildren(...options);
    elements["macro-slot"].value = slot ?? "";
    elements["macro-capacity"].textContent = `${macroRecords.size} / ${features.macroSlots} 枠を使用中`;
    elements["macro-delete"].textContent = slot !== null && !macroRecords.has(slot) ? "追加を取り消す" : "マクロを削除";
    macroStatus(slot === null ? "「マクロを追加」から作成できます。" :
      record === null ? "このマクロを読み込めませんでした。手順を追加して保存すると置き換わります。" :
      record === undefined ? "手順を追加して保存してください。" : "");
    drawMacro();
  }

  function openMacros() {
    if (editable()) void run(async attached => {
      const records = new Map();
      for (let index = 0; index < features.macroSlots; ++index) {
        const record = await attached.macro(index, features.macroSteps);
        if (attached !== state().device) return;
        if (record === null || record.length) records.set(index, record);
      }
      macroRecords = records;
      showMacro(records.has(slot) ? slot : records.keys().next().value ?? null);
    });
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
  elements["layer-name"].addEventListener("input", updateLayerName);
  elements["cancel-layer-name"].addEventListener("click", () => {
    closeLayerRename();
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
  elements["map-behavior"].addEventListener("change", event => setBindingDraft(
    event.target.value ? Number(event.target.value) : undefined));
  elements["map-cancel"].addEventListener("click", () => {
    position = null;
    activeKeyParameter = null;
    markKey();
    updateMapSelection();
    drawPaletteTargets();
    markPalette();
    refresh();
  });
  elements["map-us"].addEventListener("click", () => changeLayout("us"));
  elements["map-jis"].addEventListener("click", () => changeLayout("jis"));
  elements["map-parameters"].addEventListener("input", markPalette);
  elements["map-form"].addEventListener("submit", event => {
    event.preventDefault();
    if (!editable() || position === null) return;
    const id = Number(elements["map-behavior"].value);
    const params = [0, 0];
    for (const field of elements["map-parameters"].querySelectorAll("[data-parameter]")) {
      params[Number(field.dataset.parameter)] = Number(field.value);
    }
    void run(async attached => {
      await attached.save(`BINDSET ${layer} ${position} ${id} ${params.join(" ")}`, message => {
        if (attached === state().device) notice(message);
      });
      const saved = await attached.binding(layer, position);
      if (attached !== state().device) return;
      bindings[position] = saved;
      drawKeymap();
      selectKey(position);
      notice("キーの割り当てを保存しました。");
    });
  });
  function discardMacroDraft() {
    return !macroDirty || window.confirm("保存していない手順を取り消しますか？");
  }

  elements["macro-slot"].addEventListener("change", event => {
    if (discardMacroDraft()) showMacro(Number(event.target.value));
    else event.target.value = slot;
  });
  elements["macro-refresh"].addEventListener("click", () => {
    if (discardMacroDraft()) openMacros();
  });
  elements["macro-new"].addEventListener("click", () => {
    if (!editable() || !discardMacroDraft()) return;
    for (let index = 0; index < features.macroSlots; ++index) {
      if (macroRecords.has(index)) continue;
      showMacro(index);
      elements["macro-add"].focus();
      break;
    }
  });
  elements["macro-delete"].addEventListener("click", () => {
    if (!editable() || slot === null) return;
    if (!macroRecords.has(slot)) {
      showMacro(macroRecords.keys().next().value ?? null);
      return;
    }
    const dialog = elements["macro-delete-dialog"];
    dialog.returnValue = "cancel";
    const device = state().device;
    const target = slot;
    dialog.addEventListener("close", () => {
      if (dialog.returnValue !== "confirm" || device !== state().device) return;
      void run(async attached => {
        await attached.save(`MACROSET ${target} 0`, message => {
          if (attached === state().device) notice(message);
        });
        if (attached !== state().device) return;
        macroRecords.delete(target);
        showMacro(macroRecords.keys().next().value ?? null);
        notice("マクロを削除しました。");
      });
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
    if (!editable() || !steps?.length || !macroDirty) return;
    const draft = currentDraft();
    if (!draft) {
      notice("「押す」と「離す」をキーごとに対応させ、待機時間を 1〜5000 ms にしてください。", "error");
      return;
    }
    void run(async attached => {
      await attached.save(`MACROSET ${slot} ${draft.length} ${draft.join(" ")}`, message => {
        if (attached === state().device) notice(message);
      });
      if (attached !== state().device) return;
      const saved = await attached.macro(slot, features.macroSteps);
      if (attached !== state().device) return;
      macroRecords.set(slot, saved);
      showMacro(slot);
      notice("マクロを保存しました。");
    });
  });

  renderPalette();
  updateMapSelection();
  return { setConnection, refresh, loadPage };
}
