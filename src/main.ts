import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FitAddon, init, Terminal } from "ghostty-web";

type ConnectionMode = "disconnected" | "connecting" | "connected" | "error";
type Parity = "none" | "even" | "odd";
type PickerId = "port" | "baud" | "font";
type TerminalContextMenuAction = "copy" | "paste" | "clear";
type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

interface DropdownPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: "up" | "down";
}

interface TerminalContextMenuState {
  left: number;
  top: number;
  canCopy: boolean;
  canPaste: boolean;
}

interface GhosttyRendererMetrics {
  width: number;
  height: number;
  baseline: number;
}

interface GhosttyRendererInternals {
  metrics: GhosttyRendererMetrics;
  getMetrics(): GhosttyRendererMetrics;
  remeasureFont(): void;
  resize(cols: number, rows: number): void;
  render(
    buffer: unknown,
    forceAll?: boolean,
    viewportY?: number,
    scrollbackProvider?: unknown,
  ): void;
}

interface GhosttyTerminalInternals {
  renderer?: GhosttyRendererInternals;
  wasmTerm?: unknown;
  viewportY: number;
}

interface SerialConfig {
  port_name: string;
  baud_rate: number;
  data_bits: number;
  parity: Parity;
  stop_bits: number;
}

interface SerialDataPayload {
  data: number[];
  byte_count: number;
}

interface SerialErrorPayload {
  message: string;
}

interface AppState {
  ports: string[];
  availableFonts: string[];
  config: SerialConfig;
  mode: ConnectionMode;
  rxBytes: number;
  txBytes: number;
  lastError: string;
  fontFamily: string;
  activePicker: PickerId | null;
  pickerPosition: DropdownPosition | null;
  fontSize: number;
  lineSpacing: number;
}

interface SavedSettings {
  config?: Partial<SerialConfig>;
  fontFamily?: string;
  fontSize?: number;
  lineSpacing?: number;
}

interface SegmentOption {
  label: string;
  value: string;
}

interface PickerOption {
  label: string;
  value: string;
}

const baudRates = [
  110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200,
  128000, 230400, 256000, 460800, 500000, 576000, 921600, 1000000, 1500000,
  2000000, 3000000, 4000000,
];

const fallbackFontFamilies = [
  "Cascadia Mono",
  "Cascadia Code",
  "JetBrains Mono",
  "JetBrainsMonoNerdFontMono-Regular",
  "Consolas",
  "Microsoft YaHei UI",
  "monospace",
];

const storageKey = "serial-terminal-settings-v1";
const serialWriteChunkSize = 256;
const serialWriteDelayMs = 2;
const terminalMenuMargin = 8;
const savedSettings = readSavedSettings();
const state: AppState = {
  ports: [],
  availableFonts: mergeFonts([]),
  config: {
    port_name: savedSettings.config?.port_name ?? "",
    baud_rate: savedSettings.config?.baud_rate ?? 1500000,
    data_bits: savedSettings.config?.data_bits ?? 8,
    parity: savedSettings.config?.parity ?? "none",
    stop_bits: savedSettings.config?.stop_bits ?? 1,
  },
  mode: "disconnected",
  rxBytes: 0,
  txBytes: 0,
  lastError: "",
  fontFamily: savedSettings.fontFamily ?? fallbackFontFamilies[0],
  activePicker: null,
  pickerPosition: null,
  fontSize: savedSettings.fontSize ?? 18,
  lineSpacing: savedSettings.lineSpacing ?? 1,
};

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Missing #app root");
}
const app: HTMLDivElement = appRoot;
const currentWindow = getCurrentWindow();

await init();

const fitAddon = new FitAddon();
const terminal = new Terminal({
  allowTransparency: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "bar",
  disableStdin: false,
  fontFamily: terminalFontFamily(),
  fontSize: state.fontSize,
  scrollback: 10000,
  smoothScrollDuration: 0,
  theme: {
    background: "#050505",
    foreground: "#d7d7d7",
    cursor: "#f1f1f1",
    cursorAccent: "#050505",
    selectionBackground: "#264f78",
    black: "#0c0c0c",
    red: "#c50f1f",
    green: "#13a10e",
    yellow: "#c19c00",
    blue: "#0037da",
    magenta: "#881798",
    cyan: "#3a96dd",
    white: "#cccccc",
    brightBlack: "#767676",
    brightRed: "#e74856",
    brightGreen: "#16c60c",
    brightYellow: "#f9f1a5",
    brightBlue: "#3b78ff",
    brightMagenta: "#b4009e",
    brightCyan: "#61d6d6",
    brightWhite: "#f2f2f2",
  },
});

