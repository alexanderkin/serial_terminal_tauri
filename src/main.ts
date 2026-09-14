import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

type ConnectionMode = "disconnected" | "connecting" | "connected" | "error";
type Parity = "none" | "even" | "odd";
type PickerId =
  | "port"
  | "baud"
  | "dataBits"
  | "parity"
  | "stopBits"
  | "font"
  | "remoteAdb"
  | "adbDevice"
  | "scrcpyCodec";
type ScrcpyVideoCodec = "h264" | "h265" | "av1";
type TerminalContextMenuAction = "copy" | "paste" | "clear";
type TerminalSessionKind = "serial" | "adbShell";
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

interface TerminalSession {
  id: string;
  kind: TerminalSessionKind;
  title: string;
  deviceId?: string;
  shellId?: number;
  terminal: Terminal;
  fitAddon: FitAddon;
  inputDisposable: { dispose(): void };
  pendingOutput: Uint8Array[];
  pendingOutputIndex: number;
  pendingOutputBytes: number;
  outputWriting: boolean;
  closed: boolean;
}

interface SerialConfig {
  port_name: string;
  baud_rate: number;
  data_bits: number;
  parity: Parity;
  stop_bits: number;
}

interface SerialDataPayload {
  data: string;
  byte_count: number;
}

interface SerialErrorPayload {
  message: string;
}

interface AdbCommandResult {
  address: string;
  message: string;
}

interface AdbDevice {
  id: string;
  state: string;
  is_remote: boolean;
}

interface AndroidStatePayload {
  devices: AdbDevice[];
  scrcpy_devices: string[];
}

interface AdbShellDataPayload {
  device_id: string;
  shell_id: number;
  data: string;
  byte_count: number;
}

interface AdbShellExitPayload {
  device_id: string;
  shell_id: number;
  message: string;
}

interface AdbShellStartPayload {
  device_id: string;
  shell_id: number;
}

interface ScrcpyOptions {
  video_codec: ScrcpyVideoCodec;
  video_bit_rate: string;
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
  remoteAdbHistory: string[];
  remoteAdbInput: string;
  selectedRemoteAdb: string;
  adbDevices: AdbDevice[];
  selectedAdbDevice: string;
  scrcpyDevices: string[];
  scrcpyOptions: ScrcpyOptions;
  scrcpySessionOptions: Record<string, ScrcpyOptions>;
  adbBusy: boolean;
  scrcpyBusy: boolean;
  adbShellBusy: boolean;
  activeTerminalId: string;
  adbShellDevices: string[];
  androidMessage: string;
  androidError: string;
}

interface SavedSettings {
  config?: Partial<SerialConfig>;
  fontFamily?: string;
  fontSize?: number;
  lineSpacing?: number;
  remoteAdbHistory?: string[];
  selectedRemoteAdb?: string;
  selectedAdbDevice?: string;
  scrcpyOptions?: Partial<ScrcpyOptions>;
}

interface PickerOption {
  label: string;
  value: string;
  detail?: string;
  status?: string;
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
const defaultScrcpyBitRate = "8M";
const adbStateRefreshIntervalMs = 5000;
const scrcpyStateRefreshIntervalMs = 800;
const serialTerminalId = "serial";
const serialWriteChunkSize = 64;
const serialWriteMaxChunksPerPump = 4;
const serialWriteMaxInFlight = 8;
const terminalOutputChunkBytes = 64 * 1024;
const perfWarnMs = 50;
const mainThreadLagWarnMs = 120;
const terminalMenuMargin = 8;
const textEncoder = new TextEncoder();
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
  remoteAdbHistory: savedSettings.remoteAdbHistory ?? [],
  remoteAdbInput: savedSettings.selectedRemoteAdb ?? savedSettings.remoteAdbHistory?.[0] ?? "",
  selectedRemoteAdb: savedSettings.selectedRemoteAdb ?? savedSettings.remoteAdbHistory?.[0] ?? "",
  adbDevices: [],
  selectedAdbDevice: savedSettings.selectedAdbDevice ?? "",
  scrcpyDevices: [],
  scrcpyOptions: {
    video_codec: savedSettings.scrcpyOptions?.video_codec ?? "h265",
    video_bit_rate: savedSettings.scrcpyOptions?.video_bit_rate ?? defaultScrcpyBitRate,
  },
  scrcpySessionOptions: {},
  adbBusy: false,
  scrcpyBusy: false,
  adbShellBusy: false,
  activeTerminalId: serialTerminalId,
  adbShellDevices: [],
  androidMessage: "",
  androidError: "",
};

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Missing #app root");
}
const app: HTMLDivElement = appRoot;
const currentWindow = getCurrentWindow();

const terminalSessions = new Map<string, TerminalSession>();
const serialSession = createTerminalSession(serialTerminalId, "serial", "串口终端");
const terminal = serialSession.terminal;
const closingAdbShellDevices = new Set<string>();

let terminalHost: HTMLDivElement | null = null;
let resizeObserver: ResizeObserver | null = null;
let fitQueued = false;
let pendingSerialText = "";
let serialWritePumpQueued = false;
let serialWritePumpTimer: number | null = null;
let serialWritesInFlight = 0;
let terminalContextMenu: TerminalContextMenuState | null = null;
let pendingStatsUpdate = false;
let lastPerfReportAt = 0;
let sidebarScrollTop = 0;

function renderApp(): void {
  const locked = state.mode === "connected" || state.mode === "connecting";
  const serialConnectionDetail = connectionDetailText();
  captureSidebarScroll();

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
        ${renderTerminalTabs()}
        ${renderTopbarStats()}
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
            <div class="serial-profile-row">
              <label class="field compact-field">
                <span>波特率</span>
                ${renderPicker("baud", pickerLabel("baud"), locked)}
              </label>
              <label class="field compact-field">
                <span>数据位</span>
                ${renderPicker("dataBits", pickerLabel("dataBits"), locked)}
              </label>
              <label class="field compact-field">
                <span>校验位</span>
                ${renderPicker("parity", pickerLabel("parity"), locked)}
              </label>
              <label class="field compact-field">
                <span>停止位</span>
                ${renderPicker("stopBits", pickerLabel("stopBits"), locked)}
              </label>
            </div>
            <div class="section-title subsection-title section-title-row">
              <span>连接</span>
              <span class="section-status">
                <span class="small-dot ${statusTone()}"></span>
                <span title="${escapeAttribute(serialConnectionDetail)}">${escapeHtml(serialConnectionDetail)}</span>
              </span>
            </div>
            <button id="connection-toggle" class="primary-button ${state.mode}" type="button" ${
              state.mode === "connecting" || (!state.config.port_name && state.mode !== "connected")
                ? "disabled"
                : ""
            }>
              ${connectionButtonText()}
            </button>
            ${state.lastError ? `<div class="error-text">${escapeHtml(state.lastError)}</div>` : ""}
          </section>

          ${renderAndroidSections()}

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
  restoreSidebarScroll();
}

