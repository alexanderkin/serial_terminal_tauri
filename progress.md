# 进度日志

## 会话：2026-09-10

### 阶段 1：复盘问题与确定方向
- **状态：** complete
- 执行的操作：
  - 读取规划技能说明。
  - 确认 `serial_terminal` 子仓库当前无未提交改动。
  - 将缺陷根因归纳为自研简化终端不满足功能一致。
- 创建/修改的文件：
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 2：替换终端核心
- **状态：** complete
- 执行的操作：
  - 安装 `@xterm/xterm` 与 `@xterm/addon-fit`。
  - 删除自研终端渲染、光标、选区、虚拟列表和 ANSI 简化解析。
  - 使用 xterm.js 接收串口输出、处理输入、滚动、选择、IME 和 ANSI。
  - 使用 FitAddon 跟随右侧终端区域尺寸变化。
- 创建/修改的文件：
  - `package.json`
  - `package-lock.json`
  - `src/main.ts`
  - `src/styles.css`
  - `src/vite-env.d.ts`

### 阶段 3：补齐 UI 与交互
- **状态：** complete
- 执行的操作：
  - 保持深色顶部栏、侧栏、状态胶囊、串口设置和终端显示设置。
  - 连接后继续禁用端口、刷新、波特率、数据位、校验位、停止位。
  - 增加复制按钮、右键复制、Ctrl+C 有选区时复制/无选区时发送中断。
  - 串口参数和终端显示设置保存到 localStorage。
  - Rust 后端连接前先关闭旧串口句柄。
- 创建/修改的文件：
  - `src/main.ts`
  - `src/styles.css`
  - `src-tauri/src/lib.rs`

### 阶段 4：验证
- **状态：** complete
- 执行的操作：
  - 运行前端生产构建。
  - 运行 Rust 后端检查。
  - 运行 Tauri 环境检测。
  - 启动 `npm run tauri dev` 到真实 exe 运行态，确认无立即崩溃后停止。
- 创建/修改的文件：
  -

### 阶段 5：提交
- **状态：** complete
- 执行的操作：
  - 暂存全部迁移修复相关文件。
  - 提交到 `serial_terminal` 子仓库。
- 创建/修改的文件：
  - `task_plan.md`
  - `progress.md`

### 阶段 6：字体搜索与下拉滚动条
- **状态：** complete
- 执行的操作：
  - 新增 Rust `list_fonts` 命令，Windows 下从 HKLM/HKCU 字体注册表枚举字体族名。
  - 前端字体选择从原生 `select` 改为自绘 combobox。
  - 字体下拉支持搜索、Enter 选择首项、Esc 收起、点击外部收起。
  - 自绘下拉滚动条改为主题色。
  - 运行构建和 dev 启动验证。
- 创建/修改的文件：
  - `src-tauri/Cargo.toml`
  - `src-tauri/Cargo.lock`
  - `src-tauri/src/lib.rs`
  - `src/main.ts`
  - `src/styles.css`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 7：统一自绘下拉与输入性能
- **状态：** complete
- 执行的操作：
  - 将串口和波特率从原生 `select` 替换为与字体一致的自绘 picker。
  - picker 当时统一支持搜索、Enter 选择首项、Esc 收起、点击外部收起，后续阶段 8 已按用户要求移除搜索。
  - picker 使用 fixed 浮层，并按按钮位置/窗口剩余空间计算向上或向下展开，保证完整显示在窗口内。
  - 默认窗口尺寸改为 1500×960。
  - 终端输入改为短批量发送队列，减少每个按键一次 Tauri invoke。
  - Rust 串口写入去掉每次 `flush`，减少小包阻塞。
  - 运行构建、后端检查、Tauri info 和 dev 启动验证。
- 创建/修改的文件：
  - `src/main.ts`
  - `src/styles.css`
  - `src-tauri/src/lib.rs`
  - `src-tauri/tauri.conf.json`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 8：简化下拉与异步串口写入
- **状态：** complete
- 执行的操作：
  - 移除自绘 picker 的搜索框、查询状态、过滤函数、搜索占位符和搜索 CSS。
  - 保留自绘下拉的主题滚动条、fixed 浮层、向上/向下展开和窗口内夹取定位。
  - Rust 串口后端增加 writer channel 和后台 writer 线程。
  - `write_text` 命令改为只把字节入队并更新 TX 统计，不再直接同步 `write_all`。
  - writer 线程写入失败时继续通过 `serial-error` 通知前端。
  - 运行构建、后端检查、Tauri info 和 dev 启动验证。