terminal.loadAddon(fitAddon);
terminal.attachCustomKeyEventHandler((event) => {
  if (event.type === "keydown" && event.ctrlKey && event.key.toLowerCase() === "c") {
    if (terminal.hasSelection()) {
      copySelection(true);
      return true;
    }
  }

  return false;
});

let terminalHost: HTMLDivElement | null = null;
let terminalSurface: HTMLDivElement | null = null;
let terminalInputDisposable: { dispose(): void } | null = null;
let resizeObserver: ResizeObserver | null = null;
let fitQueued = false;
let pendingSerialText = "";
let serialFlushTimer: number | null = null;
let serialWriteInFlight = false;
let terminalContextMenu: TerminalContextMenuState | null = null;
let serialOutputQueued = false;
let pendingTerminalOutputChunks: Uint8Array[] = [];
let pendingTerminalOutputLength = 0;
let pendingTerminalOutputBytes = 0;
let pendingStatsUpdate = false;

function renderApp(): void {
  const locked = state.mode === "connected" || state.mode === "connecting";

  app.innerHTML = `
    <div class="app-shell">
      <div class="resize-handle resize-handle-n" data-resize-direction="North"></div>
      <div class="resize-handle resize-handle-s" data-resize-direction="South"></div>
      <div class="resize-handle resize-handle-e" data-resize-direction="East"></div>
      <div class="resize-handle resize-handle-w" data-resize-direction="West"></div>
      <div class="resize-handle resize-handle-ne" data-resize-direction="NorthEast"></div>
      <div class="resize-handle resize-handle-nw" data-resize-direction="NorthWest"></div>
      <div class="resize-handle resize-handle-se" data-resize-direction="SouthEast"></div>
      <div class="resize-handle resize-handle-sw" data-resize-direction="SouthWest"></div>

      <div class="window-titlebar">
        <div class="window-drag-region" data-tauri-drag-region>
          <span class="window-title-mark"></span>
          <span class="window-title">Serial Terminal</span>
        </div>
        <div class="window-controls">
          <button id="window-minimize" class="window-control" type="button" aria-label="最小化" title="最小化">
            <span class="window-control-icon">&#xE921;</span>
          </button>
          <button id="window-maximize" class="window-control" type="button" aria-label="最大化/还原" title="最大化/还原">
            <span id="window-maximize-icon" class="window-control-icon">&#xE922;</span>
          </button>
          <button id="window-close" class="window-control close" type="button" aria-label="关闭" title="关闭">
            <span class="window-control-icon">&#xE8BB;</span>
          </button>
        </div>
      </div>

      <header class="topbar">
        <div class="brand">
          <div class="brand-title">Serial Terminal</div>
          <div class="brand-subtitle">Rust · Tauri · 串口终端</div>
        </div>
        <div class="terminal-hint">聚焦终端直接输入 · Enter=CR · Ctrl+C=中断</div>
        <div class="topbar-actions">
          <span id="rx-stat" class="metric">RX ${formatBytes(state.rxBytes)}</span>
          <span id="tx-stat" class="metric">TX ${formatBytes(state.txBytes)}</span>
          <button id="copy-terminal" class="ghost-button" type="button">复制</button>
          <button id="clear-terminal" class="ghost-button" type="button">清空</button>
          <div class="status-pill ${statusTone()}">
            <span class="status-dot"></span>
            <span>${statusText()}</span>
          </div>
        </div>
      </header>

      <main class="workspace">
        <aside class="sidebar">
          <section class="settings-section">
            <div class="section-title">串口设置</div>
            <label class="field">
              <span>串口</span>
              <div class="field-row">
                ${renderPicker("port", pickerLabel("port"), locked)}
                <button id="refresh-ports" class="secondary-button" type="button" ${locked ? "disabled" : ""}>刷新</button>
              </div>
            </label>
            <label class="field">
              <span>波特率</span>
              ${renderPicker("baud", pickerLabel("baud"), locked)}
            </label>
            <div class="field">
              <span>数据位</span>
              ${renderSegment("data_bits", [
                { label: "5", value: "5" },
                { label: "6", value: "6" },
                { label: "7", value: "7" },
                { label: "8", value: "8" },
              ])}
            </div>
            <div class="field">
              <span>校验位</span>
              ${renderSegment("parity", [
                { label: "无", value: "none" },
                { label: "偶", value: "even" },
                { label: "奇", value: "odd" },
              ])}
            </div>
            <div class="field">
              <span>停止位</span>
              ${renderSegment("stop_bits", [
                { label: "1", value: "1" },
                { label: "2", value: "2" },
              ])}
            </div>
          </section>

          <section class="settings-section">
            <div class="section-title">连接</div>
            <button id="connection-toggle" class="primary-button ${state.mode}" type="button" ${
              state.mode === "connecting" || (!state.config.port_name && state.mode !== "connected")
                ? "disabled"
                : ""
            }>
              ${connectionButtonText()}
            </button>
            <div class="connection-line">
              <span class="small-dot ${statusTone()}"></span>
              <span>${connectionDetailText()}</span>
            </div>
            ${state.lastError ? `<div class="error-text">${escapeHtml(state.lastError)}</div>` : ""}
          </section>

          <section class="settings-section">
            <div class="section-title">终端显示</div>
            <label class="field">
              <span>字体</span>
              ${renderPicker("font", pickerLabel("font"), false)}
            </label>
            <label class="field range-field">
              <span>字号</span>
              <div class="range-row">
                <input id="font-size" type="range" min="12" max="34" step="1" value="${state.fontSize}" />
                <output id="font-size-output">${state.fontSize}px</output>
              </div>
            </label>
            <label class="field range-field">
              <span>行距</span>
              <div class="range-row">
                <input id="line-spacing" type="range" min="0.9" max="1.6" step="0.05" value="${state.lineSpacing}" />
                <output id="line-spacing-output">${state.lineSpacing.toFixed(2)}</output>
              </div>
            </label>
          </section>
        </aside>

        <section class="terminal-panel">
          <div id="terminal-host" class="terminal-host"></div>
        </section>
      </main>
      ${renderTerminalContextMenu()}
      ${renderPickerPortal()}
    </div>
  `;

  bindChromeEvents();
  attachTerminal();
  updateStats();
}

