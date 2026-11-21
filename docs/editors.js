const KEYBOARD_PAGE = 0x07 * 65536;
const CONSUMER_PAGE = 0x0c * 65536;
const MACRO_OPERATIONS = ["タップ", "押す", "離す", "待つ"];

export function setupEditors({ elements, drawKeyboard, usageLabels, run, notice, state }) {
  let page = "combos";
  let features = null;
  let keys = [];
  let layerCount = 0;
  let layers = null;
  let behaviors = new Map();
  let layer = null;
  let bindings = [];
  let position = null;
  let slot = 0;
  let steps = null;
  let macroDirty = false;

  const keyCodes = new Map([...usageLabels].map(([usage, label]) => [KEYBOARD_PAGE + usage, label]));
  for (const [usage, label] of [
    [0x87, "ろ"], [0x88, "かな"], [0x89, "¥"], [0x8a, "変換"], [0x8b, "無変換"],
  ]) keyCodes.set(KEYBOARD_PAGE + usage, label);
  for (const [usage, label] of [
    [0xb5, "次の曲"], [0xb6, "前の曲"], [0xcd, "再生 / 停止"], [0xe2, "消音"],
    [0xe9, "音量 +"], [0xea, "音量 −"],
  ]) keyCodes.set(CONSUMER_PAGE + usage, label);

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

  function bindLabel(binding) {
    if (!binding || binding.id === 65535) return "—";
    const { id, parameters } = binding;
    if (id === features.keyPress && keyCodes.has(parameters[0])) return keyCodes.get(parameters[0]);
    if (id === features.macro) return `マクロ ${parameters[0]}`;
    const behavior = behaviors.get(id);
    if (!behavior) return `Behavior ${id}`;
    return [behavior.name, ...parameters.flatMap((value, i) => {
      const kind = behavior.parameters[i];
      if (!kind && !value) return [];
      if (kind === 2) return [keyCodes.get(value) ?? `0x${value.toString(16)}`];
      return [value];
    })].join(" ");
  }

  function refresh() {
    const { device, busy, info } = state();
    for (const name of ["combos", "keymap", "macros"]) {
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
    for (const group of ["map-layers", "map-keyboard", "map-form"]) {
      for (const control of elements[group].querySelectorAll("button, select, input")) {
        control.disabled = !enabled || control.hasAttribute("data-unavailable");
      }
    }
    elements["macro-slot"].disabled = !enabled;
    elements["macro-refresh"].disabled = !enabled;
    elements["macro-add"].disabled = !enabled || !steps || steps.length >= (features?.macroSteps ?? 0);
    elements["macro-save"].disabled = !enabled || !macroDirty;
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
    bindings = [];
    slot = 0;
    steps = null;
    macroDirty = false;
    macroStatus("");
    elements["map-form"].hidden = true;
    for (const id of ["map-layers", "map-keyboard", "macro-steps"]) elements[id].replaceChildren();
    elements["macro-slot"].replaceChildren(...Array.from({ length: features?.macroSlots ?? 0 },
      (_, index) => new Option(`マクロ ${index}`, index)));
    if (features) show("combos", false);
  }

  function drawKeymap() {
    elements["map-layers"].replaceChildren(...layers.map(entry => {
      const item = button(entry.name, () => openKeymap(entry.id));
      item.setAttribute("aria-pressed", String(layer === entry.id));
      return item;
    }));
    drawKeyboard(elements["map-keyboard"], keys, false, selectKey, key => bindLabel(bindings[key]));
    markKey();
  }

  async function loadKeymap(attached, requested, updateCatalog) {
    const available = !layers || updateCatalog ? await attached.keymapLayers(layerCount) : layers;
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
    if (layer !== selected) position = null;
    layer = selected;
    bindings = current;
    drawKeymap();
    if (position !== null) selectKey(position);
    else elements["map-form"].hidden = true;
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

  function makeParameter(kind, value, index, id) {
    const group = document.createElement("div");
    const picker = kind === 2 || kind === 3 || id === features.macro;
    const field = document.createElement(picker ? "select" : "input");
    field.id = `map-param-${index}`;
    field.dataset.parameter = index;
    field.required = true;
    const label = document.createElement("label");
    label.htmlFor = field.id;
    label.textContent = id === features.macro ? "マクロ枠" :
      kind === 2 ? "キー" : kind === 3 ? "対象レイヤー" : `パラメーター ${index + 1}`;
    if (picker) {
      const options = id === features.macro ?
        Array.from({ length: features.macroSlots }, (_, i) => [i, `マクロ ${i}`]) :
        kind === 2 ? [...keyCodes] : layers.map(entry => [entry.id, entry.name]);
      if (value === undefined) field.add(new Option("選択してください", ""));
      else if (!options.some(([code]) => code === value)) field.add(new Option(`0x${value.toString(16)}`, value));
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

  function setBindingDraft(id, values = []) {
    const select = elements["map-behavior"];
    select.value = id ?? "";
    const types = behaviors.get(id)?.parameters ?? [];
    elements["map-parameters"].replaceChildren(...types.flatMap((kind, index) =>
      kind ? [makeParameter(kind, values[index], index, id)] : []));
    markPalette();
  }

  function markPalette() {
    const isKey = Number(elements["map-behavior"].value) === features.keyPress;
    const code = elements["map-parameters"].querySelector("[data-parameter='0']")?.value;
    for (const entry of elements["map-palette"].children) {
      entry.setAttribute("aria-pressed", String(isKey && entry.dataset.code === code));
    }
  }

  function selectKey(key) {
    position = key;
    markKey();
    const current = bindings[key];
    elements["map-form"].hidden = false;
    elements["map-selection"].textContent = `位置 ${key}`;
    elements["map-current"].textContent = `現在の割り当て ${bindLabel(current)}`;
    const select = elements["map-behavior"];
    select.replaceChildren(new Option("選択してください", ""));
    const catalog = [...behaviors].filter(([, behavior]) => behavior.editable)
      .sort(([, a], [, b]) => a.name.localeCompare(b.name));
    for (const [id, behavior] of catalog) select.add(new Option(behavior.name, id));
    const canReplace = behaviors.get(current.id)?.editable;
    setBindingDraft(canReplace ? current.id : undefined, current.parameters);
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
    elements["macro-steps"].replaceChildren(...steps.map((step, index) => {
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
        value.replaceChildren(...[...usageLabels].map(([code, name]) => new Option(name, code)));
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
        drawMacro();
      }, "danger"));
      body.append(op, value, actions);
      row.append(body);
      return row;
    }));
    refresh();
  }

  async function loadMacro(attached, requested) {
    const record = await attached.macro(requested, features.macroSteps);
    if (attached !== state().device) return;
    slot = requested;
    elements["macro-slot"].value = slot;
    steps = record ?? [];
    macroDirty = false;
    macroStatus(record === null ? "この枠を読み込めませんでした。手順を追加して保存すると置き換わります。" :
      steps.length ? "" : "未設定");
    drawMacro();
  }

  function openMacro(requested = slot) {
    if (editable()) void run(async attached => {
      try {
        await loadMacro(attached, requested);
      } finally {
        if (attached === state().device) elements["macro-slot"].value = slot;
      }
    });
  }

  function show(name, load = true) {
    page = name;
    refresh();
    if (!load) return;
    if (name === "keymap" && !layers) openKeymap();
    if (name === "macros" && steps === null) openMacro();
  }

  for (const name of ["combos", "keymap", "macros"]) {
    elements[`show-${name}`].addEventListener("click", () => show(name));
  }
  elements["map-refresh"].addEventListener("click", () => openKeymap(layer, true));
  elements["map-behavior"].addEventListener("change", event => setBindingDraft(
    event.target.value ? Number(event.target.value) : undefined));
  elements["map-cancel"].addEventListener("click", () => {
    position = null;
    markKey();
    elements["map-form"].hidden = true;
  });
  elements["map-palette"].replaceChildren(...[...keyCodes].map(([code, label]) => {
    const entry = button(label, () => setBindingDraft(features.keyPress, [code]));
    entry.dataset.code = code;
    return entry;
  }));
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
  elements["macro-slot"].addEventListener("change", event => openMacro(Number(event.target.value)));
  elements["macro-refresh"].addEventListener("click", () => openMacro());
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
    if (!editable() || !steps || !macroDirty) return;
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
      await loadMacro(attached, slot);
      if (attached === state().device) notice("マクロを保存しました。");
    });
  });

  return { setConnection, refresh };
}