function captureSidebarScroll(): void {
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  if (sidebar) {
    sidebarScrollTop = sidebar.scrollTop;
  }
}

function restoreSidebarScroll(): void {
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  if (sidebar) {
    sidebar.scrollTop = sidebarScrollTop;
  }
}

function renderAndroidSections(): string {
  const remoteAddress = currentRemoteAdbAddress();
  const remoteStatus = remoteAdbStatus(remoteAddress);
  const selectedDeviceStatus = adbDeviceState(state.selectedAdbDevice);
  const scrcpyRunning = isScrcpyRunning(state.selectedAdbDevice);
  const scrcpyOptions = selectedScrcpyOptions();
  const parametersLocked = scrcpyParametersLocked();
  const remoteDetail = remoteAdbDetailText(remoteAddress);
  const scrcpyDetail = scrcpyDetailText();

  return `
    <section class="settings-section">
      <div class="section-title section-title-row">
        <span>远程 ADB</span>
        <span class="section-status">
          <span id="remote-adb-status-dot" class="small-dot ${adbStatusTone(remoteStatus)}"></span>
          <span id="remote-adb-status-text" title="${escapeAttribute(remoteDetail)}">${escapeHtml(remoteDetail)}</span>
        </span>
      </div>
      <label class="field">
        <span>IP 地址</span>
        <input
          id="remote-adb-address"
          class="text-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="192.168.1.20:5555"
          value="${escapeAttribute(state.remoteAdbInput)}"
          ${state.adbBusy ? "disabled" : ""}
        />
      </label>
      <label class="field">
        <span>历史设备</span>
        <div class="field-row">
          ${renderPicker("remoteAdb", pickerLabel("remoteAdb"), state.adbBusy || state.remoteAdbHistory.length === 0)}
          <button id="refresh-adb" class="secondary-button" type="button" ${state.adbBusy ? "disabled" : ""}>
            刷新
          </button>
        </div>
      </label>
      <button
        id="adb-toggle"
        class="secondary-button full-button ${remoteStatus === "device" ? "danger-button" : ""}"
        type="button"
        ${state.adbBusy || !remoteAddress ? "disabled" : ""}
      >
        ${remoteAdbButtonText()}
      </button>
    </section>

    <section class="settings-section">
      <div class="section-title section-title-row">
        <span>SCRCPY</span>
        <span class="section-status">
          <span id="adb-device-status-dot" class="small-dot ${adbStatusTone(selectedDeviceStatus)}"></span>
          <span id="adb-device-status-text" title="${escapeAttribute(scrcpyDetail)}">${escapeHtml(scrcpyDetail)}</span>
        </span>
      </div>
      <label class="field">
        <span>ADB 设备</span>
        <div class="field-row">
          ${renderPicker("adbDevice", pickerLabel("adbDevice"), state.adbBusy || state.adbDevices.length === 0)}
          <button
            id="refresh-scrcpy-devices"
            class="secondary-button"
            type="button"
            ${state.adbBusy || state.scrcpyBusy ? "disabled" : ""}
          >
            刷新
          </button>
        </div>
      </label>
      <div class="scrcpy-options-row">
        <label class="field compact-field">
          <span>视频编码</span>
          ${renderPicker("scrcpyCodec", pickerLabel("scrcpyCodec"), parametersLocked)}
        </label>
        <label class="field compact-field">
          <span>视频码率</span>
          <input
            id="scrcpy-bit-rate"
            class="text-input"
            type="text"
            spellcheck="false"
            autocomplete="off"
            placeholder="${defaultScrcpyBitRate}"
            value="${escapeAttribute(scrcpyOptions.video_bit_rate)}"
            ${parametersLocked ? "disabled" : ""}
          />
        </label>
      </div>
      <button
        id="scrcpy-toggle"
        class="primary-button ${scrcpyRunning ? "connected" : ""}"
        type="button"
        ${state.scrcpyBusy || !canToggleScrcpy() ? "disabled" : ""}
      >
        ${scrcpyButtonText()}
      </button>
      <button
        id="adb-shell-open"
        class="secondary-button full-button ${isAdbShellRunning(state.selectedAdbDevice) ? "danger-button" : ""}"
        type="button"
        ${state.adbShellBusy || !canOpenAdbShell() ? "disabled" : ""}
      >
        ${adbShellButtonText()}
      </button>
      ${state.androidMessage ? `<div class="helper-text">${escapeHtml(state.androidMessage)}</div>` : ""}
      ${state.androidError ? `<div class="error-text">${escapeHtml(state.androidError)}</div>` : ""}
    </section>
  `;
}

function createTerminalSession(
  id: string,
  kind: TerminalSessionKind,
  title: string,
  deviceId?: string,
): TerminalSession {
  const sessionTerminal = new Terminal({
    allowTransparency: false,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: "bar",
    disableStdin: false,
    fontFamily: terminalFontFamily(),
    fontSize: state.fontSize,
    lineHeight: state.lineSpacing,
    rightClickSelectsWord: false,
    scrollback: 10000,
    smoothScrollDuration: 0,
    theme: terminalTheme(),
  });
  const sessionFitAddon = new FitAddon();
  const session: TerminalSession = {
    id,
    kind,
    title,
    deviceId,
    terminal: sessionTerminal,
    fitAddon: sessionFitAddon,
    inputDisposable: { dispose: () => {} },
    pendingOutput: [],
    pendingOutputIndex: 0,
    pendingOutputBytes: 0,
    outputWriting: false,
    closed: false,
  };

  sessionTerminal.loadAddon(sessionFitAddon);
  sessionTerminal.attachCustomKeyEventHandler((event) => {
    if (event.type === "keydown" && event.ctrlKey && event.key.toLowerCase() === "c") {
      if (sessionTerminal.hasSelection()) {
        copyTerminalSelection(sessionTerminal, true);
        return false;
      }
    }

    return true;
  });
  session.inputDisposable = sessionTerminal.onData((data) => {
    if (session.kind === "serial") {
      queueSerialText(normalizeTerminalInput(data));
      return;
    }

    if (session.deviceId && !session.closed) {
      queueTerminalText(session, data);
    }
  });

  terminalSessions.set(id, session);
  return session;
}

function terminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  return {
    background: "#1E1E2E",
    foreground: "#CDD6F4",
    cursor: "#F5E0DC",
    cursorAccent: "#1E1E2E",
    selectionBackground: "#585B70",
    black: "#45475A",
    red: "#F38BA8",
    green: "#A6E3A1",
    yellow: "#F9E2AF",
    blue: "#89B4FA",
    magenta: "#F5C2E7",
    cyan: "#94E2D5",
    white: "#BAC2DE",
    brightBlack: "#585B70",
    brightRed: "#F38BA8",
    brightGreen: "#A6E3A1",
    brightYellow: "#F9E2AF",
    brightBlue: "#89B4FA",
    brightMagenta: "#F5C2E7",
    brightCyan: "#94E2D5",
    brightWhite: "#A6ADC8",
  };
}

