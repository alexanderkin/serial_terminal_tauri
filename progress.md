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

### 阶段 9：本地输入预览与删除手感
- **状态：** complete
- 执行的操作：
  - 将终端输入入口改为 `handleTerminalInput`，发送串口前先按设置执行本地输入预览。
  - 新增“输入预览”开关，默认开启并保存到 localStorage。
  - 本地预览对普通输入立即写入 xterm，对 Backspace 立即擦除屏幕。
  - 对中文/宽字符删除按 2 个终端单元格擦除，降低光标覆盖文字和残影概率。
  - 为本地预览维护短时回显吞吐队列，串口返回相同输入/退格/换行时不重复显示。
  - Backspace/Delete 发送改为立即 flush，普通输入批量延迟从 6ms 降到 3ms。
  - 运行构建、后端检查、Tauri info 和 dev 启动验证。
- 创建/修改的文件：
  - `src/main.ts`
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
| `npm run build` | 输入预览和回显吞吐后 | TypeScript/Vite 构建通过 | 构建通过 | 通过 |
| `cargo check` | 输入预览后联动检查 | 编译检查通过 | 通过，仅有路径 canonicalize 警告 | 通过 |
| `git diff --check` | 输入预览改动后 | 无空白错误 | 通过，仅有 CRLF 提示 | 通过 |
| `npm run tauri -- info` | 输入预览改动后 | Tauri 环境检测通过 | 通过 | 通过 |
| `npm run tauri dev` | 输入预览改动后 | 启动到 Tauri exe 且无立即崩溃 | 启动成功，手动 Ctrl+C 停止 | 通过 |

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
| 2026-09-10 | 异步写入后删除仍不流畅 | 1 | 改为默认开启本地输入预览，短时吞掉设备回显，并让 Backspace 立即发送 |

## 五问重启检查
| 问题 | 答案 |
|------|------|
| 我在哪里？ | 完成阶段 9：本地输入预览与删除手感 |
| 我要去哪里？ | 等待用户实机验证默认输入预览下的连续删除/中文删除手感 |
| 目标是什么？ | Tauri 版达到可用的串口终端迁移状态 |
| 我学到了什么？ | 见 findings.md |
| 我做了什么？ | 建立子项目规划并确定替换终端核心 |

---
*每个阶段完成后或遇到错误时更新此文件*