function attachTerminal(): void {
  const host = document.querySelector<HTMLDivElement>("#terminal-host");
  if (!host) {
    return;
  }

  if (!terminalSurface) {
    terminalSurface = document.createElement("div");
    terminalSurface.className = "terminal-surface";
    terminal.open(terminalSurface);
    applyTerminalLineSpacing();
  }

  if (host !== terminalHost || terminalSurface.parentElement !== host) {
    host.replaceChildren(terminalSurface);
    terminalHost = host;

    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      queueFit();
    });
    resizeObserver.observe(host);

    host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openTerminalContextMenu(event.clientX, event.clientY);
    }, { capture: true });
  }

  if (!terminalInputDisposable) {
    terminalInputDisposable = terminal.onData((data) => {
      queueSerialText(normalizeTerminalInput(data));
    });
  }

  terminal.focus();
  queueFit();
}

function bindChromeEvents(): void {
  bindWindowChromeEvents();

  document.querySelector("#refresh-ports")?.addEventListener("click", () => {
    void refreshPorts();
  });

  document.querySelector("#connection-toggle")?.addEventListener("click", () => {
    void toggleConnection();
  });

  document.querySelector("#copy-terminal")?.addEventListener("click", () => {
    copySelection();
  });

  document.querySelector("#clear-terminal")?.addEventListener("click", () => {
    clearPendingTerminalOutput();
    terminal.clear();
    terminal.focus();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-terminal-menu-action]').forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.terminalMenuAction as TerminalContextMenuAction | undefined;
      if (!action) {
        return;
      }
      void runTerminalContextMenuAction(action);
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-setting]").forEach((button) => {
    button.addEventListener("click", () => {
      const setting = button.dataset.setting;
      const value = button.dataset.value;
      if (setting && value) {
        applySerialSetting(setting, value);
      }
    });
  });

  bindPickerEvents();

  const fontSize = document.querySelector<HTMLInputElement>("#font-size");
  fontSize?.addEventListener("input", () => {
    state.fontSize = Number(fontSize.value);
    updateOutput("#font-size-output", `${state.fontSize}px`);
    saveSettings();
    applyTerminalOptions();
  });

  const lineSpacing = document.querySelector<HTMLInputElement>("#line-spacing");
  lineSpacing?.addEventListener("input", () => {
    state.lineSpacing = Number(lineSpacing.value);
    updateOutput("#line-spacing-output", state.lineSpacing.toFixed(2));
    saveSettings();
    applyTerminalOptions();
  });
}

function renderTerminalContextMenu(): string {
  if (!terminalContextMenu) {
    return "";
  }

  return `
    <div
      id="terminal-context-menu"
      class="terminal-context-menu"
      role="menu"
      style="left: ${terminalContextMenu.left}px; top: ${terminalContextMenu.top}px"
    >
      <button
        data-terminal-menu-action="copy"
        class="terminal-context-item"
        type="button"
        ${terminalContextMenu.canCopy ? "" : "disabled"}
      >
        <span class="terminal-context-icon">&#xE8C8;</span>
        <span>复制</span>
      </button>
      <button
        data-terminal-menu-action="paste"
        class="terminal-context-item"
        type="button"
        ${terminalContextMenu.canPaste ? "" : "disabled"}
      >
        <span class="terminal-context-icon">&#xE77F;</span>
        <span>粘贴</span>
      </button>
      <button data-terminal-menu-action="clear" class="terminal-context-item" type="button">
        <span class="terminal-context-icon">&#xE74D;</span>
        <span>清空</span>
      </button>
    </div>
  `;
}

