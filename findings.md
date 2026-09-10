# 发现与决策

## 需求
- 用户明确反馈上一版 Tauri 迁移“功能不全，全是 bug”。
- 需要迁移到 Rust + Tauri，但 UI 设计与功能应与现有版本一致。
- 不能使用外层 eui-neo 仓库提交，`serial_terminal` 目录有自己的 git 仓库。
- 字体搜索需要覆盖更多系统字体；字体下拉滚动条颜色需要匹配主题。

## 研究发现
- 当前 Tauri 版前端终端是自研文本渲染，天然缺少完整 ANSI、IME、宽字符、滚动缓冲、选择和 resize 语义。
- Rust 后端串口桥接已能编译通过，问题主要集中在前端终端核心与交互完整度。
- xterm.js 已成功通过 TypeScript/Vite 构建并进入 Tauri dev 运行态。
- Windows 字体可从 `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts` 的 HKLM/HKCU 注册表项枚举，值名里包含字体族名。
- 原生 HTML `select` 的下拉搜索与滚动条样式无法稳定按主题定制。

## 技术决策
| 决策 | 理由 |
|------|------|
| 换用 xterm.js | 成熟终端组件覆盖终端核心复杂度，减少自研 bug 面 |
| 保留现有深色工具型 UI 外壳 | 用户要求 UI 风格一致，且这部分适合项目内定制 |
| 用 FitAddon 跟随窗口尺寸 | 保持终端行列随容器变化，而不是手写滚动/resize 算法 |
| Backspace/Delete 统一映射为 BS | 延续现有串口 shell 行为，避免简单设备把 Delete 序列回显成普通文本 |
| 字体选择使用自绘搜索下拉 | 支持输入过滤、Enter 选择首项、Esc 关闭，并能统一滚动条主题色 |
| 后端 `list_fonts` 命令返回字体族名 | 前端不依赖写死列表，搜索范围随系统字体变化 |

## 遇到的问题
| 问题 | 解决方案 |
|------|---------|
| 手写终端无法快速达到功能一致 | 使用成熟终端控件替换 |
| xterm 已初始化后 DOM 重建可能重复 open | 检测 `terminal.element`，重建 UI 时将已有 xterm 节点重新挂载 |
| Tauri CLI 找 cargo 的问题仍需兼容 | 继续使用项目内 wrapper 注入 `%USERPROFILE%\.cargo\bin` |
| 字体下拉滚动条颜色不符 | 原生 select 换成自绘列表，使用 CSS scrollbar-color 和 webkit scrollbar 设置主题色 |

## 资源
- 本地 `serial_terminal` Tauri 项目。

## 视觉/浏览器发现
- Tauri dev 已启动到真实 exe 运行态，无立即崩溃输出；未进行人工视觉截图验收。
- 字体下拉已改为自绘组件；滚动条 thumb 使用 `--accent`，hover 使用 `--accent-strong`，track 使用近黑色。

---
*每执行2次查看/浏览器或搜索操作后更新此文件*
