# 发现与决策

## 需求
- 用户明确反馈上一版 Tauri 迁移“功能不全，全是 bug”。
- 需要迁移到 Rust + Tauri，但 UI 设计与功能应与现有版本一致。
- 不能使用外层 eui-neo 仓库提交，`serial_terminal` 目录有自己的 git 仓库。
- 字体搜索需要覆盖更多系统字体；字体下拉滚动条颜色需要匹配主题。
- 所有应用内下拉框都需要统一成自绘版本；下拉框超出窗口时允许向上展开，并完整显示在窗口内。
- 终端打字输入和删除卡顿，需要优化跨进程发送路径。
- 用户进一步确认自绘下拉不需要搜索；连续删除仍比较卡，需要继续优化同步写入路径。
- 终端区域右键菜单需要匹配应用主题色，输入/删除仍需继续优化，但不能使用此前被回滚的本地输入预览方案。
- 连续输入和删除仍卡，用户判断是终端问题；允许在必要时换一种终端。
- WebGL xterm 方案实机仍卡，用户明确要求“换终端”。
- Ghostty 终端替换后仍有卡死/卡顿反馈；用户要求先调试抓证据，再基于证据修改。
- 按住回车时仍能看到输出成段刷新；期望是一行一行连续刷出。
- 回车刷新行已解决，但删除和快速输入仍表现为一块一块更新；期望按键级连续反馈。
- 用户要求利用 git 分支把终端核心切回普通 xterm.js 做验证。
- 用户反馈窗口拉伸时终端区域与窗口边框之间会出现黑色区域，拉伸变大后黑色区域周期性变大/消失。