function openTerminalContextMenu(clientX: number, clientY: number): void {
  const menuSize = terminalContextMenuSize();
  terminalContextMenu = {
    left: clamp(clientX, terminalMenuMargin, window.innerWidth - menuSize.width - terminalMenuMargin),
    top: clamp(clientY, terminalMenuMargin, window.innerHeight - menuSize.height - terminalMenuMargin),
    canCopy: terminal.hasSelection(),
    canPaste: state.mode === "connected",
  };
  renderApp();
  terminal.focus();
}

function closeTerminalContextMenu(): boolean {
  if (!terminalContextMenu) {
    return false;
  }

  terminalContextMenu = null;
  return true;
}

function terminalContextMenuSize(): { width: number; height: number } {
  const scale = currentScale();
  const width = clamp(172 * scale, 136, 172);
  const itemHeight = clamp(34 * scale, 28, 34);
  const padding = 8 * scale;
  const itemGap = 4;

  return {
    width,
    height: itemHeight * 3 + padding + itemGap,
  };
}

async function runTerminalContextMenuAction(action: TerminalContextMenuAction): Promise<void> {
  if (action === "copy") {
    const selection = terminal.getSelection();
    closeTerminalContextMenu();
    renderApp();
    if (selection.length > 0) {
      void navigator.clipboard.writeText(selection);
    }
    terminal.focus();
    return;
  }

  if (action === "paste") {
    closeTerminalContextMenu();
    renderApp();
    await pasteFromClipboard();
    return;
  }

  closeTerminalContextMenu();
  renderApp();
  terminal.clear();
  terminal.focus();
}

async function pasteFromClipboard(): Promise<void> {
  if (state.mode !== "connected") {
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      queueSerialText(normalizePastedText(text));
    }
  } catch (error) {
    terminal.writeln(`\x1b[31m读取剪贴板失败: ${toMessage(error)}\x1b[0m`);
  } finally {
    terminal.focus();
  }
}

function bindWindowChromeEvents(): void {
  void updateWindowMaximizeIcon();

  document.querySelector("#window-minimize")?.addEventListener("click", () => {
    void currentWindow.minimize();
  });

  document.querySelector("#window-maximize")?.addEventListener("click", () => {
    void toggleWindowMaximize();
  });

  document.querySelector("#window-close")?.addEventListener("click", () => {
    void currentWindow.close();
  });

  document.querySelector(".window-drag-region")?.addEventListener("dblclick", () => {
    void toggleWindowMaximize();
  });

  document.querySelectorAll<HTMLElement>("[data-resize-direction]").forEach((handle) => {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) {
        return;
      }

      const direction = handle.dataset.resizeDirection as ResizeDirection | undefined;
      if (!direction) {
        return;
      }

      event.preventDefault();
      void currentWindow.startResizeDragging(direction);
    });
  });
}

async function toggleWindowMaximize(): Promise<void> {
  await currentWindow.toggleMaximize();
  await updateWindowMaximizeIcon();
}

async function updateWindowMaximizeIcon(): Promise<void> {
  const icon = document.querySelector("#window-maximize-icon");
  if (!icon) {
    return;
  }

  try {
    icon.textContent = (await currentWindow.isMaximized()) ? "\uE923" : "\uE922";
  } catch {
    icon.textContent = "\uE922";
  }
}

function renderSegment(
  setting: keyof Pick<SerialConfig, "data_bits" | "parity" | "stop_bits">,
  options: SegmentOption[],
): string {
  const currentValue = String(state.config[setting]);
  const locked = state.mode === "connected" || state.mode === "connecting";

  return `
    <div class="segmented">
      ${options
        .map(
          (option) =>
            `<button type="button" data-setting="${setting}" data-value="${
              option.value
            }" class="${option.value === currentValue ? "active" : ""}" ${
              locked ? "disabled" : ""
            }>${escapeHtml(option.label)}</button>`,
        )
        .join("")}
    </div>
  `;
}

function renderPicker(id: PickerId, label: string, disabled: boolean): string {
  return `
    <div class="picker-anchor">
      <button class="picker-button" data-picker-id="${id}" type="button" aria-haspopup="listbox" aria-expanded="${
        state.activePicker === id ? "true" : "false"
      }" ${disabled ? "disabled" : ""}>
        <span>${escapeHtml(label)}</span>
        <span class="picker-chevron">▼</span>
      </button>
    </div>
  `;
}

