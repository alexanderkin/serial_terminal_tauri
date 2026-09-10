import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type ConnectionMode = "disconnected" | "connecting" | "connected" | "error";
type Parity = "none" | "even" | "odd";

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
  config: SerialConfig;
  mode: ConnectionMode;
  rxBytes: number;
  txBytes: number;
  lastError: string;
  fontFamily: string;
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

const baudRates = [
  110, 300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200,
  128000, 230400, 256000, 460800, 500000, 576000, 921600, 1000000, 1500000,
  2000000, 3000000, 4000000,
];

const fontFamilies = [
  "Cascadia Mono",
  "Cascadia Code",
  "JetBrains Mono",
  "JetBrainsMonoNerdFontMono-Regular",
  "Consolas",
  "Microsoft YaHei UI",
  "monospace",
];

const storageKey = "serial-terminal-settings-v1";
const savedSettings = readSavedSettings();
const state: AppState = {
  ports: [],
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
  fontFamily: savedSettings.fontFamily ?? fontFamilies[0],
  fontSize: savedSettings.fontSize ?? 18,
  lineSpacing: savedSettings.lineSpacing ?? 1,
};

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Missing #app root");
}
const app: HTMLDivElement = appRoot;

const serialDecoder = new TextDecoder("utf-8");
const fitAddon = new FitAddon();
const terminal = new Terminal({
  allowProposedApi: false,
  convertEol: false,
  cursorBlink: true,
  cursorStyle: "bar",
  disableStdin: false,
  drawBoldTextInBrightColors: false,
  fontFamily: terminalFontFamily(),
  fontSize: state.fontSize,
  lineHeight: state.lineSpacing,
  scrollback: 100000,
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
      return false;
    }
  }

  return true;
});

let terminalHost: HTMLDivElement | null = null;
let terminalInputDisposable: { dispose(): void } | null = null;
let resizeObserver: ResizeObserver | null = null;
let fitQueued = false;

function renderApp(): void {
  const locked = state.mode === "connected" || state.mode === "connecting";

  app.innerHTML = `
    <div class="app-shell">
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
                <select id="port-select" ${locked ? "disabled" : ""}>
                  ${renderPortOptions()}
                </select>
                <button id="refresh-ports" class="secondary-button" type="button" ${locked ? "disabled" : ""}>刷新</button>
              </div>
            </label>
            <label class="field">
              <span>波特率</span>
              <select id="baud-select" ${locked ? "disabled" : ""}>
                ${baudRates
                  .map(
                    (rate) =>
                      `<option value="${rate}"${selectedAttr(
                        rate,
                        state.config.baud_rate,
                      )}>${rate}</option>`,
                  )
                  .join("")}
              </select>
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
              <select id="font-select">
                ${fontFamilies
                  .map(
                    (font) =>
                      `<option value="${escapeAttribute(font)}"${selectedAttr(
                        font,
                        state.fontFamily,
                      )}>${escapeHtml(font)}</option>`,
                  )
                  .join("")}
              </select>
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
    </div>
  `;

  bindChromeEvents();
  attachTerminal();
  updateStats();
}

function attachTerminal(): void {
  const host = document.querySelector<HTMLDivElement>("#terminal-host");
  if (!host || host === terminalHost) {
    return;
  }

  terminalHost = host;
  if (terminal.element) {
    host.replaceChildren(terminal.element);
  } else {
    terminal.open(host);
  }
  terminal.focus();
  queueFit();

  resizeObserver?.disconnect();
  resizeObserver = new ResizeObserver(() => {
    queueFit();
  });
  resizeObserver.observe(host);

  terminalInputDisposable?.dispose();
  terminalInputDisposable = terminal.onData((data) => {
    void sendText(normalizeTerminalInput(data));
  });

  host.addEventListener("contextmenu", (event) => {
    if (terminal.hasSelection()) {
      event.preventDefault();
      copySelection(true);
    }
  });
}