- 创建/修改的文件：
  - `src/main.ts`
  - `src/styles.css`
  - `src-tauri/src/lib.rs`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 9：主题右键菜单与真实输入链路优化
- **状态：** complete
- 执行的操作：
  - 读取最新需求，确认不能恢复此前被回滚的本地输入预览方向。
  - 使用 GPT-5.3-Codex-Spark 子 agent 完成第一版代码改动，并由主流程复查修正。
  - 终端右键改为主题自绘菜单，包含复制、粘贴、清空，并按选区/连接状态禁用不可用项。
  - 前端输入队列改为控制键抢占式 flush，普通输入短延迟合并，不做本地回显预览。
  - RX 输出和 RX/TX 统计更新改为 requestAnimationFrame 合并。
  - Rust writer 线程 drain channel 合并小包写入，reader buffer 增大，并移除重新引入的 `flush()`。
  - 运行 cargo fmt、前端构建、后端检查、Tauri info 和 Tauri dev 启动验证。
  - 准备提交到 `serial_terminal` 子仓库。
- 创建/修改的文件：
  - `src/main.ts`
  - `src/styles.css`
  - `src-tauri/src/lib.rs`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 10：终端渲染器性能修复
- **状态：** complete
- 执行的操作：
  - 读取用户反馈，确认连续输入/删除仍卡，本轮重点转向终端渲染器。
  - 使用 GPT-5.3-Codex-Spark 子 agent 调查 xterm renderer、DOM 重挂载和 WebGL 插件现状。
  - 安装 `@xterm/addon-webgl`，将 xterm 渲染后端切换为 WebGL 优先。
  - 增加 WebGL context loss 回退逻辑，避免 WebGL2 不可用时终端不可用。
  - 将 RX 输出从应用层 `TextDecoder` + 字符串拼接改为 `Uint8Array` 合并后直接写入 xterm。
  - 调整终端性能选项：关闭透明、关闭右键选词、启用自定义字形/重叠字形缩放、取消平滑滚动，并将 scrollback 调整为 10000。
  - 给终端区域增加 layout/paint containment，减少终端重绘影响外层 UI。
  - 运行前端构建、Rust 格式化/检查、Tauri info 和 Tauri dev 启动验证。
  - 提交到 `serial_terminal` 子仓库。
- 创建/修改的文件：
  - `package.json`
  - `package-lock.json`
  - `src/main.ts`
  - `src/styles.css`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 11：替换终端库
- **状态：** complete
- 执行的操作：
  - 读取用户反馈，确认 WebGL xterm 方案仍卡，本轮不再继续局部优化 xterm。
  - 选择 `ghostty-web` 作为新的终端核心，使用 Ghostty WASM parser 和 canvas renderer。
  - 安装 `ghostty-web`，卸载 `@xterm/xterm`、`@xterm/addon-fit`、`@xterm/addon-webgl`。
  - 将前端终端导入切换到 `ghostty-web`，增加 `await init()`。
  - 删除旧 WebGL addon 激活、context loss 回退和 xterm 内部 CSS。
  - 改用持久化 `.terminal-surface` 承载 Ghostty canvas/textarea，避免 UI 重渲染时重复 `open()` 或嵌套旧 host。
  - 按 `ghostty-web` 键盘拦截语义修正 Ctrl+C 有选区复制逻辑。
  - 保留行距滑块，使用 Ghostty renderer metrics 兼容实现，避免留下失效控件。
  - 运行前端构建、Rust 格式化/检查、Tauri info 和 Tauri dev 启动验证。
  - 准备提交到 `serial_terminal` 子仓库。
- 创建/修改的文件：
  - `package.json`
  - `package-lock.json`
  - `src/main.ts`
  - `src/styles.css`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 12：证据驱动输入/删除卡顿定位
- **状态：** complete
- 执行的操作：
  - 启动 Tauri dev 并打开 WebView2 远程调试端口，用 CDP/Profiler 分层抓取性能数据。
  - 对 idle、合成终端输出、满 scrollback、真实 Tauri RX 事件、真实 COM5 输入和真实键盘事件分别压测。
  - 确认 Ghostty 渲染在这些测试中没有持续长任务，空闲 5 秒 profile 主要处于 idle。
  - 抓到真实键盘链路中 `write_text` invoke 曾出现 480ms 峰值；旧策略又让 Backspace/Delete 在真实按键间隔下接近一键一 invoke。
  - 移除临时后端 debug command 和前端 debug API。
  - 将普通串口输入合并窗口调为 12ms，Backspace/Delete 调为 40ms，并允许最多 4 个写入 invoke 并发消化积压。
  - 运行前端构建、Rust 格式化/检查、Tauri info，并在 Tauri dev 热重载后的最终代码上确认无新错误。