function renderPickerPortal(): string {
  if (!state.activePicker || !state.pickerPosition) {
    return "";
  }

  const position = state.pickerPosition;
  return `
    <div
      id="picker-portal"
      class="picker-menu ${position.placement}"
      style="left: ${position.left}px; top: ${position.top}px; width: ${position.width}px; max-height: ${position.maxHeight}px"
    >
      <div id="picker-options" class="picker-options" style="max-height: ${position.maxHeight}px" role="listbox">
        ${renderPickerOptions()}
      </div>
    </div>
  `;
}

function renderPickerOptions(): string {
  const options = state.activePicker ? pickerOptions(state.activePicker) : [];
  if (options.length === 0) {
    return `<div class="picker-empty">暂无选项</div>`;
  }

  return options
    .map(
      (option) =>
        `<button type="button" class="picker-option${
          isPickerOptionActive(option) ? " active" : ""
        }" data-picker-value="${escapeAttribute(option.value)}" role="option" aria-selected="${
          isPickerOptionActive(option) ? "true" : "false"
        }">
          <span>${escapeHtml(option.label)}</span>
        </button>`,
    )
    .join("");
}

function bindPickerEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-picker-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const pickerId = button.dataset.pickerId as PickerId | undefined;
      if (pickerId) {
        togglePicker(pickerId, button);
      }
    });
  });

  bindPickerOptionButtons();
}

function bindPickerOptionButtons(): void {
  document.querySelectorAll<HTMLButtonElement>(".picker-option").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.pickerValue;
      if (value && state.activePicker) {
        selectPickerOption(state.activePicker, value);
      }
    });
  });
}

function togglePicker(id: PickerId, button: HTMLElement): void {
  if (state.activePicker === id) {
    closePicker();
    renderApp();
    return;
  }

  state.activePicker = id;
  state.pickerPosition = calculatePickerPosition(button, pickerOptions(id).length);
  renderApp();
}

function closePicker(): void {
  state.activePicker = null;
  state.pickerPosition = null;
}

function selectPickerOption(id: PickerId, value: string): void {
  if (id === "port") {
    state.config.port_name = value;
  } else if (id === "baud") {
    state.config.baud_rate = Number(value);
  } else {
    state.fontFamily = value;
    state.availableFonts = mergeFonts([value, ...state.availableFonts]);
    applyTerminalOptions();
  }

  closePicker();
  saveSettings();
  renderApp();
}

function pickerLabel(id: PickerId): string {
  if (id === "port") {
    return state.config.port_name || "未找到串口";
  }
  if (id === "baud") {
    return String(state.config.baud_rate);
  }
  return state.fontFamily;
}

function pickerOptions(id: PickerId): PickerOption[] {
  if (id === "port") {
    return state.ports.map((port) => ({ label: port, value: port }));
  }

  if (id === "baud") {
    return baudRates.map((rate) => ({ label: String(rate), value: String(rate) }));
  }

  return mergeFonts([state.fontFamily, ...state.availableFonts]).map((font) => ({
    label: font,
    value: font,
  }));
}

function isPickerOptionActive(option: PickerOption): boolean {
  if (state.activePicker === "port") {
    return option.value === state.config.port_name;
  }
  if (state.activePicker === "baud") {
    return Number(option.value) === state.config.baud_rate;
  }
  return option.value === state.fontFamily;
}

function calculatePickerPosition(button: HTMLElement, optionCount: number): DropdownPosition {
  const rect = button.getBoundingClientRect();
  const scale = currentScale();
  const margin = 8;
  const gap = 6;
  const rowHeight = 34 * scale;
  const menuPadding = 8 * scale;
  const desiredHeight = Math.min(Math.max(optionCount, 1), 8) * rowHeight + menuPadding;
  const width = Math.min(
    Math.max(rect.width, Math.min(260, window.innerWidth - margin * 2)),
    window.innerWidth - margin * 2,
  );
  const left = clamp(rect.left, margin, window.innerWidth - width - margin);
  const availableDown = window.innerHeight - rect.bottom - gap - margin;
  const availableUp = rect.top - gap - margin;
  const openUp = availableDown < Math.min(desiredHeight, 180 * scale) && availableUp > availableDown;
  const available = Math.max(72, openUp ? availableUp : availableDown);
  const maxHeight = Math.min(desiredHeight, available, window.innerHeight - margin * 2);
  const preferredTop = openUp ? rect.top - gap - maxHeight : rect.bottom + gap;
  const top = clamp(preferredTop, margin, window.innerHeight - maxHeight - margin);

  return {
    left,
    top,
    width,
    maxHeight,
    placement: openUp ? "up" : "down",
  };
}