function renderTerminalTabs(): string {
  return `
    <div class="terminal-tabs" role="tablist" aria-label="终端标签">
      ${Array.from(terminalSessions.values()).map(renderTerminalTab).join("")}
    </div>
  `;
}

function renderTopbarStats(): string {
  if (activeTerminalSession().kind !== "serial") {
    return `<div class="topbar-actions" aria-hidden="true"></div>`;
  }

  return `
    <div class="topbar-actions">
      <span id="rx-stat" class="metric">RX ${formatBytes(state.rxBytes)}</span>
      <span id="tx-stat" class="metric">TX ${formatBytes(state.txBytes)}</span>
    </div>
  `;
}

function renderTerminalTab(session: TerminalSession): string {
  const active = activeTerminalSession().id === session.id;
  const tone = terminalSessionTone(session);
  return `
    <button
      class="terminal-tab ${active ? "active" : ""} ${session.closed ? "closed" : ""}"
      type="button"
      role="tab"
      aria-selected="${active ? "true" : "false"}"
      data-terminal-tab-id="${escapeAttribute(session.id)}"
      title="${escapeAttribute(session.title)}"
    >
      <span class="small-dot ${tone}"></span>
      <span class="terminal-tab-label">${escapeHtml(session.title)}</span>
      ${
        session.kind === "adbShell" && session.deviceId
          ? `<span class="terminal-tab-close" data-adb-shell-close-device="${escapeAttribute(session.deviceId)}" title="关闭 ADB Shell">×</span>`
          : ""
      }
    </button>
  `;
}

function terminalSessionTone(session: TerminalSession): string {
  if (session.kind === "serial") {
    return statusTone();
  }

  if (session.closed) {
    return "disconnected";
  }

  return session.deviceId && isAdbShellRunning(session.deviceId) ? "connected" : "warning";
}

function bindTerminalTabEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-terminal-tab-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const closeTarget = (event.target as Element | null)?.closest<HTMLElement>(
        "[data-adb-shell-close-device]",
      );
      if (closeTarget?.dataset.adbShellCloseDevice) {
        event.preventDefault();
        event.stopPropagation();
        void closeAdbShellTab(closeTarget.dataset.adbShellCloseDevice);
        return;
      }

      const tabId = button.dataset.terminalTabId;
      if (tabId) {
        activateTerminalTab(tabId);
      }
    });
  });
}

function activateTerminalTab(id: string): void {
  if (!terminalSessions.has(id)) {
    return;
  }

  state.activeTerminalId = id;
  closeTerminalContextMenu();
  renderApp();
}

function activeTerminalSession(): TerminalSession {
  return terminalSessions.get(state.activeTerminalId) ?? serialSession;
}

function activeTerminal(): Terminal {
  return activeTerminalSession().terminal;
}

function focusActiveTerminal(): void {
  activeTerminal().focus();
}

function adbShellTerminalId(deviceId: string): string {
  return `adb-shell:${deviceId}`;
}

function adbShellTitle(deviceId: string, closed = false): string {
  return `ADB Shell · ${deviceId}${closed ? " · 已退出" : ""}`;
}

function ensureAdbShellSession(
  deviceId: string,
  activate = false,
  markRunning = true,
  shellId?: number,
): TerminalSession {
  const id = adbShellTerminalId(deviceId);
  let session = terminalSessions.get(id);
  if (!session) {
    session = createTerminalSession(id, "adbShell", adbShellTitle(deviceId), deviceId);
  } else {
    session.closed = false;
    session.title = adbShellTitle(deviceId);
  }

  if (typeof shellId === "number") {
    session.shellId = shellId;
  } else if (!markRunning) {
    session.shellId = undefined;
  }

  if (markRunning && !state.adbShellDevices.includes(deviceId)) {
    state.adbShellDevices = [...state.adbShellDevices, deviceId].sort();
  }

  if (activate) {
    state.activeTerminalId = id;
  }

  return session;
}

function canPasteToTerminal(session: TerminalSession): boolean {
  if (session.kind === "serial") {
    return state.mode === "connected";
  }

  return !!session.deviceId && !session.closed && isAdbShellRunning(session.deviceId);
}

function queueTerminalText(session: TerminalSession, text: string): void {
  if (session.kind === "serial") {
    queueSerialText(text);
    return;
  }

  if (session.deviceId) {
    queueAdbShellText(session.deviceId, normalizeAdbShellInput(text));
  }
}

function attachTerminal(): void {
  const host = document.querySelector<HTMLDivElement>("#terminal-host");
  if (!host) {
    return;
  }

  const session = activeTerminalSession();
  if (host !== terminalHost || session.terminal.element?.parentElement !== host) {
    if (session.terminal.element) {
      host.replaceChildren(session.terminal.element);
    } else {
      session.terminal.open(host);
    }
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

  session.terminal.focus();
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

  document.querySelectorAll<HTMLButtonElement>('[data-terminal-menu-action]').forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.terminalMenuAction as TerminalContextMenuAction | undefined;
      if (!action) {
        return;
      }
      void runTerminalContextMenuAction(action);
    });
  });

  bindPickerEvents();
  bindAndroidEvents();
  bindTerminalTabEvents();

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

