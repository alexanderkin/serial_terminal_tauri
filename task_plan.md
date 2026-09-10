# 任务计划：Tauri 串口终端补全与稳定化

## 目标

将 `serial_terminal` 迁移版从模板级实现补齐为可用的 Rust + Tauri 串口终端：UI 风格贴近现有版本，串口功能、终端行为、中文输入、滚动、选区和窗口自适应达到可实测状态。

## 下一步

窗口拉伸时终端边缘黑色闪现问题已修复，等待用户实机复测 resize 视觉效果。

## 当前阶段

完成

## 各阶段

### 阶段 1：复盘问题与确定方向
- [x] 承认上一版自研终端不满足“功能一致”
- [x] 确认 `serial_terminal` 是独立 git 仓库
- [x] 记录新的修复方向
- **状态：** complete

### 阶段 2：替换终端核心
- [x] 引入成熟终端库
- [x] 删除自研终端渲染/选区/光标逻辑
- [x] 接通串口输入输出与终端控件
- **状态：** complete

### 阶段 3：补齐 UI 与交互
- [x] 保持当前深色 Windows Terminal 风格
- [x] 连接后锁定串口参数，断开后恢复
- [x] 窗口缩放时控件自适应且文字保持清晰
- **状态：** complete

### 阶段 4：验证与修复
- [x] `npm run build`
- [x] `cargo check`
- [x] `npm run tauri -- info`
- [x] `npm run tauri dev` 启动检查
- **状态：** complete

### 阶段 5：提交
- [x] 只提交到 `serial_terminal` 子仓库
- [x] 记录提交号
- **状态：** complete

### 阶段 6：字体搜索与下拉滚动条
- [x] 后端枚举 Windows 已安装字体
- [x] 前端字体选择改为自绘可搜索下拉框
- [x] 下拉滚动条颜色改为主题色
- [x] 构建、Rust 检查、Tauri dev 启动验证
- **状态：** complete

### 阶段 7：统一自绘下拉与输入性能
- [x] 串口、波特率、字体统一为自绘下拉
- [x] 下拉浮层超出窗口时自动向上显示，并夹在窗口内
- [x] 默认窗口改为 1500×960
- [x] 终端输入改为前端短批量合并发送，降低 Tauri invoke 频率
- [x] 后端串口写入去掉每次强制 flush，减少输入/删除阻塞
- [x] 构建、Rust 检查、Tauri dev 启动验证
- **状态：** complete

### 阶段 8：简化下拉与异步串口写入
- [x] 移除所有自绘下拉的搜索框、过滤状态和搜索样式
- [x] 下拉仍保持主题滚动条、fixed 浮层和窗口内定位
- [x] Rust 后端串口写入改为 channel 入队 + 后台 writer 线程
- [x] Tauri 命令不再直接阻塞等待串口 `write_all`
- [x] 构建、Rust 检查、Tauri info 和 Tauri dev 启动验证
- **状态：** complete

### 阶段 9：主题右键菜单与真实输入链路优化
- [x] 终端右键菜单改为主题色自绘菜单
- [x] 右键菜单支持复制、粘贴、清空，并按选区/连接状态禁用不可用项
- [x] 前端输入队列支持控制键抢占式 flush，不恢复本地输入预览
- [x] RX 输出和统计更新使用帧级合并，降低高吞吐重绘压力
- [x] Rust writer 线程合并 channel 中的小包写入，reader buffer 适当增大
- [x] 构建、Rust 检查、Tauri dev 启动验证
- [x] 提交到 `serial_terminal` 子仓库
- **状态：** complete

### 阶段 10：终端渲染器性能修复
- [x] 调查 xterm 当前是否使用 DOM renderer，以及本地是否已有 WebGL/canvas 插件
- [x] 安装并接入 `@xterm/addon-webgl`
- [x] WebGL renderer 不可用或 context loss 时回退 DOM renderer
- [x] RX 输出从 JS 字符串解码改为 `Uint8Array` 直接写入 xterm
- [x] 给终端区域增加布局/绘制隔离，降低重绘外溢
- [x] 构建、Rust 检查、Tauri dev 启动验证
- [x] 提交到 `serial_terminal` 子仓库
- **状态：** complete

### 阶段 11：替换终端库
- [x] 调研并选择新的终端实现替代 xterm.js
- [x] 安装并接入 `ghostty-web`
- [x] 删除 xterm/WebGL addon 依赖和残留代码
- [x] 按 Ghostty 的 `open(element)` 语义改为持久化终端 surface 挂载
- [x] 按 Ghostty 的键盘拦截语义修正 Ctrl+C 选区复制
- [x] 保留行距滑块，使用 Ghostty renderer metrics 兼容实现
- [x] Rust/Tauri 验证
- [x] 提交到 `serial_terminal` 子仓库
- **状态：** complete

