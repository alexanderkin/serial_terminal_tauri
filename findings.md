# 发现与决策

## 需求
- 用户明确反馈上一版 Tauri 迁移“功能不全，全是 bug”。
- 需要迁移到 Rust + Tauri，但 UI 设计与功能应与现有版本一致。
- 不能使用外层 eui-neo 仓库提交，`serial_terminal` 目录有自己的 git 仓库。

## 研究发现
- 当前 Tauri 版前端终端是自研文本渲染，天然缺少完整 ANSI、IME、宽字符、滚动缓冲、选择和 resize 语义。
- Rust 后端串口桥接已能编译通过，问题主要集中在前端终端核心与交互完整度。
- xterm.js 已成功通过 TypeScript/Vite 构建并进入 Tauri dev 运行态。

## 技术决策
| 决策 | 理由 |
|------|------|
| 换用 xterm.js | 成熟终端组件覆盖终端核心复杂度，减少自研 bug 面 |
| 保留现有深色工具型 UI 外壳 | 用户要求 UI 风格一致，且这部分适合项目内定制 |
| 用 FitAddon 跟随窗口尺寸 | 保持终端行列随容器变化，而不是手写滚动/resize 算法 |
| Backspace/Delete 统一映射为 BS | 延续现有串口 shell 行为，避免简单设备把 Delete 序列回显成普通文本 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| 手写终端无法快速达到功能一致 | 使用成熟终端控件替换 |
| xterm 已初始化后 DOM 重建可能重复 open | 检测 `terminal.element`，重建 UI 时将已有 xterm 节点重新挂载 |
| Tauri CLI 找 cargo 的问题仍需兼容 | 继续使用项目内 wrapper 注入 `%USERPROFILE%\.cargo\bin` |

## 资源
- 本地 `serial_terminal` Tauri 项目。

## 视觉/浏览器发现
- Tauri dev 已启动到真实 exe 运行态，无立即崩溃输出；未进行人工视觉截图验收。

---
*每执行2次查看/浏览器或搜索操作后更新此文件*
