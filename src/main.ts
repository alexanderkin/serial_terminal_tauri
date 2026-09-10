import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

interface SelectionPoint {
  row: number;
  col: number;
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
  lines: string[];
  cursorCol: number;
  autoFollow: boolean;
  selectionAnchor: SelectionPoint | null;
  selectionFocus: SelectionPoint | null;
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
  "JetBrainsMonoNerdFontMono-Regular",
  "JetBrains Mono",
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "Microsoft YaHei UI",
  "monospace",
];

const maxTerminalLines = 100000;
const decoder = new TextDecoder("utf-8");
const appRoot = document.querySelector<HTMLDivElement>("#app");

if (!appRoot) {
  throw new Error("Missing #app root");
}

const app: HTMLDivElement = appRoot;

const state: AppState = {
  ports: [],
  config: {
    port_name: "",
    baud_rate: 1500000,
    data_bits: 8,
    parity: "none",
    stop_bits: 1,
  },
  mode: "disconnected",
  rxBytes: 0,
  txBytes: 0,
  lastError: "",
  fontFamily: fontFamilies[0],
  fontSize: 24,
  lineSpacing: 1,
  lines: [""],
  cursorCol: 0,
  autoFollow: true,
  selectionAnchor: null,
  selectionFocus: null,
};

let ansiEscapeState: "none" | "escape" | "sequence" = "none";
let terminalRenderQueued = false;
let pointerSelecting = false;
let cellWidth = 12;

function renderApp(): void {
  const locked = state.mode === "connected" || state.mode === "connecting";

  app.innerHTML = `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-title">Serial Terminal</div>
          <div class="brand-subtitle">EUI-NEO · C++23 · 串口终端</div>
        </div>
        <div class="terminal-hint">聚焦终端直接输入 · Enter=CR · Ctrl+C=中断</div>
        <div class="topbar-actions">
          <span id="rx-stat" class="metric">RX ${formatBytes(state.rxBytes)}</span>
          <span id="tx-stat" class="metric">TX ${formatBytes(state.txBytes)}</span>
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
                <output>${state.fontSize}px</output>
              </div>
            </label>
            <label class="field range-field">
              <span>行距</span>
              <div class="range-row">
                <input id="line-spacing" type="range" min="0.9" max="1.6" step="0.05" value="${state.lineSpacing}" />
                <output>${state.lineSpacing.toFixed(2)}</output>
              </div>
            </label>
          </section>
        </aside>

        <section class="terminal-panel">
          <div id="terminal-screen" class="terminal-screen" tabindex="0" role="textbox" aria-label="串口终端">
            <div id="terminal-lines" class="terminal-lines"></div>
            <textarea id="terminal-input" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
          </div>
        </section>
      </main>
    </div>
  `;

  bindChromeEvents();
  renderTerminal(false);
  updateStats();
}