### 阶段 12：证据驱动输入/删除卡顿定位
- [x] 使用 WebView2 CDP/Profiler 抓取 idle、终端输出、scrollback、RX 事件和真实键盘输入数据
- [x] 证明 Ghostty 渲染在空闲、满屏输出、真实 Tauri RX 和 scrollback 压力下没有长任务
- [x] 证明真实卡顿来自连续按键触发过多 `write_text` IPC，且单次 invoke 曾抖动到 480ms
- [x] 调整前端串口发送策略：普通输入 12ms 合并、删除键 40ms 合并、最多 4 个写入 invoke 并发
- [x] 移除所有临时调试接口，仅保留生产代码
- [x] 构建、Rust 检查、Tauri info 和 Tauri dev 热重载验证
- **状态：** complete

### 阶段 13：回车连续输出成段刷新定位
- [x] 直接绕过应用打开 COM5，按 30ms 间隔发送 120 次回车并记录串口读事件
- [x] 证明设备/串口可按 120 次回车返回 120 个单行读事件，不是硬件端天然成段输出
- [x] 定位应用侧批量感来自 Rust 50ms 大缓冲读取和前端 RX 帧级合并
- [x] 将 Rust 串口读取改为 4KB buffer + 5ms timeout，降低 read 端聚合延迟
- [x] 将前端 RX 输出改为 serial-data 到达即写入终端，统计更新仍保留帧级节流
- [x] 构建、Rust 检查、Tauri info 和 Tauri dev 启动验证
- **状态：** complete

### 阶段 14：删除与快速输入低延迟发送
- [x] 确认回车 RX 刷新已解决，剩余问题集中在 TX 发送侧
- [x] 定位删除成块来自前端 Backspace 40ms debounce 和后端 writer 小包 drain 合并
- [x] 移除前端输入 timer/debounce，`onData` 到达后立即尝试发送
- [x] 写入 invoke 并发上限从 4 提升到 8，降低短时间积压后被切成大块的概率
- [x] 移除 Rust writer 的 `try_recv` 合并逻辑，一个 `write_text` 入队对应一次后台 `write_all`
- [x] 构建、Rust 格式化/检查和 Tauri info 验证
- **状态：** complete

### 阶段 15：分支回切普通 xterm.js
- [x] 从当前稳定 master 新建 `codex/xterm-js` 分支
- [x] 卸载 `ghostty-web`，安装 `@xterm/xterm` 和 `@xterm/addon-fit`
- [x] 前端终端核心切回 xterm.js，保留低延迟 TX/RX 串口链路
- [x] 修正 Ctrl+C 有选区时的 xterm 键盘处理返回语义
- [x] 行距改用 xterm 原生 `lineHeight`
- [x] 样式改回 xterm DOM 结构和 viewport 滚动条
- [x] 构建、Rust 检查、Tauri info 和 Tauri dev 启动验证
- **状态：** complete

### 阶段 16：修复窗口拉伸时终端黑边
- [x] 确认 xterm viewport 默认 CSS 背景为黑色
- [x] 确认 xterm screen/canvas 按字符网格离散变化，窗口连续 resize 时会短暂露出内部背景
- [x] 将 xterm root、viewport、screen、scroll area、scrollable element 背景统一为终端背景色
- [x] 将 xterm screen 最小宽高设为 100%，覆盖字符网格剩余边缘区域
- [x] 将滚动条轨道和 thumb border 改为终端背景色
- [x] 前端构建和 diff 检查验证
- **状态：** complete

## 关键问题

1. 终端核心必须使用成熟库处理 ANSI、IME、宽字符、滚动缓冲和选择，不能继续手写简化版。
2. 串口桥接需要保持原需求：高波特率、连接后锁定设置、RX/TX 统计、Enter=CR。
3. UI 自适应应通过真实 CSS 尺寸/字号计算完成，不能用整体 transform 拉伸。

## 已做决策