- 创建/修改的文件：
  - `src/main.ts`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

### 阶段 13：回车连续输出成段刷新定位
- **状态：** complete
- 执行的操作：
  - 读取用户最新反馈，确认现象是按住回车时输出成段刷新，而不是单纯键入/删除延迟。
  - 临时加入前端测量点并通过构建验证，随后因为 WebView2 调试端口返回 502，改用更直接的 COM5 串口读写测试先分离硬件/应用边界。
  - 停掉 Tauri dev 后，用 .NET SerialPort 直接打开 COM5，按 30ms 间隔发送 120 次回车并记录读事件。
  - 直接测试结果：120 次发送对应 120 次读事件，总 3000 字节，每次 25 字节且 1 个换行，平均间隔约 28.4ms。
  - 移除所有临时测量代码，没有保留 debug API。
  - 前端 RX 改为收到 `serial-data` 立即 `terminal.write(new Uint8Array(data))`，只保留统计更新的 rAF 节流。
  - Rust reader 从 32KB/50ms 改为 4KB/5ms，降低短交互输出在串口读取层被聚合的概率。
  - 运行前端构建、Rust 格式化/检查、Tauri info 和 Tauri dev 启动验证。
- 创建/修改的文件：
  - `src/main.ts`
  - `src-tauri/src/lib.rs`
  - `task_plan.md`
  - `findings.md`
  - `progress.md`

## 测试结果
| 测试 | 输入 | 预期结果 | 实际结果 | 状态 |
|------|------|---------|---------|------|
| `npm run build` | xterm 迁移后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | Rust 后端 | 编译检查通过 | 通过 | 通过 |
| `npm run tauri -- info` | npm wrapper | 能识别 cargo/rustc | 通过 | 通过 |
| `npm run tauri dev` | 实际启动 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止 | 通过 |
| `npm run build` | 字体搜索修复后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | `list_fonts` 后端命令 | 编译检查通过 | 通过 | 通过 |
| `npm run tauri -- info` | 字体搜索修复后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 字体搜索修复后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止 | 通过 |
| `npm run build` | 统一自绘下拉和输入优化后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | 去掉写入 flush 后 | 编译检查通过 | 通过 | 通过 |
| `npm run tauri -- info` | 窗口 1500×960 后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 统一 picker 后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止 | 通过 |
| `cargo fmt` | 异步 writer 改动后 | Rust 格式化完成 | 仅有路径 canonicalize 警告 | 通过 |
| `npm run build` | 移除 picker 搜索后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | writer channel 后端 | 编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | writer channel 后端 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 异步写入和无搜索 picker 后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止 | 通过 |
| `cargo fmt` | 主题右键菜单和链路优化后 | Rust 格式化完成 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run build` | 主题右键菜单和链路优化后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | 主题右键菜单和链路优化后 | Rust 后端编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | 主题右键菜单和链路优化后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 主题右键菜单和链路优化后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止；仅有 MSVC linker stdout 警告 | 通过 |
| `npm run build` | WebGL 终端渲染器后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo fmt` | WebGL 终端渲染器后 | Rust 格式化完成 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `cargo check` | WebGL 终端渲染器后 | Rust 后端编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | WebGL 终端渲染器后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | WebGL 终端渲染器后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功并保持运行 10 秒，手动 Ctrl+C 停止；仅有 MSVC linker stdout 警告 | 通过 |
| `npm run build` | Ghostty 终端替换后 | TypeScript/Vite 构建通过 | 构建通过；Vite 提示 chunk 大小超过 500 kB | 通过 |
| `cargo fmt` | Ghostty 终端替换后 | Rust 格式化完成 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `cargo check` | Ghostty 终端替换后 | Rust 后端编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | Ghostty 终端替换后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | Ghostty 终端替换后 | 启动到 Tauri exe 且无立即崩溃 | 两次启动均成功，最后一次保持运行 10 秒后停止；仅有 MSVC linker stdout 警告 | 通过 |
| CDP idle profile | Ghostty 空闲态 5 秒 | 无持续渲染或长任务 | 约 4.86s idle，无持续 render loop | 通过 |
| CDP 合成输出压测 | 1600 行、20000 行、满 scrollback | 渲染不产生长任务 | render 峰值低，未出现长任务 | 通过 |
| CDP Tauri RX 压测 | 大包和 20000 个小包 `serial-data` | Tauri 事件桥不造成长任务 | 未出现长任务 | 通过 |
| CDP 真实 COM5 输入 | 连续 ASCII/中文/删除 | 找到卡顿瓶颈 | 捕获到 `write_text` invoke 480ms 峰值 | 通过 |
| CDP 删除节流复测 | 240 次 Backspace 连续重复 | 降低 invoke 密度和峰值 | flush 次数约从 240 降为 120，max 约 2.1ms，无长任务 | 通过 |
| `npm run build` | 删除节流最终代码 | TypeScript/Vite 构建通过 | 构建通过；Vite 提示 Ghostty chunk 大小超过 500 kB | 通过 |
| `cargo fmt` | 删除节流最终代码 | Rust 格式化完成 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `cargo check` | 删除节流最终代码 | Rust 后端编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | 删除节流最终代码 | Tauri 环境检测通过 | 通过 | 通过 |
| 直接 COM5 读写测试 | 120 次回车，30ms 间隔 | 确认硬件/驱动是否逐行返回 | 120 个读事件，总 3000 字节，每次 25 字节/1 换行，平均间隔约 28.4ms | 通过 |
| `npm run build` | 低延迟 RX 改动后 | TypeScript/Vite 构建通过 | 构建通过；Vite 提示 Ghostty chunk 大小超过 500 kB | 通过 |
| `cargo fmt` | 低延迟 RX 改动后 | Rust 格式化完成 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `cargo check` | 低延迟 RX 改动后 | Rust 后端编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `npm run tauri -- info` | 低延迟 RX 改动后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 低延迟 RX 改动后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止；仅有 MSVC linker stdout 警告 | 通过 |

