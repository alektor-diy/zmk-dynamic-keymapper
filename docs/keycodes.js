import { keyboardExtras, consumerExtras } from "./extra-keycodes.js";
import { isBluetoothAction } from "./bluetooth.js";

const KEYBOARD_PAGE = 0x070000;
const CONSUMER_PAGE = 0x0c0000;
const dictionary = new Map();

function add(page, usage, name, legend = name) {
  dictionary.set(page + usage, { name, legend });
}

function keyboard(first, entries) {
  entries.forEach(([name, legend], index) => add(KEYBOARD_PAGE, first + index, name, legend));
}

keyboard(0x04, [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"].map(letter => [letter]));
keyboard(0x1e, [..."1234567890"].map(digit => [`N${digit}`, digit]));
keyboard(0x28, [
  ["RET", "Enter"], ["ESC", "Esc"], ["BSPC", "Bksp"], ["TAB", "Tab"], ["SPACE", "Space"],
  ["MINUS", "-"], ["EQUAL", "="], ["LBKT", "["], ["RBKT", "]"], ["BSLH", "\\"],
  ["NUHS", "#"], ["SEMI", ";"], ["SQT", "'"], ["GRAVE", "`"], ["COMMA", ","], ["DOT", "."],
  ["SLASH", "/"], ["CAPS", "Caps Lock"],
]);
keyboard(0x3a, Array.from({ length: 12 }, (_, index) => [`F${index + 1}`]));
keyboard(0x46, [
  ["PSCRN", "Prt Sc"], ["SLCK", "Scr Lk"], ["PAUSE_BREAK", "Pause"], ["INS", "Insert"],
  ["HOME", "Home"], ["PG_UP", "Pg Up"], ["DEL", "Delete"], ["END", "End"], ["PG_DN", "Pg Dn"],
  ["RIGHT", "→"], ["LEFT", "←"], ["DOWN", "↓"], ["UP", "↑"], ["KP_NUM", "Num"],
  ["KP_DIVIDE", "/"], ["KP_MULTIPLY", "*"], ["KP_MINUS", "−"], ["KP_PLUS", "+"], ["KP_ENTER", "Enter"],
  ...[..."1234567890"].map(digit => [`KP_N${digit}`, digit]),
  ["KP_DOT", "."], ["NUBS", "\\"], ["K_APP", "Menu"],
]);
keyboard(0x68, Array.from({ length: 12 }, (_, index) => [`F${index + 13}`]));
keyboard(0x87, [
  ["INT1", "ろ"], ["INT2", "かな"], ["INT3", "¥"], ["INT4", "変換"], ["INT5", "無変換"],
]);
keyboard(0xe0, [
  ["LCTRL", "Ctrl"], ["LSHFT", "Shift"], ["LALT", "Alt"], ["LGUI", "Win"],
  ["RCTRL", "Ctrl"], ["RSHFT", "Shift"], ["RALT", "Alt"], ["RGUI", "Win"],
]);
for (const [usage, name, legend] of [
  [0xb5, "C_NEXT", "次の曲"], [0xb6, "C_PREV", "前の曲"], [0xcd, "C_PP", "再生 / 停止"],
  [0xe2, "C_MUTE", "消音"], [0xe9, "C_VOL_UP", "音量 +"], [0xea, "C_VOL_DN", "音量 −"],
]) add(CONSUMER_PAGE, usage, name, legend);

const extraLegends = new Map([
  ["INTERNATIONAL_6", "テンキー ,"], ["LANGUAGE_1", "韓英切替"], ["LANGUAGE_2", "漢字"],
  ["LANGUAGE_3", "カタカナ"], ["LANGUAGE_4", "ひらがな"], ["LANGUAGE_5", "半角／全角"],
  ["KP_EQUAL", "テンキー ="], ["KP_COMMA", "テンキー ,"],
  ["C_BRIGHTNESS_INC", "明るさ +"], ["C_BRIGHTNESS_DEC", "明るさ −"],
]);
for (const [page, entries] of [[KEYBOARD_PAGE, keyboardExtras], [CONSUMER_PAGE, consumerExtras]]) {
  for (const [usage, name] of entries) {
    const code = name.replace(/^INTERNATIONAL_/, "INT").replace(/^LANGUAGE_/, "LANG");
    if (!dictionary.has(page + usage)) add(page, usage, code, extraLegends.get(name));
  }
}

export function packUsage(code, modifiers = 0) {
  const usage = code & 0xffff;
  if ((code & 0xff0000) === CONSUMER_PAGE) return 0x11000000 + usage;
  return modifiers ? 0x10000000 + modifiers * 65536 + usage : usage;
}

export function unpackUsage(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return 0;
  if (value >= 4 && value <= 0xff) return KEYBOARD_PAGE + value;
  if ((value & 0xfe000000) !== 0x10000000) return 0;
  const usage = value & 0xffff;
  const modifiers = (value >>> 16) & 0xff;
  return value & 0x01000000
    ? usage && usage <= 0xfff && !modifiers ? CONSUMER_PAGE + usage : 0
    : usage >= 4 && usage <= 0xff ? modifiers * 0x1000000 + KEYBOARD_PAGE + usage : 0;
}

export function encodeMacroStep({ op, value }) {
  return (value & 0x10000000) && op !== 3 ? op * 0x40000000 + value : op * 65536 + value;
}

export function decodeMacroStep(code) {
  return code & 0x10000000
    ? { op: code >>> 30, value: code & 0x3fffffff }
    : { op: code >>> 16, value: code & 0xffff };
}

export function validMacroSteps(steps) {
  const held = new Map();
  for (const { op, value } of steps) {
    if (op === 3) {
      if (!Number.isInteger(value) || value < 1 || value > 5000) return false;
      continue;
    }
    if (isBluetoothAction(value)) {
      if (op !== 0 || held.size) return false;
      continue;
    }
    const key = unpackUsage(value);
    const base = key & 0xffffff;
    if (!key || !Number.isInteger(op) || op < 0 || op > 2) return false;
    if (op === 2) {
      if (held.get(base) !== key) return false;
      held.delete(base);
    } else if (held.has(base)) {
      return false;
    } else if (op === 1) {
      held.set(base, key);
    }
  }
  return held.size === 0;
}

export function setUsageValue(select, value, label, supported) {
  if (value && ![...select.options].some(option => Number(option.value) === Number(value))) {
    const option = new Option(label, value);
    option.disabled = !supported;
    select.add(option);
  }
  select.value = value ?? "";
}

const usLegends = new Map([
  ...[..."!@#$%^&*()"].map((text, index) => [0x1e + index, [undefined, text]]),
  [0x2d, ["-", "_"]], [0x2e, ["=", "+"]], [0x2f, ["[", "{"]], [0x30, ["]", "}"]],
  [0x31, ["\\", "|"]], [0x33, [";", ":"]], [0x34, ["'", '"']], [0x35, ["`", "~"]],
  [0x36, [",", "<"]], [0x37, [".", ">"]], [0x38, ["/", "?"]],
]);
const jisLegends = new Map([
  ...[...'!"#$%&\'()'].map((text, index) => [0x1e + index, [undefined, text]]),
  [0x2d, ["-", "="]], [0x2e, ["^", "~"]], [0x2f, ["@", "`"]], [0x30, ["[", "{"]],
  [0x32, ["]", "}"]], [0x33, [";", "+"]], [0x34, [":", "*"]], [0x35, ["半角/全角"]],
  [0x36, [",", "<"]], [0x37, [".", ">"]], [0x38, ["/", "?"]], [0x39, ["英数"]],
  [0x87, ["ろ", "_"]], [0x89, ["¥", "|"]],
]);

const modifiers = ["LC", "LS", "LA", "LG", "RC", "RS", "RA", "RG"];

export function keycodeText(code, layout) {
  const base = code & 0xffffff;
  const entry = dictionary.get(base);
  if (!entry) {
    return { legend: "HID", code: `0x${code.toString(16).toUpperCase()}` };
  }
  const variants = (layout === "jis" ? jisLegends : usLegends).get(base - KEYBOARD_PAGE);
  const flags = code >>> 24;
  const active = modifiers.filter((_, index) => flags & (1 << index));
  const name = active.reduceRight((inner, modifier) => `${modifier}(${inner})`, entry.name);
  if (flags & 0x22 && variants?.[1]) return { legend: variants[1], code: name };
  return { legend: variants?.[0] ?? entry.legend, shifted: variants?.[1], code: name };
}

export const keycodes = [...dictionary.keys()];

const extraKeyGroups = [
  ["ファンクション", name => /^F\d+$/.test(name)],
  ["テンキー", (name, usage) => name.startsWith("KP_") || usage === 0x07008c],
  ["言語・文字入力", name => /^(INT\d|LANG\d|C_(AC_NEXT_KEYBOARD_LAYOUT|AL_KEYBOARD_LAYOUT|KEYBOARD_INPUT_ASSIST))/.test(name)],
  ["英数字・記号", (_, usage) => (usage >= 0x070004 && usage <= 0x070027) ||
    (usage >= 0x07002d && usage <= 0x070038) || usage === 0x070064],
  ["基本操作・修飾", (_, usage) => (usage >= 0x070028 && usage <= 0x07002c) ||
    (usage >= 0x070046 && usage <= 0x070052) || (usage >= 0x0700e0 && usage <= 0x0700e7) ||
    usage === 0x070039 || usage === 0x070065],
  ["音量・メディア再生", name => /^C_(VOL|MUTE|PLAY|PAUSE|RECORD|FAST_FORWARD|REWIND|NEXT|PREVIOUS|STOP|EJECT|RANDOM|REPEAT|SLOW|BASS|ALTERNATE_AUDIO)|^K_(VOL|MUTE|PLAY|NEXT|PREVIOUS|STOP2|EJECT)/.test(name)],
  ["画面・電源", name => /^(C|K)_(BRIGHTNESS|BACKLIGHT|POWER|RESET|SLEEP|LOCK|AL_LOCK|AL_LOGOFF|AL_SCREEN_SAVER)/.test(name)],
  ["ブラウザー・ナビゲーション", name => /^(C_AC_(SEARCH|GOTO|HOME|BACK|FORWARD|STOP|REFRESH|BOOKMARKS|ZOOM|SCROLL)|K_(WWW|BACK|FORWARD|STOP3|REFRESH|SCROLL))/.test(name)],
  ["アプリ起動・切り替え", name => /^(C_AL_|C_AC_DESKTOP_|K_CALCULATOR|C_VOICE_COMMAND)/.test(name)],
  ["編集・操作", name => /^(C_AC_|K_(EXECUTE|SELECT|STOP|AGAIN|UNDO|CUT|COPY|PASTE|FIND|EDIT|CANCEL|HELP)|ALT_ERASE|CLEAR|RETURN2)/.test(name)],
  ["テレビ・入力ソース", name => /^C_(MEDIA|MENU|CHANNEL|RECALL|DATA_ON_SCREEN|CAPTIONS|SNAPSHOT|PIP|ASPECT|RED_BUTTON|GREEN_BUTTON|BLUE_BUTTON|YELLOW_BUTTON)/.test(name)],
  ["その他", () => true],
];

export function groupExtraKeys(codes) {
  const groups = extraKeyGroups.map(([name]) => ({ name, codes: [] }));
  for (const code of codes) {
    const name = dictionary.get(code).name;
    const index = extraKeyGroups.findIndex(([, matches]) => matches(name, code));
    groups[index].codes.push(code);
  }
  return groups.filter(group => group.codes.length);
}

const digits = [0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27];
const letters = row => [...row].map(letter => letter.charCodeAt(0) - 61);
const functionRow = [0x29, [0, 1], 0x3a, 0x3b, 0x3c, 0x3d, [0, .5], 0x3e, 0x3f, 0x40, 0x41,
  [0, .5], 0x42, 0x43, 0x44, 0x45];

export function fullSizeKeys(layout) {
  const jis = layout === "jis";
  return [
    [
      functionRow,
      [0x35, ...digits, 0x2d, 0x2e, ...(jis ? [0x89, 0x2a] : [[0x2a, 2]])],
      [[0x2b, 1.5], ...letters("QWERTYUIOP"), 0x2f, 0x30, jis ? [0x28, 1.5, 2] : [0x31, 1.5]],
      [[0x39, 1.75], ...letters("ASDFGHJKL"), 0x33, 0x34, jis ? 0x32 : [0x28, 2.25]],
      [[0xe1, 2.25], ...letters("ZXCVBNM"), 0x36, 0x37, 0x38, ...(jis ? [0x87] : []),
        [0xe5, jis ? 1.75 : 2.75]],
      [[0xe0, 1.25], [0xe3, 1.25], [0xe2, 1.25], ...(jis ? [[0x8b, 1.25]] : []),
        [0x2c, jis ? 2.5 : 6.25], ...(jis ? [[0x8a, 1.25], [0x88, 1.25]] : []),
        [0xe6, 1.25], [0xe7, 1.25], [0x65, 1.25], [0xe4, 1.25]],
    ],
    [[0x46, 0x47, 0x48], [0x49, 0x4a, 0x4b], [0x4c, 0x4d, 0x4e], [], [0, 0x52], [0x50, 0x51, 0x4f]],
    [[], [0x53, 0x54, 0x55, 0x56], [0x5f, 0x60, 0x61, [0x57, 1, 2]], [0x5c, 0x5d, 0x5e],
      [0x59, 0x5a, 0x5b, [0x58, 1, 2]], [[0x62, 2], 0x63]],
  ].map(rows => rows.flatMap((row, index) => {
    let column = 1;
    return row.flatMap(item => {
      const [usage, units = 1, height = 1] = Array.isArray(item) ? item : [item];
      const width = units * 4;
      const key = { code: KEYBOARD_PAGE + usage, column, row: index + 1, width, height };
      column += width;
      return usage ? [key] : [];
    });
  }));
}

export function fillKeycap(element, { legend, code, shifted }) {
  const label = document.createElement("span");
  label.className = "keycap-legend";
  label.textContent = legend;
  if (shifted) {
    const variant = document.createElement("sup");
    variant.textContent = shifted;
    variant.setAttribute("aria-hidden", "true");
    label.append(" ", variant);
  }
  element.append(label);
  if (code) {
    const name = document.createElement("small");
    name.className = "keycap-code";
    name.textContent = code;
    element.append(name);
  }
}