## 研究发现
- 当前 Tauri 版前端终端是自研文本渲染，天然缺少完整 ANSI、IME、宽字符、滚动缓冲、选择和 resize 语义。
- Rust 后端串口桥接已能编译通过，问题主要集中在前端终端核心与交互完整度。
- xterm.js 已成功通过 TypeScript/Vite 构建并进入 Tauri dev 运行态。
- Windows 字体可从 `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` 的 HKLM/HKCU 注册表项枚举，值名里包含字体族名。
- 原生 HTML `select` 的下拉搜索与滚动条样式无法稳定按主题定制。
- 端口/波特率/字体原先混用了原生 select 与自绘 combobox；统一为 fixed 自绘浮层后可避免侧栏 overflow 裁剪。
- xterm 的 `onData` 会按输入事件频繁触发；如果每次都直接 `invoke("write_text")`，会产生大量 Tauri IPC 调用。短延迟合并发送能降低卡顿。
- Rust 后端原先每次 `write_all` 后都 `flush`，小包输入时可能阻塞 UI 感知链路；串口终端写入系统缓冲即可。
- 即使去掉 `flush`，`write_text` 仍在 Tauri command 内同步执行 `write_all`；当串口驱动或设备侧变慢时，连续 Backspace/Delete 仍会让 IPC 返回变慢。
- 自绘下拉搜索会给每个 picker 增加额外输入框、过滤状态和列表重绘；用户不需要搜索时应删除这条交互路径。
- 终端右键仍沿用浏览器默认菜单/旧的右键复制行为，不匹配应用深色主题，也缺少粘贴与清空的统一入口。
- 当前前端输入队列对 Enter/Ctrl+C 等立即发送，但 Backspace/Delete/ESC 没有抢占已存在的延迟 flush；连续删除时仍可能被 timer 和前一个 invoke 串行放大。
- RX 串口事件如果每包都直接 `terminal.write` 并立即更新统计 DOM，高波特率或终端文字满屏时会增加主线程绘制压力。
- Rust writer 线程虽然已后台化，但每次 `recv` 后仍只写一个 Vec；短小输入包可在 writer 线程内 drain 合并后再 `write_all`，减少系统调用和驱动压力。
- 本地 `@xterm/xterm` 主包默认使用 DOM renderer；源码注释明确 DOM renderer 是可靠 fallback，并不作为高性能路径。
- 本地此前没有 `@xterm/addon-webgl`；xterm README 将 WebGL addon 描述为 GPU 加速 renderer，插件需要单独安装。
- xterm public API 支持 `terminal.write(string | Uint8Array)`，因此串口 RX 不需要先在应用层 `TextDecoder` 成 JS 字符串再写入。
- WebGL renderer 插件有 `onContextLoss` 事件，适合做失败回退，避免 WebGL2 不可用或上下文丢失导致终端不可用。
- `ghostty-web` 提供基于 Ghostty WASM parser 的终端核心和 canvas renderer，并导出接近 xterm 的 `Terminal`、`FitAddon`、`init` API。
- `ghostty-web` 的 `Terminal.open(parent)` 会把传入的父元素保存为 `terminal.element` 并在里面追加 canvas/textarea；应用重渲染时不能把 `terminal.element` 当作子节点再挂进新 host，否则会嵌套旧 host。
- `ghostty-web` 的 `attachCustomKeyEventHandler` 返回值语义是 `true` 表示阻止默认处理；Ctrl+C 有选区时需要返回 `true`，普通输入返回 `false`。
- `ghostty-web` 构建产物会将 WASM 以内联 data URL 形式打进 Vite bundle，本轮不需要额外复制 `.wasm` 静态资源。
- WebView2 CDP idle profile 显示 5 秒内绝大部分时间处于 idle，Ghostty 空闲态没有持续渲染循环。
- 合成终端输出、满 scrollback、真实 Tauri `serial-data` 事件和批量 Backspace 压测均没有产生长任务；终端渲染本身不是本轮卡死根因。
- 真实 COM5 键盘链路中，连续按键触发的 `write_text` invoke 曾出现 480ms 单次抖动；调整并发后仍可出现 240ms 级别峰值，说明 IPC/后端写入返回时间会抖动。
- 旧策略的 2ms 合并窗口加 Backspace/Delete 立即 flush，在真实按键间隔下几乎变成每个删除键一次 `write_text`，会把 IPC 抖动放大成明显卡顿。
- 删除键专用 40ms 合并窗口后，连续 240 次 Backspace 的发送批次数从 240 次下降到约 120 次，串口 flush 总耗时和最大耗时明显下降，且无长任务。
- 直接用 .NET SerialPort 绕过应用打开 COM5，按 30ms 间隔发送 120 次回车时，得到 120 个读事件、总 3000 字节、每次 25 字节且每次 1 个换行；平均读事件间隔约 28.4ms。
- 直接 COM5 测试说明设备/驱动可以逐行返回；应用中“成段刷新”主要来自应用自己的读取和前端输出聚合。
- Rust 当前 reader 使用 32KB buffer 和 50ms timeout；在 Windows serialport 语义下，这会为了吞吐把短交互输出攒到超时或缓冲边界。
- 前端 `queueSerialOutput` 还会把同一动画帧内的多个 `serial-data` 合并成一次 `terminal.write`；这进一步增加“几行一起刷”的视觉感。
- 删除成块的直接原因之一是 `serialDeleteWriteDelayMs = 40`；这个策略虽然降低 invoke 数量，但会把连续 Backspace 合并成 40ms 一批。
- 快速输入成块的另一个来源是 Rust writer 线程在每次 `recv` 后继续 `try_recv` drain channel，直到 64KB 上限再 `write_all`，会把短时间内多个按键合成一次串口写入。
- 后端 `write_text` 命令现在只做 channel 入队和 TX 计数，实际串口写入在后台线程完成；因此前端不再需要用固定 debounce 保护 UI 线程。
- xterm.js v6 与 `@xterm/addon-fit` 可直接编译通过，生产构建 JS 从 Ghostty 分支约 673KB 降到约 368KB。
- xterm.js 的 `attachCustomKeyEventHandler` 返回 `false` 表示阻止 xterm 继续处理事件；这与此前 Ghostty 分支记录的语义相反，因此 Ctrl+C 有选区复制时必须返回 `false`。
- xterm.js 原生支持 `lineHeight` 选项，不需要 Ghostty 分支中直接改 renderer metrics 的兼容逻辑。
- xterm 默认 CSS 中 `.xterm .xterm-viewport` 使用 `background-color: #000`，composition view 和 scrollbar shadow 也有黑色默认值。
- xterm 的 screen/canvas 实际尺寸按字符宽高的整数列/行变化；窗口连续拉伸时，host 尺寸会先变化，而 terminal screen 会在下一次 fit 到新列/行时跳变，因此边缘剩余区域会周期性出现/消失。
- 如果 xterm 内部 viewport/screen/scrollbar track 的背景与外层终端背景不一致，resize 时这些剩余区域会表现为黑色闪动或黑边。