| 决策 | 理由 |
|------|------|
| 使用 xterm.js 作为前端终端核心 | 它是成熟 Web 终端实现，内置 ANSI、缓冲、光标、选区、IME 和滚动处理，比自研文本网格更接近 Windows Terminal 行为 |
| Rust 后端继续使用 `serialport` | 已通过 `cargo check`，能覆盖串口枚举、参数配置和后台读写 |
| 只在 `serial_terminal` git 仓库提交 | 用户明确要求不能使用外层 eui-neo 仓库 |
| 使用 localStorage 保存前端串口与显示设置 | Tauri Web 前端可直接持久化用户选择，避免每次启动重新配置 |
| 字体列表由 Rust 后端枚举 Windows 字体注册表 | 前端写死列表无法满足搜索完整度，后端可读取系统已安装字体族名 |
| 字体下拉改为自绘组件 | 原生 select 的搜索能力和滚动条样式不可控，无法匹配主题 |
| 所有下拉统一使用 fixed 自绘浮层 | 可精确控制滚动条、主题和上下展开，避免被侧栏裁剪或超出窗口 |
| 串口输入前端合并小批量发送 | 每个按键一次 Tauri invoke 会造成输入/删除卡顿，短批量合并能降低跨进程调用压力 |
| 自绘下拉不再提供搜索 | 用户明确表示不需要搜索，移除搜索框可减少 DOM 和事件开销 |
| 串口写入改为后台 writer 线程 | Tauri 命令只负责入队，连续删除/输入不再等待同步串口写入 |
| 不恢复本地输入预览 | 用户已经明确要求撤销该方向，后续卡顿优化必须集中在真实串口发送、接收渲染和统计更新链路 |
| 使用 xterm 官方 WebGL renderer | 当前主包默认 DOM renderer 是可靠 fallback，但高频回显和满屏更新性能弱；WebGL renderer 是 xterm 官方性能路径 |
| RX 直接向 xterm 写入 `Uint8Array` | 避免 JS `TextDecoder` 和字符串拼接，把流式 UTF-8 解码交给 xterm 的输入解析器 |
| 换用 `ghostty-web` | 用户实测 WebGL xterm 仍卡，需要替换完整终端核心；`ghostty-web` 提供 Ghostty WASM parser 和 canvas renderer，同时保留接近 xterm 的 API，迁移风险低于重写 |
| 保留 Ghostty，优化串口发送节流 | CDP 证据显示 Ghostty 渲染不是卡顿根因；真实卡顿来自 `write_text` IPC 在连续按键下被放大 |
| Backspace/Delete 不再立即 flush | 连续删除对实时性敏感但不应每个键一次 invoke；40ms 合并可明显降低 IPC 数量 |
| 串口 RX 走低延迟路径 | 直接 COM5 测试证明硬件可一行一行返回，应用不应再用 50ms 大读缓冲和前端 rAF 合并把多行攒成一段 |
| 串口 TX 走低延迟路径 | 删除和快速输入是交互输入，不能再用 40ms debounce 或 writer drain 把按键合并成块 |
| 用分支验证 xterm.js | 主线保留稳定状态，单独在 `codex/xterm-js` 分支 A/B 测试普通 xterm.js |
| xterm 内部背景统一到终端背景 | xterm 的字符网格按离散列/行 resize，连续拉伸时会露出内部层背景；内部层不能保留默认黑色 |

## 遇到的错误

| 错误 | 尝试次数 | 解决方案 |
|------|---------|---------|
| 上一版自研终端功能不全、缺陷多 | 1 | 替换为成熟终端库，不再继续扩大自研简化终端 |
| Tauri dev 需要真实运行验证 | 1 | 已启动到 `target\debug\serial_terminal.exe`，确认无立即崩溃后手动停止 |
| 字体搜索功能不全/滚动条颜色不匹配主题 | 1 | 后端枚举字体 + 前端自绘搜索下拉和主题滚动条 |
| 终端输入和删除卡顿 | 1 | 前端合并发送队列 + 后端写入不再每次 flush |
| 删除仍比较卡、自绘下拉不需要搜索 | 1 | 移除下拉搜索；后端写入改为异步队列和后台 writer 线程 |
| 终端右键菜单不符合主题且输入仍卡 | 1 | 新增主题自绘菜单；继续优化真实串口链路，不使用本地输入预览 |
| 连续输入/删除仍卡，怀疑终端本身 | 1 | 切换 xterm 官方 WebGL renderer，并改为字节流直接写入终端 |
| WebGL xterm 仍卡，用户要求换终端 | 1 | 切换到 `ghostty-web`，删除 xterm/WebGL 依赖，并按新库语义重做终端挂载 |
| Ghostty 后连续输入/删除仍卡 | 1 | 用 CDP 和真实 COM5 输入链路定位到 `write_text` invoke 抖动与过密 flush；改为有限并发和删除键专用合并窗口 |
| 按住回车时输出成段刷新 | 1 | 直接 COM5 测试确认硬件逐行返回；改为低延迟 reader 和前端即时写终端 |
| 删除和快速输入仍成块 | 1 | 移除前端输入 debounce 和后端 writer 小包合并，改为按键级低延迟发送 |
| 需要验证是否可切回普通 xterm.js | 1 | 在 `codex/xterm-js` 分支回切 xterm.js，保留低延迟串口链路用于实机测试 |
| 窗口拉伸时终端边缘出现黑色区域 | 1 | 覆盖 xterm viewport/screen/scrollable 背景和滚动条轨道，使离散网格空隙显示为终端背景色 |

## 提交

- 最新提交见 `git log -1 --oneline`。