function bindChromeEvents(): void {
  const portSelect = document.querySelector<HTMLSelectElement>("#port-select");
  portSelect?.addEventListener("change", () => {
    state.config.port_name = portSelect.value;
  });

  const baudSelect = document.querySelector<HTMLSelectElement>("#baud-select");
  baudSelect?.addEventListener("change", () => {
    state.config.baud_rate = Number(baudSelect.value);
  });

  document.querySelector("#refresh-ports")?.addEventListener("click", () => {
    void refreshPorts();
  });

  document.querySelector("#connection-toggle")?.addEventListener("click", () => {
    void toggleConnection();
  });

  document.querySelector("#clear-terminal")?.addEventListener("click", () => {
    clearTerminal();
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
    renderTerminal(false);
  });

  const fontSize = document.querySelector<HTMLInputElement>("#font-size");
  fontSize?.addEventListener("input", () => {
    state.fontSize = Number(fontSize.value);
    renderApp();
  });

  const lineSpacing = document.querySelector<HTMLInputElement>("#line-spacing");
  lineSpacing?.addEventListener("input", () => {
    state.lineSpacing = Number(lineSpacing.value);
    renderApp();
  });

  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  const terminalInput = document.querySelector<HTMLTextAreaElement>("#terminal-input");

  terminalScreen?.addEventListener("pointerdown", handleTerminalPointerDown);
  terminalScreen?.addEventListener("pointermove", handleTerminalPointerMove);
  terminalScreen?.addEventListener("scroll", () => {
    state.autoFollow = isTerminalNearBottom();
    scheduleTerminalRender();
  });
  terminalScreen?.addEventListener("click", () => {
    focusTerminalInput();
  });

  terminalInput?.addEventListener("keydown", handleTerminalKeyDown);
  terminalInput?.addEventListener("input", handleTerminalInput);
  terminalInput?.addEventListener("paste", handleTerminalPaste);

  window.removeEventListener("pointerup", stopPointerSelection);
  window.addEventListener("pointerup", stopPointerSelection);
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

function renderSegment(setting: keyof Pick<SerialConfig, "data_bits" | "parity" | "stop_bits">, options: SegmentOption[]): string {
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

  renderApp();
}

async function refreshPorts(): Promise<void> {
  try {
    const ports = await invoke<string[]>("list_ports");
    state.ports = ports;
    if (!state.config.port_name || !ports.includes(state.config.port_name)) {
      state.config.port_name = ports[0] ?? "";
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
    appendSystemLine(`已连接 ${state.config.port_name} @ ${state.config.baud_rate}`);
  } catch (error) {
    state.mode = "error";
    state.lastError = toMessage(error);
    appendSystemLine(state.lastError);
  }

  renderApp();
  focusTerminalInput();
}

async function disconnectSerial(): Promise<void> {
  try {
    await invoke<void>("disconnect");
  } catch (error) {
    state.lastError = toMessage(error);
  }

  if (state.mode !== "error") {
    appendSystemLine("串口已关闭");
  }

  state.mode = "disconnected";
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
    appendSystemLine(state.lastError);
    renderApp();
  }
}

function handleTerminalInput(event: Event): void {
  const input = event.currentTarget as HTMLTextAreaElement;
  const text = input.value;
  input.value = "";
  void sendText(text);
}

function handleTerminalPaste(event: ClipboardEvent): void {
  const text = event.clipboardData?.getData("text") ?? "";
  if (text.length === 0) {
    return;
  }

  event.preventDefault();
  void sendText(text);
}

function handleTerminalKeyDown(event: KeyboardEvent): void {
  if (event.ctrlKey && event.key.toLowerCase() === "c") {
    event.preventDefault();
    void handleControlC();
    return;
  }

  if (event.ctrlKey && event.key.toLowerCase() === "d") {
    event.preventDefault();
    void sendText("\u0004");
    return;
  }

  if (event.ctrlKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    void sendText("\u001a");
    return;
  }

  const specialKeys = new Map<string, string>([
    ["Enter", "\r"],
    ["Backspace", "\u0008"],
    ["Delete", "\u007f"],
    ["Tab", "\t"],
    ["Escape", "\u001b"],
    ["ArrowUp", "\u001b[A"],
    ["ArrowDown", "\u001b[B"],
    ["ArrowRight", "\u001b[C"],
    ["ArrowLeft", "\u001b[D"],
    ["Home", "\u001b[H"],
    ["End", "\u001b[F"],
    ["PageUp", "\u001b[5~"],
    ["PageDown", "\u001b[6~"],
  ]);
  const sequence = specialKeys.get(event.key);

  if (sequence) {
    event.preventDefault();
    void sendText(sequence);
  }
}

async function handleControlC(): Promise<void> {
  const selectedText = selectedLinesText();
  if (selectedText.length > 0) {
    await navigator.clipboard.writeText(selectedText);
    clearSelection();
    return;
  }

  await sendText("\u0003");
}

function handleTerminalPointerDown(event: PointerEvent): void {
  const point = pointFromPointer(event);
  if (event.button !== 0 || !point) {
    return;
  }

  event.preventDefault();
  pointerSelecting = true;
  state.selectionAnchor = point;
  state.selectionFocus = point;
  renderTerminal();
  focusTerminalInput();
}

function handleTerminalPointerMove(event: PointerEvent): void {
  if (!pointerSelecting) {
    return;
  }

  const point = pointFromPointer(event);
  if (!point) {
    return;
  }

  state.selectionFocus = point;
  renderTerminal();
}

function stopPointerSelection(): void {
  pointerSelecting = false;
}

function pointFromPointer(event: PointerEvent): SelectionPoint | null {
  const target = event.target instanceof Element ? event.target.closest(".terminal-line") : null;
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  const row = Number(target.dataset.lineIndex);
  if (!Number.isFinite(row)) {
    return null;
  }

  const rect = target.getBoundingClientRect();
  const col = Math.max(0, Math.floor((event.clientX - rect.left) / cellWidth));
  return { row, col };
}

function appendSystemLine(message: string): void {
  const prefix = state.lines.length === 1 && state.lines[0] === "" ? "" : "\r\n";
  appendTerminalText(`${prefix}${message}\r\n`);
}

function appendTerminalText(text: string): void {
  for (const char of text) {
    appendTerminalChar(char);
  }

  if (state.lines.length > maxTerminalLines) {
    const extra = state.lines.length - maxTerminalLines;
    state.lines.splice(0, extra);
    shiftSelectionRows(extra);
  }

  scheduleTerminalRender();
}

function appendTerminalChar(char: string): void {
  if (ansiEscapeState === "escape") {
    ansiEscapeState = "[?]();#".includes(char) ? "sequence" : "none";
    return;
  }

  if (ansiEscapeState === "sequence") {
    const code = char.charCodeAt(0);
    if (code >= 0x40 && code <= 0x7e && !"[?];0123456789 ".includes(char)) {
      ansiEscapeState = "none";
    }
    return;
  }

  if (char === "\u001b") {
    ansiEscapeState = "escape";
    return;
  }

  if (char === "\r") {
    state.cursorCol = 0;
    return;
  }

  if (char === "\n") {
    state.lines.push("");
    state.cursorCol = 0;
    return;
  }

  if (char === "\b" || char === "\u007f") {
    backspaceTerminalChar();
    return;
  }

  if (char < " ") {
    return;
  }

  const lineIndex = state.lines.length - 1;
  const cells = Array.from(state.lines[lineIndex] ?? "");
  while (cells.length < state.cursorCol) {
    cells.push(" ");
  }
  cells.splice(state.cursorCol, 1, char);
  state.lines[lineIndex] = cells.join("");
  state.cursorCol += 1;
}

function backspaceTerminalChar(): void {
  const lineIndex = state.lines.length - 1;
  const cells = Array.from(state.lines[lineIndex] ?? "");

  if (state.cursorCol > 0) {
    cells.splice(state.cursorCol - 1, 1);
    state.cursorCol -= 1;
    state.lines[lineIndex] = cells.join("");
  } else if (state.lines.length > 1) {
    const previous = state.lines[state.lines.length - 2] ?? "";
    const current = state.lines.pop() ?? "";
    state.cursorCol = Array.from(previous).length;
    state.lines[state.lines.length - 1] = previous + current;
  }
}

function scheduleTerminalRender(): void {
  if (terminalRenderQueued) {
    return;
  }

  terminalRenderQueued = true;
  requestAnimationFrame(() => {
    terminalRenderQueued = false;
    renderTerminal();
    updateStats();
  });
}

function renderTerminal(keepScroll = true): void {
  const terminalLines = document.querySelector<HTMLDivElement>("#terminal-lines");
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalLines || !terminalScreen) {
    return;
  }

  updateTerminalStyle();
  measureCellWidth();

  const distanceFromBottom =
    terminalScreen.scrollHeight - terminalScreen.scrollTop - terminalScreen.clientHeight;
  const shouldFollow = state.autoFollow || !keepScroll;
  const lineHeight = currentLineHeight();
  const topLine = Math.max(0, Math.floor(terminalScreen.scrollTop / lineHeight));
  const visibleRows = Math.ceil(terminalScreen.clientHeight / lineHeight);
  const overscan = 12;
  const startIndex = Math.max(0, topLine - overscan);
  const endIndex = Math.min(state.lines.length, topLine + visibleRows + overscan);
  const topSpacerHeight = startIndex * lineHeight;
  const bottomSpacerHeight = (state.lines.length - endIndex) * lineHeight;

  terminalLines.innerHTML =
    `<div class="terminal-spacer" style="height: ${topSpacerHeight}px"></div>` +
    state.lines
      .slice(startIndex, endIndex)
      .map((line, offset) => renderTerminalLine(line, startIndex + offset))
      .join("") +
    `<div class="terminal-spacer" style="height: ${bottomSpacerHeight}px"></div>`;

  if (shouldFollow) {
    terminalScreen.scrollTop = terminalScreen.scrollHeight;
  } else {
    terminalScreen.scrollTop = Math.max(
      0,
      terminalScreen.scrollHeight - terminalScreen.clientHeight - distanceFromBottom,
    );
  }
}