## 错误日志
| 时间戳 | 错误 | 尝试次数 | 解决方案 |
|--------|------|---------|---------|
| 2026-09-10 | 上一版自研 Tauri 终端功能不全 | 1 | 改用 xterm.js 作为终端核心 |
| 2026-09-10 | xterm CSS side-effect import 缺 Vite 类型声明 | 1 | 新增 `src/vite-env.d.ts` |
| 2026-09-10 | npm install 需要写用户 npm cache，被沙箱拒绝 | 1 | 使用授权后的 `npm install @xterm/xterm @xterm/addon-fit` |
| 2026-09-10 | 字体搜索范围太少且原生下拉滚动条不匹配主题 | 1 | 后端枚举系统字体，前端自绘搜索下拉和主题滚动条 |
| 2026-09-10 | 端口/波特率仍为原生下拉，且下拉可能超窗 | 1 | 统一 fixed 自绘 picker，按视口空间向上/向下定位 |
| 2026-09-10 | 终端输入和删除卡顿 | 1 | 前端批量合并发送，后端去掉每次写入 flush |
| 2026-09-10 | 删除仍比较卡，自绘下拉不需要搜索 | 1 | 移除 picker 搜索路径，后端同步写改为 channel + writer 线程 |
| 2026-09-10 | 终端右键菜单不符合主题，输入仍卡 | 1 | 改为主题自绘菜单，并继续优化真实串口输入/渲染链路 |
| 2026-09-10 | 连续输入/删除仍卡，怀疑终端本身 | 1 | 切换 xterm 官方 WebGL renderer，并将 RX 改为字节流直接写入 xterm |
| 2026-09-10 | WebGL xterm 仍卡，用户要求换终端 | 1 | 替换为 `ghostty-web` 并清理 xterm/WebGL 残留 |
| 2026-09-10 | Ghostty 后连续输入/删除仍有卡死反馈 | 1 | 用 CDP 和真实 COM5 分层定位，确认是 `write_text` invoke 抖动被过密 flush 放大；改为删除键专用合并和有限并发写入 |
| 2026-09-10 | 按住回车时输出成段刷新 | 1 | 直接 COM5 测试证明硬件逐行返回，改为低延迟 reader 和前端即时写终端 |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 完成阶段 13：回车连续输出成段刷新定位 |
| 我要去哪里？ | 提交本轮低延迟 RX 修复，并等待用户实机复测 |
| 目标是什么？ | Tauri 版达到可用的串口终端迁移状态 |
| 我学到了什么？ | 见 findings.md |
| 我做了什么？ | 建立子项目规划并确定替换终端核心 |

---
*每个阶段完成后或遇到错误时更新此文件*
