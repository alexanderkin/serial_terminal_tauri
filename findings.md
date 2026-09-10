# 发现与决策

## 需求
- 用户明确反馈上一版 Tauri 迁移“功能不全，全是 bug”。
- 需要迁移到 Rust + Tauri，但 UI 设计与功能应与现有版本一致。
- 不能使用外层 eui-neo 仓库提交，`serial_terminal` 目录有自己的 git 仓库。
- 字体搜索需要覆盖更多系统字体；字体下拉滚动条颜色需要匹配主题。
- 所有应用内下拉框都需要统一成自绘版本；下拉框超出窗口时允许向上展开，并完整显示在窗口内。
- 终端打字输入和删除卡顿，需要优化跨进程发送路径。
- 用户进一步确认自绘下拉不需要搜索；连续删除仍比较卡，需要继续优化同步写入路径。

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

## 资源
- 本地 `serial_terminal` Tauri 项目。

## 视觉/浏览器发现
- Tauri dev 已启动到真实 exe 运行态，无立即崩溃输出；未进行人工视觉截图验收。
- 字体下拉已改为自绘组件；滚动条 thumb 使用 `--accent`，hover 使用 `--accent-strong`，track 使用近黑色。
- 本轮未截图，但 `npm run tauri dev` 已进入 exe 运行态且无初始化错误输出。
- 最新一轮已移除自绘下拉搜索框；列表仍使用主题滚动条和 fixed 浮层定位。

---
*每执行2次查看/浏览器或搜索操作后更新此文件*