function renderTerminalLine(line: string, index: number): string {
  const selection = normalizedSelection();
  const cells = Array.from(line);
  const isSelectedWholeLine =
    selection !== null &&
    selection.start.row !== selection.end.row &&
    index >= selection.start.row &&
    index <= selection.end.row;

  const className = `terminal-line${isSelectedWholeLine ? " whole-selected" : ""}`;
  let content = escapeHtml(line.length === 0 ? " " : line);

  if (selection && selection.start.row === selection.end.row && index === selection.start.row) {
    const startCol = Math.min(selection.start.col, cells.length);
    const endCol = Math.min(Math.max(selection.end.col, startCol + 1), cells.length);
    content =
      escapeHtml(cells.slice(0, startCol).join("")) +
      `<span class="inline-selected">${escapeHtml(cells.slice(startCol, endCol).join(""))}</span>` +
      escapeHtml(cells.slice(endCol).join(""));
  } else if (!selection && index === state.lines.length - 1) {
    const caretCol = Math.min(state.cursorCol, cells.length);
    content =
      escapeHtml(cells.slice(0, caretCol).join("")) +
      `<span class="terminal-caret"></span>` +
      escapeHtml(cells.slice(caretCol).join(""));
  }

  return `<div class="${className}" data-line-index="${index}">${content}</div>`;
}