## 技术决策
| 决策 | 理由 |
|------|------|
| 换用 xterm.js | 成熟终端组件覆盖终端核心复杂度，减少自研 bug 面 |
| 保留现有深色工具型 UI 外壳 | 用户要求 UI 风格一致，且这部分适合项目内定制 |
| 用 FitAddon 跟随窗口尺寸 | 保持终端行列随容器变化，而不是手写滚动/resize 算法 |
| Backspace/Delete 统一映射为 BS | 延续现有串口 shell 行为，避免简单设备把 Delete 序列回显成普通文本 |
| 字体选择使用自绘搜索下拉 | 支持输入过滤、Enter 选择首项、Esc 关闭，并能统一滚动条主题色 |
| 后端 `list_fonts` 命令返回字体族名 | 前端不依赖写死列表，搜索范围随系统字体变化 |
| 所有 picker 使用 fixed 浮层和视口夹取定位 | 下方空间不足时向上展开，并保证 left/top/maxHeight 在窗口内 |
| 输入发送使用队列合并 | 保持 Enter/Ctrl+C 等控制输入立即发送，普通输入/删除短批量合并 |
| picker 移除搜索框 | 符合用户最新要求，同时减少 DOM 与事件绑定开销 |
| Rust 后端使用 writer channel | Tauri 命令只入队字节，后台线程负责 `write_all`，降低连续删除/输入对前端交互的阻塞 |
| 终端右键菜单改为自绘主题菜单 | 浏览器默认 context menu 无法匹配主题，且交互项不可控 |
| 控制输入允许抢占延迟 flush | Backspace/Delete/Enter/Ctrl+C/ESC 是交互反馈最敏感路径，应尽快进入真实串口写入队列 |
| RX 输出和统计更新按动画帧合并 | 降低每包事件造成的 `terminal.write` 与 DOM textContent 更新频率 |
| 优先切换 xterm 官方 WebGL renderer | 先替换渲染后端，不立刻换完整终端库，能最大程度保留现有功能和 API |
| RX 输出改为 `Uint8Array` 写入 | 降低 JS 字符串分配/拼接，保留 xterm 的流式 UTF-8 处理 |
| 替换为 `ghostty-web` | 用户反馈 WebGL xterm 仍卡；Ghostty WASM parser + canvas renderer 能替换完整终端核心，同时继续复用当前串口桥接和 UI 外壳 |
| 终端 DOM 改用持久化 surface | Ghostty 将 `open()` 入参作为终端根元素，重渲染 UI 时移动这个 surface 比重新 open 或挂载 `terminal.element` 更安全 |
| 不继续盲目替换终端 | CDP 证据显示 Ghostty 渲染链路稳定，继续换终端不会命中本轮已抓到的卡顿点 |
| 前端串口写入采用有限并发 | 允许最多 4 个 `write_text` invoke 并行消化积压，避免单个慢 invoke 把队列完全堵死 |
| 删除输入使用更长 debounce | Backspace/Delete 连续重复时合并发送，降低 IPC 数量，同时保留真实串口发送而不是本地假预览 |
| 串口 reader 改为低延迟读 | 回车交互输出需要优先保证行级反馈，4KB buffer + 5ms timeout 比 32KB + 50ms 更符合终端手感 |
| RX 到达即写入终端 | 统计 DOM 可以帧级节流，但终端正文不应为省重绘把交互输出攒到下一帧统一写 |
| TX 到达即尝试发送 | 串口写入已后台化，前端输入应优先保证交互连续性，积压只在 invoke 并发耗尽时发生 |
| writer 不再 drain 合并小包 | 快速输入/删除需要按键级到达设备，后台线程不应再把多个按键主动合成一次 `write_all` |
| xterm 分支不引入 WebGL addon | 用户要求普通 xterm.js，本分支只使用 `@xterm/xterm` 和 `@xterm/addon-fit` |
| 覆盖 xterm 内部背景 | resize 时字符网格不能连续填满所有像素，必须让所有可能露出的内部层使用同一终端背景色 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| 手写终端无法快速达到功能一致 | 使用成熟终端控件替换 |
| xterm 已初始化后 DOM 重建可能重复 open | 检测 `terminal.element`，重建 UI 时将已有 xterm 节点重新挂载 |
| Tauri CLI 找 cargo 的问题仍需兼容 | 继续使用项目内 wrapper 注入 `%USERPROFILE%\.cargo\bin` |
| 字体下拉滚动条颜色不符 | 原生 select 换成自绘列表，使用 CSS scrollbar-color 和 webkit scrollbar 设置主题色 |
| 端口和波特率仍是原生下拉 | 改为同一套 picker 渲染和交互 |
| 输入/删除卡顿 | 降低前端 IPC 频率并去掉后端每次写入 flush |
| 删除仍比较卡 | 后端同步 `write_all` 改为后台 writer 线程，前端 invoke 只等待 channel 入队 |
| 右键菜单不符合主题 | 使用固定定位的自绘菜单并按视口夹取位置 |
| 输入仍比较卡且不能恢复本地预览 | 优化真实链路：前端抢占 flush、RX 帧合并、统计节流、后端 writer 合并小包 |
| 连续输入/删除仍卡且怀疑终端本身 | 接入 `@xterm/addon-webgl`，使用 GPU renderer；若不可用自动回退 DOM |
| WebGL xterm 仍卡 | 替换为 `ghostty-web`，清理 xterm/WebGL 依赖和内部 CSS，修正挂载和键盘拦截语义 |
| Ghostty 后仍反馈卡死 | 通过 CDP profile、合成输出、真实 Tauri RX 和真实 COM5 键盘输入分层定位，确认主要瓶颈是 `write_text` 调用密度和 invoke 抖动，而不是终端渲染 |
| 按住回车输出成段刷新 | 直接 COM5 读写测试显示硬件逐行返回；移除前端 RX rAF 合并，并降低 Rust reader timeout/buffer |
| 删除和快速输入仍成块 | 移除前端 Backspace/普通输入 debounce；提高 invoke 并发上限；后端 writer 改为每个入队包单独 `write_all` |
| 切回 xterm.js 需要重新处理键盘语义 | 将 Ctrl+C 选区复制处理改为返回 `false` 阻止 xterm 发送中断 |
| xterm resize 黑边 | 将 root、viewport、screen、scroll area、scrollable element、scrollbar track 统一设为 `--terminal`，并给 screen 设置最小 100% 宽高 |