function bindAndroidEvents(): void {
  const remoteAdbAddress = document.querySelector<HTMLInputElement>("#remote-adb-address");
  remoteAdbAddress?.addEventListener("input", () => {
    state.remoteAdbInput = remoteAdbAddress.value;
    syncRemoteSelectionFromInput();
    updateAndroidControls();
  });
  remoteAdbAddress?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void toggleRemoteAdb();
    }
  });

  document.querySelector("#adb-toggle")?.addEventListener("click", () => {
    void toggleRemoteAdb();
  });

  document.querySelector("#refresh-adb")?.addEventListener("click", () => {
    void refreshAdbState();
  });

  document.querySelector("#refresh-scrcpy-devices")?.addEventListener("click", () => {
    void refreshAdbState();
  });

  const scrcpyBitRate = document.querySelector<HTMLInputElement>("#scrcpy-bit-rate");
  scrcpyBitRate?.addEventListener("input", () => {
    if (scrcpyParametersLocked()) {
      scrcpyBitRate.value = selectedScrcpyOptions().video_bit_rate;
      return;
    }
    state.scrcpyOptions.video_bit_rate = scrcpyBitRate.value;
    saveSettings();
  });
  scrcpyBitRate?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void toggleScrcpy();
    }
  });

  document.querySelector("#scrcpy-toggle")?.addEventListener("click", () => {
    void toggleScrcpy();
  });

  document.querySelector("#adb-shell-open")?.addEventListener("click", () => {
    void toggleAdbShell();
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
  const session = activeTerminalSession();
  terminalContextMenu = {
    left: clamp(clientX, terminalMenuMargin, window.innerWidth - menuSize.width - terminalMenuMargin),
    top: clamp(clientY, terminalMenuMargin, window.innerHeight - menuSize.height - terminalMenuMargin),
    canCopy: session.terminal.hasSelection(),
    canPaste: canPasteToTerminal(session),
  };
  renderApp();
  focusActiveTerminal();
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
    const selection = activeTerminal().getSelection();
    closeTerminalContextMenu();
    renderApp();
    if (selection.length > 0) {
      void navigator.clipboard.writeText(selection);
    }
    focusActiveTerminal();
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
  activeTerminal().clear();
  focusActiveTerminal();
}

async function pasteFromClipboard(): Promise<void> {
  const session = activeTerminalSession();
  if (!canPasteToTerminal(session)) {
    return;
  }

  try {
    const text = await navigator.clipboard.readText();
    if (text.length > 0) {
      queueTerminalText(session, normalizePastedText(text));
    }
  } catch (error) {
    session.terminal.writeln(`\x1b[31m读取剪贴板失败: ${toMessage(error)}\x1b[0m`);
  } finally {
    session.terminal.focus();
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

function renderPicker(id: PickerId, label: string, disabled: boolean): string {
  return `
    <div class="picker-anchor">
      <button class="picker-button" data-picker-id="${id}" type="button" title="${escapeAttribute(label)}" aria-haspopup="listbox" aria-expanded="${
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
    .map((option) => {
      const title = pickerOptionTitle(option);
      return `<button type="button" class="picker-option${
          isPickerOptionActive(option) ? " active" : ""
        }" data-picker-value="${escapeAttribute(option.value)}" title="${escapeAttribute(title)}" role="option" aria-selected="${
          isPickerOptionActive(option) ? "true" : "false"
        }">
          ${option.status ? `<span class="picker-status-dot ${adbStatusTone(option.status)}"></span>` : ""}
          <span class="picker-option-label">${escapeHtml(option.label)}</span>
          ${option.detail ? `<span class="picker-option-detail">${escapeHtml(option.detail)}</span>` : ""}
        </button>`;
    })
    .join("");
}

function pickerOptionTitle(option: PickerOption): string {
  return option.detail ? `${option.label} · ${option.detail}` : option.label;
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
  } else if (id === "dataBits") {
    if (serialSettingsLocked()) {
      closePicker();
      renderApp();
      return;
    }
    state.config.data_bits = Number(value);
  } else if (id === "parity") {
    if (serialSettingsLocked()) {
      closePicker();
      renderApp();
      return;
    }
    state.config.parity = value as Parity;
  } else if (id === "stopBits") {
    if (serialSettingsLocked()) {
      closePicker();
      renderApp();
      return;
    }
    state.config.stop_bits = Number(value);
  } else if (id === "font") {
    state.fontFamily = value;
    state.availableFonts = mergeFonts([value, ...state.availableFonts]);
    applyTerminalOptions();
  } else if (id === "remoteAdb") {
    state.selectedRemoteAdb = value;
    state.remoteAdbInput = value;
  } else if (id === "adbDevice") {
    state.selectedAdbDevice = value;
  } else if (id === "scrcpyCodec") {
    if (scrcpyParametersLocked()) {
      closePicker();
      renderApp();
      return;
    }
    state.scrcpyOptions.video_codec = value as ScrcpyVideoCodec;
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
  if (id === "dataBits") {
    return String(state.config.data_bits);
  }
  if (id === "parity") {
    return parityText(state.config.parity);
  }
  if (id === "stopBits") {
    return String(state.config.stop_bits);
  }
  if (id === "remoteAdb") {
    return remoteAdbPickerLabel();
  }
  if (id === "adbDevice") {
    return adbDevicePickerLabel();
  }
  if (id === "scrcpyCodec") {
    return selectedScrcpyOptions().video_codec;
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

  if (id === "dataBits") {
    return [5, 6, 7, 8].map((value) => ({
      label: String(value),
      value: String(value),
    }));
  }

  if (id === "parity") {
    return [
      { label: "无", value: "none" },
      { label: "偶", value: "even" },
      { label: "奇", value: "odd" },
    ];
  }

  if (id === "stopBits") {
    return [1, 2].map((value) => ({
      label: String(value),
      value: String(value),
    }));
  }

  if (id === "remoteAdb") {
    return state.remoteAdbHistory.map((address) => {
      const status = remoteAdbStatus(address);
      return {
        label: address,
        value: address,
        status,
        detail: adbStateText(status),
      };
    });
  }

  if (id === "adbDevice") {
    return state.adbDevices.map((device) => ({
      label: device.id,
      value: device.id,
      status: device.state,
      detail: adbDeviceDetail(device),
    }));
  }

  if (id === "scrcpyCodec") {
    return ["h265", "h264", "av1"].map((codec) => ({
      label: codec,
      value: codec,
    }));
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
  if (state.activePicker === "dataBits") {
    return Number(option.value) === state.config.data_bits;
  }
  if (state.activePicker === "parity") {
    return option.value === state.config.parity;
  }
  if (state.activePicker === "stopBits") {
    return Number(option.value) === state.config.stop_bits;
  }
  if (state.activePicker === "remoteAdb") {
    return option.value === state.selectedRemoteAdb;
  }
  if (state.activePicker === "adbDevice") {
    return option.value === state.selectedAdbDevice;
  }
  if (state.activePicker === "scrcpyCodec") {
    return option.value === selectedScrcpyOptions().video_codec;
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
  const width = Math.min(rect.width, window.innerWidth - margin * 2);
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

function applyTerminalOptions(): void {
  for (const session of terminalSessions.values()) {
    session.terminal.options.fontFamily = terminalFontFamily();
    session.terminal.options.fontSize = state.fontSize;
    session.terminal.options.lineHeight = state.lineSpacing;
  }
  queueFit();
  focusActiveTerminal();
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

async function refreshAdbState(shouldRender = true): Promise<void> {
  if (state.adbBusy) {
    return;
  }

  try {
    const androidState = await invoke<AndroidStatePayload>("list_adb_state");
    applyAndroidState(androidState);
    state.androidError = "";
  } catch (error) {
    state.androidError = toMessage(error);
    state.adbDevices = [];
    applyScrcpyDevices([]);
  }

  if (shouldRender && !isTextInputActive()) {
    renderApp();
  } else {
    updateAndroidControls();
  }
}

async function refreshScrcpyState(shouldRender = false): Promise<void> {
  if (state.scrcpyBusy) {
    return;
  }

  const selectedDevice = state.selectedAdbDevice;
  const selectedWasRunning = isScrcpyRunning(selectedDevice);

  try {
    const scrcpyDevices = await invoke<string[]>("list_scrcpy_devices");
    const changed = applyScrcpyDevices(scrcpyDevices);
    if (changed && selectedDevice && selectedWasRunning && !isScrcpyRunning(selectedDevice)) {
      state.androidMessage = `scrcpy 已关闭: ${selectedDevice}`;
    }

    if ((shouldRender || changed) && !isTextInputActive()) {
      renderApp();
    } else {
      updateAndroidControls();
    }
  } catch (error) {
    state.androidError = toMessage(error);
    if (shouldRender && !isTextInputActive()) {
      renderApp();
    } else {
      updateAndroidControls();
    }
  }
}

function applyAndroidState(androidState: AndroidStatePayload): void {
  state.adbDevices = androidState.devices;
  applyScrcpyDevices(androidState.scrcpy_devices);

  const selectedDeviceExists = state.adbDevices.some(
    (device) => device.id === state.selectedAdbDevice,
  );
  if (!selectedDeviceExists) {
    const firstOnlineDevice = state.adbDevices.find((device) => device.state === "device");
    state.selectedAdbDevice = firstOnlineDevice?.id ?? state.adbDevices[0]?.id ?? "";
  }

  if (!state.selectedRemoteAdb && state.remoteAdbHistory.length > 0) {
    state.selectedRemoteAdb = state.remoteAdbHistory[0];
    state.remoteAdbInput = state.selectedRemoteAdb;
  }

  saveSettings();
}

function applyScrcpyDevices(deviceIds: string[]): boolean {
  const previous = state.scrcpyDevices.join("\0");
  state.scrcpyDevices = [...deviceIds].sort();
  cleanupScrcpySessionOptions();
  return previous !== state.scrcpyDevices.join("\0");
}

async function toggleRemoteAdb(): Promise<void> {
  const address = currentRemoteAdbAddress();
  if (!address) {
    state.androidError = "请输入远程 ADB 地址";
    renderApp();
    return;
  }

  const connected = remoteAdbStatus(address) === "device";
  state.adbBusy = true;
  state.androidError = "";
  state.androidMessage = "";
  renderApp();

  try {
    const result = connected
      ? await invoke<AdbCommandResult>("adb_disconnect", { address })
      : await invoke<AdbCommandResult>("adb_connect", { address });

    addRemoteAdbHistory(result.address);
    state.selectedRemoteAdb = result.address;
    state.remoteAdbInput = result.address;
    state.androidMessage =
      result.message || `${connected ? "已断开" : "已连接"} ${result.address}`;
  } catch (error) {
    state.androidError = toMessage(error);
  } finally {
    state.adbBusy = false;
  }

  await refreshAdbState(false);
  renderApp();
}

async function toggleScrcpy(): Promise<void> {
  const deviceId = state.selectedAdbDevice;
  if (!deviceId) {
    state.androidError = "请选择一个 ADB 设备";
    renderApp();
    return;
  }

  if (!canToggleScrcpy()) {
    state.androidError = "当前 ADB 设备不可用";
    renderApp();
    return;
  }

  const running = isScrcpyRunning(deviceId);
  state.scrcpyBusy = true;
  state.androidError = "";
  state.androidMessage = "";
  renderApp();

  try {
    if (running) {
      await invoke<void>("stop_scrcpy", { deviceId });
      delete state.scrcpySessionOptions[deviceId];
      state.androidMessage = `已关闭 scrcpy: ${deviceId}`;
    } else {
      const options = copyScrcpyOptions(state.scrcpyOptions);
      await invoke<void>("start_scrcpy", {
        deviceId,
        options,
      });
      state.scrcpySessionOptions[deviceId] = options;
      state.androidMessage = `已打开 scrcpy: ${deviceId}`;
    }
  } catch (error) {
    state.androidError = toMessage(error);
  } finally {
    state.scrcpyBusy = false;
  }

  await refreshAdbState(false);
  renderApp();
}

async function toggleAdbShell(): Promise<void> {
  const deviceId = state.selectedAdbDevice;
  if (deviceId && isAdbShellRunning(deviceId)) {
    await closeAdbShellTab(deviceId);
    return;
  }

  await openAdbShell();
}

async function openAdbShell(): Promise<void> {
  const deviceId = state.selectedAdbDevice;
  if (!deviceId) {
    state.androidError = "请选择一个 ADB 设备";
    renderApp();
    return;
  }

  if (!canOpenAdbShell()) {
    state.androidError = "当前 ADB 设备不可用";
    renderApp();
    return;
  }

  state.adbShellBusy = true;
  state.androidError = "";
  state.androidMessage = "";
  closingAdbShellDevices.delete(deviceId);
  const session = ensureAdbShellSession(deviceId, true, false);
  session.terminal.clear();
  renderApp();

  try {
    const result = await invoke<AdbShellStartPayload>("start_adb_shell", { deviceId });
    const activeShell = ensureAdbShellSession(result.device_id, true, true, result.shell_id);
    activeShell.terminal.writeln(`\x1b[32mADB Shell 已打开: ${result.device_id}\x1b[0m`);
    state.androidMessage = `已打开 ADB Shell: ${result.device_id}`;
  } catch (error) {
    state.androidError = toMessage(error);
    removeAdbShellSession(deviceId);
  } finally {
    state.adbShellBusy = false;
  }

  renderApp();
}

async function closeAdbShellTab(deviceId: string): Promise<void> {
  const running = isAdbShellRunning(deviceId);
  closingAdbShellDevices.add(deviceId);
  removeAdbShellSession(deviceId);
  renderApp();

  if (!running) {
    closingAdbShellDevices.delete(deviceId);
    return;
  }

  try {
    await invoke<void>("stop_adb_shell", { deviceId });
  } catch (error) {
    state.androidError = toMessage(error);
    renderApp();
  }
}

function removeAdbShellSession(deviceId: string): void {
  const id = adbShellTerminalId(deviceId);
  const session = terminalSessions.get(id);
  if (session) {
    session.inputDisposable.dispose();
    session.terminal.dispose();
    terminalSessions.delete(id);
  }

  state.adbShellDevices = state.adbShellDevices.filter((entry) => entry !== deviceId);
  if (state.activeTerminalId === id) {
    state.activeTerminalId = serialTerminalId;
  }
}

function handleAdbShellExit(deviceId: string, shellId: number, message: string): void {
  closingAdbShellDevices.delete(deviceId);
  const session = terminalSessions.get(adbShellTerminalId(deviceId));
  if (session?.shellId !== undefined && session.shellId !== shellId) {
    return;
  }

  state.adbShellDevices = state.adbShellDevices.filter((entry) => entry !== deviceId);
  if (session) {
    session.closed = true;
    session.shellId = undefined;
    session.title = adbShellTitle(deviceId, true);
    session.terminal.writeln(`\r\n\x1b[90m${message}\x1b[0m`);
  }

  renderApp();
}

function queueAdbShellOutput(
  deviceId: string,
  shellId: number,
  data: string,
  byteCount: number,
): void {
  if (closingAdbShellDevices.has(deviceId)) {
    return;
  }

  const existed = terminalSessions.has(adbShellTerminalId(deviceId));
  const existingSession = terminalSessions.get(adbShellTerminalId(deviceId));
  if (existingSession?.shellId !== undefined && existingSession.shellId !== shellId) {
    return;
  }

  const session = ensureAdbShellSession(deviceId, false, true, shellId);
  if (!existed) {
    renderApp();
  }
  queueTerminalOutput(session, data, byteCount);
}

function queueAdbShellText(deviceId: string, text: string): void {
  if (!isAdbShellRunning(deviceId) || text.length === 0) {
    return;
  }

  void invoke<void>("write_adb_shell", { deviceId, text }).catch((error) => {
    const message = toMessage(error);
    const session = terminalSessions.get(adbShellTerminalId(deviceId));
    if (session) {
      session.terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
      session.closed = true;
      session.title = adbShellTitle(deviceId, true);
    }
    state.adbShellDevices = state.adbShellDevices.filter((entry) => entry !== deviceId);
    state.androidError = message;
    renderApp();
  });
}

function addRemoteAdbHistory(address: string): void {
  const normalized = normalizeRemoteAdbAddress(address);
  if (!normalized) {
    return;
  }

  state.remoteAdbHistory = [
    normalized,
    ...state.remoteAdbHistory.filter((entry) => entry !== normalized),
  ];
  saveSettings();
}

function syncRemoteSelectionFromInput(): void {
  const normalized = normalizeRemoteAdbAddress(state.remoteAdbInput);
  state.selectedRemoteAdb = state.remoteAdbHistory.includes(normalized) ? normalized : "";
}

function updateAndroidControls(): void {
  const remoteAddress = currentRemoteAdbAddress();
  const remoteStatus = remoteAdbStatus(remoteAddress);
  const parametersLocked = scrcpyParametersLocked();
  const scrcpyOptions = selectedScrcpyOptions();
  updatePickerButtonState(
    "remoteAdb",
    pickerLabel("remoteAdb"),
    state.adbBusy || state.remoteAdbHistory.length === 0,
  );
  updatePickerButtonState(
    "adbDevice",
    pickerLabel("adbDevice"),
    state.adbBusy || state.adbDevices.length === 0,
  );
  updatePickerButtonState("scrcpyCodec", pickerLabel("scrcpyCodec"), parametersLocked);

  const adbToggle = document.querySelector<HTMLButtonElement>("#adb-toggle");
  if (adbToggle) {
    adbToggle.disabled = state.adbBusy || !remoteAddress;
    adbToggle.textContent = remoteAdbButtonText();
    adbToggle.classList.toggle("danger-button", remoteStatus === "device");
  }

  const refreshAdb = document.querySelector<HTMLButtonElement>("#refresh-adb");
  if (refreshAdb) {
    refreshAdb.disabled = state.adbBusy;
  }

  const remoteStatusDot = document.querySelector("#remote-adb-status-dot");
  if (remoteStatusDot) {
    remoteStatusDot.className = `small-dot ${adbStatusTone(remoteStatus)}`;
  }
  updateTextWithTitle("#remote-adb-status-text", remoteAdbDetailText(remoteAddress));

  const refreshScrcpyDevices =
    document.querySelector<HTMLButtonElement>("#refresh-scrcpy-devices");
  if (refreshScrcpyDevices) {
    refreshScrcpyDevices.disabled = state.adbBusy || state.scrcpyBusy;
  }

  const scrcpyBitRate = document.querySelector<HTMLInputElement>("#scrcpy-bit-rate");
  if (scrcpyBitRate) {
    scrcpyBitRate.disabled = parametersLocked;
    if (parametersLocked || document.activeElement !== scrcpyBitRate) {
      scrcpyBitRate.value = scrcpyOptions.video_bit_rate;
    }
  }

  const scrcpyToggle = document.querySelector<HTMLButtonElement>("#scrcpy-toggle");
  if (scrcpyToggle) {
    const running = isScrcpyRunning(state.selectedAdbDevice);
    scrcpyToggle.disabled = state.scrcpyBusy || !canToggleScrcpy();
    scrcpyToggle.textContent = scrcpyButtonText();
    scrcpyToggle.classList.toggle("connected", running);
  }

  const adbShellOpen = document.querySelector<HTMLButtonElement>("#adb-shell-open");
  if (adbShellOpen) {
    const running = isAdbShellRunning(state.selectedAdbDevice);
    adbShellOpen.disabled = state.adbShellBusy || !canOpenAdbShell();
    adbShellOpen.textContent = adbShellButtonText();
    adbShellOpen.classList.toggle("danger-button", running);
  }

  const selectedDeviceStatus = adbDeviceState(state.selectedAdbDevice);
  const deviceStatusDot = document.querySelector("#adb-device-status-dot");
  if (deviceStatusDot) {
    deviceStatusDot.className = `small-dot ${adbStatusTone(selectedDeviceStatus)}`;
  }
  updateTextWithTitle("#adb-device-status-text", scrcpyDetailText());
}

function updatePickerButtonState(id: PickerId, label: string, disabled: boolean): void {
  const button = document.querySelector<HTMLButtonElement>(`[data-picker-id="${id}"]`);
  if (!button) {
    return;
  }

  button.disabled = disabled;
  button.title = label;
  const labelElement = button.querySelector("span:first-child");
  if (labelElement) {
    labelElement.textContent = label;
  }
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

  pendingSerialText += text;
  queueSerialWritePump();
}

function queueSerialWritePump(deferToTimer = false): void {
  if (serialWritePumpQueued) {
    return;
  }

  serialWritePumpQueued = true;
  if (deferToTimer) {
    serialWritePumpTimer = window.setTimeout(flushSerialText, 0);
  } else {
    queueMicrotask(flushSerialText);
  }
}

function flushSerialText(): void {
  serialWritePumpQueued = false;
  serialWritePumpTimer = null;

  if (
    pendingSerialText.length === 0 ||
    state.mode !== "connected" ||
    serialWritesInFlight >= serialWriteMaxInFlight
  ) {
    return;
  }

  let chunksSent = 0;
  while (
    pendingSerialText.length > 0 &&
    chunksSent < serialWriteMaxChunksPerPump &&
    serialWritesInFlight < serialWriteMaxInFlight
  ) {
    const text = pendingSerialText.slice(0, serialWriteChunkSize);
    pendingSerialText = pendingSerialText.slice(text.length);
    serialWritesInFlight += 1;
    void writeSerialChunk(text);
    chunksSent += 1;
  }

  if (pendingSerialText.length > 0 && serialWritesInFlight < serialWriteMaxInFlight) {
    queueSerialWritePump(true);
  }
}

async function writeSerialChunk(text: string): Promise<void> {
  state.txBytes += textEncoder.encode(text).byteLength;
  requestStatsUpdate();

  const start = performance.now();
  try {
    await invoke<void>("write_text", { text });
    const elapsed = performance.now() - start;
    if (elapsed > perfWarnMs) {
      reportPerf(`tx ipc took ${elapsed.toFixed(1)}ms, chars=${text.length}`);
    }
  } catch (error) {
    if (state.mode !== "connected") {
      return;
    }

    state.lastError = toMessage(error);
    state.mode = "error";
    clearPendingSerialText();
    clearPendingTerminalOutput();
    terminal.writeln(`\x1b[31m${state.lastError}\x1b[0m`);
    renderApp();
  } finally {
    serialWritesInFlight = Math.max(0, serialWritesInFlight - 1);
    if (pendingSerialText.length > 0 && state.mode === "connected") {
      queueSerialWritePump();
    }
  }
}

function clearPendingSerialText(): void {
  pendingSerialText = "";
  serialWritePumpQueued = false;
  serialWritesInFlight = 0;
  if (serialWritePumpTimer !== null) {
    window.clearTimeout(serialWritePumpTimer);
    serialWritePumpTimer = null;
  }
}

function clearPendingTerminalOutput(session: TerminalSession = serialSession): void {
  session.pendingOutput = [];
  session.pendingOutputIndex = 0;
  session.pendingOutputBytes = 0;
  session.outputWriting = false;
}

function normalizeTerminalInput(data: string): string {
  return data.replace(/\x1b\[3~/g, "\b").replace(/\x7f/g, "\b");
}

function normalizePastedText(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

function normalizeAdbShellInput(data: string): string {
  return data.replace(/\r/g, "\n");
}

function copyTerminalSelection(targetTerminal: Terminal, clearAfterCopy = false): void {
  const selection = targetTerminal.getSelection();
  if (selection.length > 0) {
    void navigator.clipboard.writeText(selection);
    if (clearAfterCopy) {
      targetTerminal.clearSelection();
    }
  }
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
      activeTerminalSession().fitAddon.fit();
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

function startPerformanceProbe(): void {
  let lastTick = performance.now();
  window.setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 250;
    lastTick = now;

    if (lag > mainThreadLagWarnMs) {
      reportPerf(`main thread stalled ${lag.toFixed(1)}ms`);
    }
  }, 250);
}

function reportPerf(message: string): void {
  const now = performance.now();
  if (now - lastPerfReportAt < 500) {
    return;
  }

  lastPerfReportAt = now;
  console.warn(`[serial-terminal perf] ${message}`);
  void invoke<void>("report_perf", { message }).catch(() => {});
}

function queueSerialOutput(data: string, byteCount: number): void {
  if (data.length === 0 && byteCount === 0) {
    return;
  }

  queueTerminalOutput(serialSession, data, byteCount);
  if (byteCount > 0) {
    state.rxBytes += byteCount;
    requestStatsUpdate();
  }
}

function queueTerminalOutput(session: TerminalSession, data: string, byteCount: number): void {
  if (data.length === 0) {
    return;
  }

  const start = performance.now();
  const bytes = decodeBase64Bytes(data);
  const elapsed = performance.now() - start;
  if (elapsed > perfWarnMs) {
    reportPerf(`rx base64 decode took ${elapsed.toFixed(1)}ms, bytes=${bytes.byteLength}`);
  }
  session.pendingOutput.push(bytes);
  session.pendingOutputBytes += bytes.byteLength;
  drainTerminalOutput(session);

  if (byteCount > 0 && byteCount !== bytes.byteLength) {
    reportPerf(`rx byte count mismatch payload=${bytes.byteLength}, reported=${byteCount}`);
  }
}

function drainTerminalOutput(session: TerminalSession): void {
  if (session.outputWriting || session.pendingOutputBytes === 0) {
    return;
  }

  const bytes = takeTerminalOutputChunk(session);
  session.outputWriting = true;
  const start = performance.now();
  session.terminal.write(bytes, () => {
    session.outputWriting = false;
    const elapsed = performance.now() - start;
    if (elapsed > perfWarnMs) {
      reportPerf(
        `xterm write took ${elapsed.toFixed(1)}ms, bytes=${bytes.byteLength}, queued=${session.pendingOutputBytes}`,
      );
    }

    if (session.pendingOutputBytes > 0) {
      queueMicrotask(() => drainTerminalOutput(session));
    }
  });
}

function takeTerminalOutputChunk(session: TerminalSession): Uint8Array {
  const targetLength = Math.min(session.pendingOutputBytes, terminalOutputChunkBytes);
  if (
    session.pendingOutputIndex === session.pendingOutput.length - 1 &&
    session.pendingOutput[session.pendingOutputIndex].byteLength <= targetLength
  ) {
    const onlyChunk = session.pendingOutput[session.pendingOutputIndex];
    session.pendingOutput = [];
    session.pendingOutputIndex = 0;
    session.pendingOutputBytes = 0;
    return onlyChunk;
  }

  const bytes = new Uint8Array(targetLength);
  let offset = 0;

  while (offset < targetLength && session.pendingOutputIndex < session.pendingOutput.length) {
    const chunk = session.pendingOutput[session.pendingOutputIndex];
    const remaining = targetLength - offset;

    if (chunk.byteLength <= remaining) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
      session.pendingOutputIndex += 1;
      session.pendingOutputBytes -= chunk.byteLength;
      continue;
    }

    bytes.set(chunk.subarray(0, remaining), offset);
    session.pendingOutput[session.pendingOutputIndex] = chunk.subarray(remaining);
    session.pendingOutputBytes -= remaining;
    offset += remaining;
  }

  if (
    session.pendingOutputIndex > 32 &&
    session.pendingOutputIndex * 2 > session.pendingOutput.length
  ) {
    session.pendingOutput = session.pendingOutput.slice(session.pendingOutputIndex);
    session.pendingOutputIndex = 0;
  }

  return bytes;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
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

function updateTextWithTitle(selector: string, text: string): void {
  const element = document.querySelector<HTMLElement>(selector);
  if (element) {
    element.textContent = text;
    element.title = text;
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
  const remoteAdbHistory = normalizeRemoteAdbHistory(value.remoteAdbHistory);
  const selectedRemoteAdb = normalizeRemoteAdbAddress(
    typeof value.selectedRemoteAdb === "string" ? value.selectedRemoteAdb : "",
  );
  const selectedAdbDevice =
    typeof value.selectedAdbDevice === "string" ? value.selectedAdbDevice.trim() : "";
  const scrcpyOptions = value.scrcpyOptions ?? {};

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
    remoteAdbHistory,
    selectedRemoteAdb: remoteAdbHistory.includes(selectedRemoteAdb)
      ? selectedRemoteAdb
      : remoteAdbHistory[0] ?? "",
    selectedAdbDevice,
    scrcpyOptions: {
      video_codec: normalizeScrcpyVideoCodec(scrcpyOptions.video_codec),
      video_bit_rate: normalizeScrcpyBitRate(scrcpyOptions.video_bit_rate),
    },
  };
}

function saveSettings(): void {
  const value: SavedSettings = {
    config: state.config,
    fontFamily: state.fontFamily,
    fontSize: state.fontSize,
    lineSpacing: state.lineSpacing,
    remoteAdbHistory: state.remoteAdbHistory,
    selectedRemoteAdb: state.selectedRemoteAdb,
    selectedAdbDevice: state.selectedAdbDevice,
    scrcpyOptions: state.scrcpyOptions,
  };
  localStorage.setItem(storageKey, JSON.stringify(value));
}

function currentRemoteAdbAddress(): string {
  return normalizeRemoteAdbAddress(state.remoteAdbInput) || state.selectedRemoteAdb;
}

function normalizeRemoteAdbAddress(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withoutScheme = trimmed.replace(/^tcp:\/\//i, "");
  return withoutScheme.includes(":") ? withoutScheme : `${withoutScheme}:5555`;
}

function normalizeRemoteAdbHistory(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const history: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const address = normalizeRemoteAdbAddress(item);
    if (!address || seen.has(address)) {
      continue;
    }

    seen.add(address);
    history.push(address);
  }

  return history;
}

function normalizeScrcpyVideoCodec(value: unknown): ScrcpyVideoCodec {
  return value === "h264" || value === "av1" ? value : "h265";
}

function normalizeScrcpyBitRate(value: unknown): string {
  if (typeof value !== "string") {
    return defaultScrcpyBitRate;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : defaultScrcpyBitRate;
}

function remoteAdbPickerLabel(): string {
  if (!state.selectedRemoteAdb) {
    return "未保存远程设备";
  }

  return `${state.selectedRemoteAdb} · ${adbStateText(remoteAdbStatus(state.selectedRemoteAdb))}`;
}

function adbDevicePickerLabel(): string {
  if (!state.selectedAdbDevice) {
    return "未找到 ADB 设备";
  }

  return `${state.selectedAdbDevice} · ${adbStateText(adbDeviceState(state.selectedAdbDevice))}`;
}

function remoteAdbStatus(address: string): string {
  if (!address) {
    return "disconnected";
  }

  return state.adbDevices.find((device) => device.id === address)?.state ?? "disconnected";
}

function adbDeviceState(deviceId: string): string {
  if (!deviceId) {
    return "disconnected";
  }

  return state.adbDevices.find((device) => device.id === deviceId)?.state ?? "disconnected";
}

function adbDeviceDetail(device: AdbDevice): string {
  const source = device.is_remote ? "远程" : "USB";
  const running = state.scrcpyDevices.includes(device.id) ? " · scrcpy 已开" : "";
  const shell = isAdbShellRunning(device.id) ? " · shell 已开" : "";
  return `${source} · ${adbStateText(device.state)}${running}${shell}`;
}

function adbStateText(value: string): string {
  if (value === "device") {
    return "已连接";
  }
  if (value === "offline") {
    return "离线";
  }
  if (value === "unauthorized") {
    return "未授权";
  }
  if (value === "disconnected") {
    return "未连接";
  }
  return value || "未知";
}

function adbStatusTone(value: string): string {
  if (value === "device") {
    return "connected";
  }
  if (value === "disconnected") {
    return "disconnected";
  }
  return "warning";
}

function remoteAdbButtonText(): string {
  if (state.adbBusy) {
    return "ADB 处理中";
  }

  return remoteAdbStatus(currentRemoteAdbAddress()) === "device" ? "断开 ADB" : "连接 ADB";
}

function remoteAdbDetailText(address: string): string {
  if (!address) {
    return "输入 IP 或选择历史设备";
  }

  return `${address} · ${adbStateText(remoteAdbStatus(address))}`;
}

function isScrcpyRunning(deviceId: string): boolean {
  return !!deviceId && state.scrcpyDevices.includes(deviceId);
}

function isAdbShellRunning(deviceId: string): boolean {
  return !!deviceId && state.adbShellDevices.includes(deviceId);
}

function scrcpyParametersLocked(): boolean {
  return state.scrcpyBusy || isScrcpyRunning(state.selectedAdbDevice);
}

function selectedScrcpyOptions(): ScrcpyOptions {
  if (isScrcpyRunning(state.selectedAdbDevice)) {
    return state.scrcpySessionOptions[state.selectedAdbDevice] ?? state.scrcpyOptions;
  }

  return state.scrcpyOptions;
}

function copyScrcpyOptions(options: ScrcpyOptions): ScrcpyOptions {
  return {
    video_codec: options.video_codec,
    video_bit_rate: options.video_bit_rate,
  };
}

function cleanupScrcpySessionOptions(): void {
  const runningDevices = new Set(state.scrcpyDevices);
  for (const deviceId of Object.keys(state.scrcpySessionOptions)) {
    if (!runningDevices.has(deviceId)) {
      delete state.scrcpySessionOptions[deviceId];
    }
  }
}

function canToggleScrcpy(): boolean {
  if (!state.selectedAdbDevice) {
    return false;
  }

  return isScrcpyRunning(state.selectedAdbDevice) || adbDeviceState(state.selectedAdbDevice) === "device";
}

function canOpenAdbShell(): boolean {
  if (!state.selectedAdbDevice) {
    return false;
  }

  return isAdbShellRunning(state.selectedAdbDevice) || adbDeviceState(state.selectedAdbDevice) === "device";
}

function scrcpyButtonText(): string {
  if (state.scrcpyBusy) {
    return "scrcpy 处理中";
  }

  return isScrcpyRunning(state.selectedAdbDevice) ? "断开 scrcpy" : "打开 scrcpy";
}

function adbShellButtonText(): string {
  if (state.adbShellBusy) {
    return "ADB Shell 处理中";
  }

  if (isAdbShellRunning(state.selectedAdbDevice)) {
    return "关闭 ADB Shell";
  }

  const session = terminalSessions.get(adbShellTerminalId(state.selectedAdbDevice));
  return session?.closed ? "重新打开 ADB Shell" : "打开 ADB Shell";
}

function scrcpyDetailText(): string {
  if (!state.selectedAdbDevice) {
    return "请选择 ADB 设备";
  }

  const deviceState = adbDeviceState(state.selectedAdbDevice);
  const scrcpyState = isScrcpyRunning(state.selectedAdbDevice) ? "scrcpy 已打开" : "scrcpy 未打开";
  return `${adbStateText(deviceState)} · ${scrcpyState}`;
}

function isTextInputActive(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement;
}

function serialSettingsLocked(): boolean {
  return state.mode === "connected" || state.mode === "connecting";
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

function parityText(parity: Parity): string {
  if (parity === "even") {
    return "偶";
  }
  if (parity === "odd") {
    return "奇";
  }
  return "无";
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

  await listen<AdbShellDataPayload>("adb-shell-data", (event) => {
    queueAdbShellOutput(
      event.payload.device_id,
      event.payload.shell_id,
      event.payload.data,
      event.payload.byte_count,
    );
  });

  await listen<AdbShellExitPayload>("adb-shell-exit", (event) => {
    handleAdbShellExit(
      event.payload.device_id,
      event.payload.shell_id,
      event.payload.message,
    );
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
startPerformanceProbe();
renderApp();
void setupBackendListeners();
void refreshFonts();
void refreshPorts();
void refreshAdbState();
window.setInterval(() => {
  void refreshAdbState(false);
}, adbStateRefreshIntervalMs);
window.setInterval(() => {
  void refreshScrcpyState(false);
}, scrcpyStateRefreshIntervalMs);