function applySerialSetting(setting: string, value: string): void {
  if (state.mode === "connected" || state.mode === "connecting") {
    return;
  }

  if (setting === "data_bits") {
    state.config.data_bits = Number(value);
  } else if (setting === "parity") {
    state.config.parity = value as Parity;
  } else if (setting === "stop_bits") {
    state.config.stop_bits = Number(value);
  }

  saveSettings();
  renderApp();
}

function applyTerminalOptions(): void {
  terminal.options.fontFamily = terminalFontFamily();
  terminal.options.fontSize = state.fontSize;
  applyTerminalLineSpacing();
  queueFit();
  terminal.focus();
}

function applyTerminalLineSpacing(): void {
  const internals = terminal as unknown as GhosttyTerminalInternals;
  const renderer = internals.renderer;
  if (!renderer) {
    return;
  }

  renderer.remeasureFont();
  const baseMetrics = renderer.getMetrics();
  const rowHeight = Math.max(
    baseMetrics.height,
    Math.ceil(baseMetrics.height * state.lineSpacing),
  );
  const extraHeight = rowHeight - baseMetrics.height;

  // ghostty-web does not expose lineHeight; keep FitAddon, selection and rendering on one metric.
  renderer.metrics = {
    ...baseMetrics,
    height: rowHeight,
    baseline: baseMetrics.baseline + Math.floor(extraHeight / 2),
  };
  renderer.resize(terminal.cols, terminal.rows);
  if (internals.wasmTerm) {
    renderer.render(internals.wasmTerm, true, internals.viewportY, terminal);
  }
}

async function refreshPorts(): Promise<void> {
  try {
    const ports = await invoke<string[]>("list_ports");
    state.ports = ports;
    if (!state.config.port_name || !ports.includes(state.config.port_name)) {
      state.config.port_name = ports[0] ?? "";
      saveSettings();
    }
    state.lastError = "";
  } catch (error) {
    state.lastError = toMessage(error);
  }

  renderApp();
}

async function refreshFonts(): Promise<void> {
  try {
    const fonts = await invoke<string[]>("list_fonts");
    state.availableFonts = mergeFonts([state.fontFamily, ...fonts]);
  } catch {
    state.availableFonts = mergeFonts([state.fontFamily]);
  }

  renderApp();
}

async function toggleConnection(): Promise<void> {
  if (state.mode === "connected") {
    await disconnectSerial();
    return;
  }

  await connectSerial();
}

async function connectSerial(): Promise<void> {
  if (!state.config.port_name) {
    state.lastError = "请选择一个可用串口";
    renderApp();
    return;
  }

  state.mode = "connecting";
  state.lastError = "";
  clearPendingSerialText();
  clearPendingTerminalOutput();
  renderApp();

  try {
    await invoke<void>("connect", { config: state.config });
    state.mode = "connected";
    state.rxBytes = 0;
    state.txBytes = 0;
    terminal.writeln(`\x1b[32m已连接 ${connectionSummaryText()}\x1b[0m`);
  } catch (error) {
    state.mode = "error";
    state.lastError = toMessage(error);
    terminal.writeln(`\x1b[31m${state.lastError}\x1b[0m`);
  }

  renderApp();
}

async function disconnectSerial(): Promise<void> {
  clearPendingSerialText();
  clearPendingTerminalOutput();
  try {
    await invoke<void>("disconnect");
  } catch (error) {
    state.lastError = toMessage(error);
  }

  state.mode = "disconnected";
  terminal.writeln("\x1b[90m串口已关闭\x1b[0m");
  renderApp();
}

function queueSerialText(text: string): void {
  if (state.mode !== "connected" || text.length === 0) {
    return;
  }

  const shouldFlushNow =
    shouldFlushImmediately(text) || pendingSerialText.length + text.length >= serialWriteChunkSize;

  pendingSerialText += text;
  scheduleSerialFlush(shouldFlushNow ? 0 : serialWriteDelayMs);
}

function shouldFlushImmediately(text: string): boolean {
  return /[\r\n\b\x1b\x7f\u0003\u0004\u001a]/.test(text);
}

function scheduleSerialFlush(delayMs: number): void {
  if (delayMs === 0 && serialFlushTimer !== null) {
    window.clearTimeout(serialFlushTimer);
    serialFlushTimer = null;
  }

  if (serialFlushTimer !== null) {
    return;
  }

  serialFlushTimer = window.setTimeout(() => {
    serialFlushTimer = null;
    void flushSerialText();
  }, delayMs);
}