## 资源
- 本地 `serial_terminal` Tauri 项目。

## 视觉/浏览器发现
- Tauri dev 已启动到真实 exe 运行态，无立即崩溃输出；未进行人工视觉截图验收。
- 字体下拉已改为自绘组件；滚动条 thumb 使用 `--accent`，hover 使用 `--accent-strong`，track 使用近黑色。
- 本轮未截图，但 `npm run tauri dev` 已进入 exe 运行态且无初始化错误输出。
- 最新一轮已移除自绘下拉搜索框；列表仍使用主题滚动条和 fixed 浮层定位。
- 最新问题聚焦终端右键菜单和真实输入链路性能；本轮不采用已被回滚的本地输入预览策略。
- 主题右键菜单和真实链路优化后，`npm run build`、`cargo check`、`npm run tauri -- info` 与 `npm run tauri dev` 均通过；Rust 命令仍会输出已知路径 canonicalize 警告。
- 本轮已安装 `@xterm/addon-webgl`，并通过 `npm run build`、`cargo check`、`npm run tauri -- info`、`npm run tauri dev`；Tauri dev 启动后保持运行 10 秒无初始化崩溃。
- 本轮开始替换为 `ghostty-web`；前端 `npm run build` 已通过，待继续做 Rust/Tauri 启动验证。
- 本轮已完成证据驱动性能定位；所有临时调试命令和前端 debug API 已移除，最终生产改动仅保留串口发送节流策略。
- 本轮直接 COM5 测试结果：120 次回车对应 120 个读事件、每个读事件 25 字节/1 个换行；这证明行级输出在应用外是成立的。
- 本轮发现当前 COM5 被正在运行的 `serial_terminal.exe` 占用，因此没有强行做直接串口删除测试，避免打断用户正在测试的实例。
- 本轮 `codex/xterm-js` 分支 Tauri dev 已启动到 `target\debug\serial_terminal.exe`，无立即崩溃。

---
*每执行2次查看/浏览器或搜索操作后更新此文件*