function bindChromeEvents(): void {
  const portSelect = document.querySelector<HTMLSelectElement>("#port-select");
  portSelect?.addEventListener("change", () => {
    state.config.port_name = portSelect.value;
    saveSettings();
  });

  const baudSelect = document.querySelector<HTMLSelectElement>("#baud-select");
  baudSelect?.addEventListener("change", () => {
    state.config.baud_rate = Number(baudSelect.value);
    saveSettings();
  });

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
    terminal.clear();
    terminal.focus();
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

  const fontSelect = document.querySelector<HTMLSelectElement>("#font-select");
  fontSelect?.addEventListener("change", () => {
    state.fontFamily = fontSelect.value;
    saveSettings();
    applyTerminalOptions();
  });

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

function renderPortOptions(): string {
  if (state.ports.length === 0) {
    return `<option value="">未找到串口</option>`;
  }

  return state.ports
    .map(
      (port) =>
        `<option value="${escapeAttribute(port)}"${selectedAttr(
          port,
          state.config.port_name,
        )}>${escapeHtml(port)}</option>`,
    )
    .join("");
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
  terminal.options.lineHeight = state.lineSpacing;
  queueFit();
  terminal.focus();
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
  renderApp();

  try {
    await invoke<void>("connect", { config: state.config });
    state.mode = "connected";
    state.rxBytes = 0;
    state.txBytes = 0;
    terminal.writeln(`\x1b[32m已连接 ${state.config.port_name} @ ${state.config.baud_rate}\x1b[0m`);
  } catch (error) {
    state.mode = "error";
    state.lastError = toMessage(error);
    terminal.writeln(`\x1b[31m${state.lastError}\x1b[0m`);
  }

  renderApp();
}

async function disconnectSerial(): Promise<void> {
  try {
    await invoke<void>("disconnect");
  } catch (error) {
    state.lastError = toMessage(error);
  }

  state.mode = "disconnected";
  terminal.writeln("\x1b[90m串口已关闭\x1b[0m");
  renderApp();
}

async function sendText(text: string): Promise<void> {
  if (state.mode !== "connected" || text.length === 0) {
    return;
  }

  try {
    state.txBytes = await invoke<number>("write_text", { text });
    updateStats();
  } catch (error) {
    state.lastError = toMessage(error);
    state.mode = "error";
    terminal.writeln(`\x1b[31m${state.lastError}\x1b[0m`);
    renderApp();
  }
}

function normalizeTerminalInput(data: string): string {
  return data.replace(/\x1b\[3~/g, "\b").replace(/\x7f/g, "\b");
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
      // The fit addon can run before xterm has completed its first layout pass.
    }
  });
}

function updateStats(): void {
  updateText("#rx-stat", `RX ${formatBytes(state.rxBytes)}`);
  updateText("#tx-stat", `TX ${formatBytes(state.txBytes)}`);
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
        : fontFamilies[0],
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
    return "已连接";
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
    return `${state.config.port_name} · ${state.config.baud_rate}`;
  }
  if (state.mode === "connecting") {
    return "正在建立连接";
  }
  return "未连接";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function selectedAttr<T extends string | number>(value: T, current: T): string {
  return value === current ? " selected" : "";
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
    state.rxBytes += event.payload.byte_count;
    const text = serialDecoder.decode(new Uint8Array(event.payload.data), { stream: true });
    terminal.write(text);
    updateStats();
  });

  await listen<SerialErrorPayload>("serial-error", (event) => {
    state.mode = "error";
    state.lastError = event.payload.message;
    terminal.writeln(`\x1b[31m${event.payload.message}\x1b[0m`);
    void invoke<void>("disconnect");
    renderApp();
  });
}

window.addEventListener("resize", () => {
  updateScale();
  queueFit();
});

updateScale();
renderApp();
void setupBackendListeners();
void refreshPorts();