async function flushSerialText(): Promise<void> {
  if (serialWriteInFlight || pendingSerialText.length === 0) {
    return;
  }

  const text = pendingSerialText.slice(0, serialWriteChunkSize);
  pendingSerialText = pendingSerialText.slice(text.length);
  serialWriteInFlight = true;

  try {
    state.txBytes = await invoke<number>("write_text", { text });
    requestStatsUpdate();
  } catch (error) {
    state.lastError = toMessage(error);
    state.mode = "error";
    terminal.writeln(`\x1b[31m${state.lastError}\x1b[0m`);
    renderApp();
  } finally {
    serialWriteInFlight = false;
    if (pendingSerialText.length > 0) {
      scheduleSerialFlush(0);
    }
  }
}

function clearPendingSerialText(): void {
  pendingSerialText = "";
  if (serialFlushTimer !== null) {
    window.clearTimeout(serialFlushTimer);
    serialFlushTimer = null;
  }
}

function clearPendingTerminalOutput(): void {
  pendingTerminalOutputChunks = [];
  pendingTerminalOutputLength = 0;
  pendingTerminalOutputBytes = 0;
}

function normalizeTerminalInput(data: string): string {
  return data.replace(/\x1b\[3~/g, "\b").replace(/\x7f/g, "\b");
}

function normalizePastedText(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function copySelection(clearAfterCopy = false): void {
  const selection = terminal.getSelection();
  if (selection.length > 0) {
    void navigator.clipboard.writeText(selection);
    if (clearAfterCopy) {
      terminal.clearSelection();
    }
  }
  terminal.focus();
}

function updateScale(): void {
  const scale = Math.min(
    1.18,
    Math.max(0.55, Math.min(window.innerWidth / 1440, window.innerHeight / 850)),
  );
  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(3));
}

function currentScale(): number {
  return Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"),
  ) || 1;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function queueFit(): void {
  if (fitQueued) {
    return;
  }

  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    try {
      fitAddon.fit();
    } catch {
      // The fit addon can run before the terminal has completed its first layout pass.
    }
  });
}

function updateStats(): void {
  updateText("#rx-stat", `RX ${formatBytes(state.rxBytes)}`);
  updateText("#tx-stat", `TX ${formatBytes(state.txBytes)}`);
}

function requestStatsUpdate(): void {
  if (pendingStatsUpdate) {
    return;
  }

  pendingStatsUpdate = true;
  requestAnimationFrame(() => {
    pendingStatsUpdate = false;
    updateStats();
  });
}

function queueSerialOutput(data: number[], byteCount: number): void {
  if (data.length === 0 && byteCount === 0) {
    return;
  }

  const chunk = new Uint8Array(data);
  pendingTerminalOutputChunks.push(chunk);
  pendingTerminalOutputLength += chunk.length;
  pendingTerminalOutputBytes += byteCount;

  if (serialOutputQueued) {
    return;
  }

  serialOutputQueued = true;
  requestAnimationFrame(() => {
    serialOutputQueued = false;
    const outputChunks = pendingTerminalOutputChunks;
    const outputLength = pendingTerminalOutputLength;
    pendingTerminalOutputChunks = [];
    pendingTerminalOutputLength = 0;

    const rxBytes = pendingTerminalOutputBytes;
    pendingTerminalOutputBytes = 0;

    if (outputLength > 0) {
      terminal.write(mergeTerminalOutputChunks(outputChunks, outputLength));
    }
    if (rxBytes > 0) {
      state.rxBytes += rxBytes;
    }

    requestStatsUpdate();
  });
}