function normalizedSelection(): { start: SelectionPoint; end: SelectionPoint } | null {
  if (!state.selectionAnchor || !state.selectionFocus) {
    return null;
  }

  const a = state.selectionAnchor;
  const b = state.selectionFocus;
  if (a.row < b.row || (a.row === b.row && a.col <= b.col)) {
    return { start: a, end: b };
  }

  return { start: b, end: a };
}

function selectedLinesText(): string {
  const selection = normalizedSelection();
  if (!selection) {
    return "";
  }

  if (selection.start.row !== selection.end.row) {
    return state.lines.slice(selection.start.row, selection.end.row + 1).join("\n");
  }

  const line = Array.from(state.lines[selection.start.row] ?? "");
  const startCol = Math.min(selection.start.col, line.length);
  const endCol = Math.min(Math.max(selection.end.col, startCol + 1), line.length);
  return line.slice(startCol, endCol).join("");
}

function shiftSelectionRows(count: number): void {
  if (state.selectionAnchor) {
    state.selectionAnchor.row = Math.max(0, state.selectionAnchor.row - count);
  }
  if (state.selectionFocus) {
    state.selectionFocus.row = Math.max(0, state.selectionFocus.row - count);
  }
}

function clearSelection(): void {
  state.selectionAnchor = null;
  state.selectionFocus = null;
  renderTerminal();
}

function clearTerminal(): void {
  state.lines = [""];
  state.cursorCol = 0;
  state.selectionAnchor = null;
  state.selectionFocus = null;
  state.autoFollow = true;
  renderTerminal(false);
}

function updateTerminalStyle(): void {
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalScreen) {
    return;
  }

  terminalScreen.style.fontFamily = `${state.fontFamily}, "Cascadia Mono", Consolas, monospace`;
  terminalScreen.style.fontSize = `${state.fontSize}px`;
  terminalScreen.style.lineHeight = String(state.lineSpacing);
}

function measureCellWidth(): void {
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalScreen) {
    return;
  }

  const style = window.getComputedStyle(terminalScreen);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.font = `${style.fontSize} ${style.fontFamily}`;
  cellWidth = Math.max(4, context.measureText("M").width);
}

function getTopLine(): number {
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalScreen) {
    return 0;
  }

  const lineHeight = currentLineHeight();
  return Math.max(0, Math.floor(terminalScreen.scrollTop / lineHeight));
}

function scrollToLine(line: number): void {
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalScreen) {
    return;
  }

  terminalScreen.scrollTop = line * currentLineHeight();
}

function currentLineHeight(): number {
  const terminalLine = document.querySelector<HTMLElement>(".terminal-line");
  if (terminalLine) {
    return Math.max(1, terminalLine.getBoundingClientRect().height);
  }

  return Math.max(1, state.fontSize * state.lineSpacing);
}

function isTerminalNearBottom(): boolean {
  const terminalScreen = document.querySelector<HTMLDivElement>("#terminal-screen");
  if (!terminalScreen) {
    return true;
  }

  return (
    terminalScreen.scrollHeight - terminalScreen.scrollTop - terminalScreen.clientHeight < 4
  );
}

function focusTerminalInput(): void {
  document.querySelector<HTMLTextAreaElement>("#terminal-input")?.focus();
}

function updateStats(): void {
  const rx = document.querySelector("#rx-stat");
  const tx = document.querySelector("#tx-stat");
  if (rx) {
    rx.textContent = `RX ${formatBytes(state.rxBytes)}`;
  }
  if (tx) {
    tx.textContent = `TX ${formatBytes(state.txBytes)}`;
  }
}

function updateScale(): void {
  const scale = Math.min(1.18, Math.max(0.55, Math.min(window.innerWidth / 1440, window.innerHeight / 850)));
  document.documentElement.style.setProperty("--ui-scale", scale.toFixed(3));
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
    const text = decoder.decode(new Uint8Array(event.payload.data), { stream: true });
    appendTerminalText(text);
  });

  await listen<SerialErrorPayload>("serial-error", (event) => {
    state.mode = "error";
    state.lastError = event.payload.message;
    appendSystemLine(event.payload.message);
    void invoke<void>("disconnect");
    renderApp();
  });
}

window.addEventListener("resize", () => {
  const topLine = getTopLine();
  updateScale();
  requestAnimationFrame(() => {
    scrollToLine(topLine);
  });
});

updateScale();
renderApp();
void setupBackendListeners();
void refreshPorts();