function mergeTerminalOutputChunks(chunks: Uint8Array[], totalLength: number): Uint8Array {
  if (chunks.length === 1) {
    return chunks[0];
  }

  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function updateOutput(selector: string, text: string): void {
  const output = document.querySelector<HTMLOutputElement>(selector);
  if (output) {
    output.value = text;
    output.textContent = text;
  }
}

function updateText(selector: string, text: string): void {
  const element = document.querySelector(selector);
  if (element) {
    element.textContent = text;
  }
}

function terminalFontFamily(): string {
  return `${state.fontFamily}, "Cascadia Mono", Consolas, "Microsoft YaHei UI", monospace`;
}

function mergeFonts(fonts: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const font of [...fallbackFontFamilies, ...fonts]) {
    const value = font.trim();
    if (value.length === 0) {
      continue;
    }

    const key = value.toLocaleLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(value);
  }

  return merged.sort((a, b) =>
    a.localeCompare(b, "zh-Hans", {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

function readSavedSettings(): SavedSettings {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) {
      return {};
    }
    const value = JSON.parse(raw) as SavedSettings;
    return normalizeSavedSettings(value);
  } catch {
    return {};
  }
}

function normalizeSavedSettings(value: SavedSettings): SavedSettings {
  const config = value.config ?? {};
  const parity = config.parity === "even" || config.parity === "odd" ? config.parity : "none";

  return {
    config: {
      port_name: typeof config.port_name === "string" ? config.port_name : "",
      baud_rate:
        typeof config.baud_rate === "number" && Number.isFinite(config.baud_rate)
          ? config.baud_rate
          : 1500000,
      data_bits: [5, 6, 7, 8].includes(config.data_bits ?? 0) ? config.data_bits : 8,
      parity,
      stop_bits: config.stop_bits === 2 ? 2 : 1,
    },
    fontFamily:
      typeof value.fontFamily === "string" && value.fontFamily.length > 0
        ? value.fontFamily
        : fallbackFontFamilies[0],
    fontSize:
      typeof value.fontSize === "number" && Number.isFinite(value.fontSize)
        ? Math.min(34, Math.max(12, value.fontSize))
        : 18,
    lineSpacing:
      typeof value.lineSpacing === "number" && Number.isFinite(value.lineSpacing)
        ? Math.min(1.6, Math.max(0.9, value.lineSpacing))
        : 1,
  };
}

function saveSettings(): void {
  const value: SavedSettings = {
    config: state.config,
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
    lineSpacing: state.lineSpacing,
  };
  localStorage.setItem(storageKey, JSON.stringify(value));
}

function statusTone(): string {
  if (state.mode === "connected") {
    return "connected";
  }
  if (state.mode === "error") {
    return "error";
  }
  return "disconnected";
}

function statusText(): string {
  if (state.mode === "connected") {
    return `已连接 ${connectionSummaryText()}`;
  }
  if (state.mode === "connecting") {
    return "连接中";
  }
  if (state.mode === "error") {
    return "连接异常";
  }
  return "未连接";
}

function connectionButtonText(): string {
  if (state.mode === "connected") {
    return "关闭串口";
  }
  if (state.mode === "connecting") {
    return "正在连接";
  }
  return "打开串口";
}

function connectionDetailText(): string {
  if (state.mode === "connected") {
    return connectionSummaryText();
  }
  if (state.mode === "connecting") {
    return "正在建立连接";
  }
  return "未连接";
}

function connectionSummaryText(): string {
  return `${state.config.port_name} · ${state.config.baud_rate} · ${serialProfileText()}`;
}

function serialProfileText(): string {
  return `${state.config.data_bits}${parityLabel(state.config.parity)}${state.config.stop_bits}`;
}

function parityLabel(parity: Parity): string {
  if (parity === "even") {
    return "E";
  }
  if (parity === "odd") {
    return "O";
  }
  return "N";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function setupBackendListeners(): Promise<void> {
  await listen<SerialDataPayload>("serial-data", (event) => {
    queueSerialOutput(event.payload.data, event.payload.byte_count);
  });

  await listen<SerialErrorPayload>("serial-error", (event) => {
    state.mode = "error";
    state.lastError = event.payload.message;
    clearPendingSerialText();
    clearPendingTerminalOutput();
    terminal.writeln(`\x1b[31m${event.payload.message}\x1b[0m`);
    void invoke<void>("disconnect");
    renderApp();
  });
}

window.addEventListener("resize", () => {
  updateScale();
  void updateWindowMaximizeIcon();
  let shouldRender = false;

  if (closeTerminalContextMenu()) {
    shouldRender = true;
  }

  if (state.activePicker) {
    const button = document.querySelector<HTMLElement>(`[data-picker-id="${state.activePicker}"]`);
    if (button) {
      state.pickerPosition = calculatePickerPosition(
        button,
        pickerOptions(state.activePicker).length,
      );
      shouldRender = true;
    }
  }

  if (shouldRender) {
    renderApp();
  }

  queueFit();
});

document.addEventListener("pointerdown", (event) => {
  const target = event.target;
  let shouldRender = false;

  if (terminalContextMenu && !(target instanceof Element && target.closest("#terminal-context-menu"))) {
    shouldRender = closeTerminalContextMenu();
  }

  if (state.activePicker) {
    if (target instanceof Element && (target.closest(".picker-anchor") || target.closest("#picker-portal"))) {
      if (shouldRender) {
        renderApp();
      }
      return;
    }

    closePicker();
    shouldRender = true;
  }

  if (shouldRender) {
    renderApp();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") {
    return;
  }

  let shouldRender = closeTerminalContextMenu();

  if (state.activePicker) {
    closePicker();
    shouldRender = true;
  }

  if (shouldRender) {
    renderApp();
  }
});

updateScale();
renderApp();
void setupBackendListeners();
void refreshFonts();
void refreshPorts();
