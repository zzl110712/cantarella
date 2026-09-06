<div align="center">

# 🖼️ cantarella

**批量压缩图片的命令行工具**

传入一个文件夹或单张图片，自动压缩覆盖，覆盖前把原图备份到备份目录（默认 `.backup/`，可用 `--backup-dir` 自定义）。

[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-zero--build-3178C6)](https://www.typescriptlang.org/)

</div>

---

## ✨ 特性

- **两种使用方式**：不传参数进入交互问答模式；传参数则为纯 CLI 模式，可写进脚本；`-y` 全默认模式让裸命令也能进脚本
- **安全第一**：覆盖原文件前自动备份（目录名可用 `--backup-dir` 自定义，带撞名防护，绝不共用你已有的文件夹）；重压缩不会变小的文件自动跳过
- **`--dry` 预览**：真实编码计算压缩后大小，但不写任何文件
- **`--report` 报告**：在目标目录生成 markdown 压缩报告
- **格式转换**：jpeg / png / webp / avif / tiff / gif 互转，支持 heic（iPhone 照片）与 svg 输入
- **并发压缩**：基于 libuv 线程池的 4 路并发 + p-limit 控制
- **发布纯 JS**：npm 包只含编译后的 JS，不携带 TS 源码；开发时 Node 原生跑 TS，零构建

## 📦 安装

```bash
npm install -g cantarella
```

或从源码运行：

```bash
git clone https://github.com/zzl110712/cantarella.git
pnpm install
pnpm build        # 编译并压缩 TS 到 dist/（bin 入口指向编译产物）
npm link          # 注册全局命令 cantarella
```

> 要求 Node.js ≥ 22.12.0（npm 包为编译后的纯 JS，无需构建）

## 🚀 用法

```bash
cantarella compress                       # 交互模式：逐项问答
cantarella compress ./photos              # 压缩目录下所有图片（仅当前层）
cantarella compress ./photos -r           # 递归子目录
cantarella compress ./a.jpg -q 60         # 单文件 + 指定质量
cantarella compress ./photos -f webp      # 全部转成 webp
cantarella compress ./photos -w 1920      # 限制最大宽度 1920（只缩小不放大）
cantarella compress ./photos --dry        # 预览：真实计算大小但不写任何文件
cantarella compress ./photos --report     # 生成 markdown 压缩报告
cantarella compress -y                    # 跳过全部问答，全默认直接压当前目录（脚本友好）
cantarella compress ./photos --backup-dir bak   # 备份到自定义目录 bak/ 而不是 .backup/
```

交互模式中直接回车即采用默认值；ESC / Ctrl+C 随时取消。

## ⚙️ 选项

| 选项                     | 说明                                                               | 默认值        |
| ------------------------ | ------------------------------------------------------------------ | ------------- |
| `-q, --quality <number>` | 压缩质量 1-100（png 映射为压缩等级）                               | `80`          |
| `-f, --format <format>`  | 输出格式：`jpeg` `png` `webp` `avif` `tiff` `gif`                  | 保持原格式    |
| `-w, --max-width <px>`   | 等比缩放的最大宽度，只缩小不放大                                   | `0`（不缩放） |
| `-r, --recursive`        | 递归处理子目录                                                     | 关闭          |
| `--dry`                  | 预览模式：真实计算压缩后大小，但不写任何文件                       | 关闭          |
| `--report`               | 在目标目录生成 markdown 压缩报告                                   | 关闭          |
| `-y, --yes`              | 跳过全部问答、直接用默认值开压（裸命令可脚本化）                   | 关闭          |
| `--backup-dir <name>`    | 备份目录名（须为单纯目录名；非空且非本工具创建的目录会被拒绝使用） | `.backup`     |
| `-c, --concurrency <n>`  | 同时处理几张图，1-1024（调大超过 4 时建议同时设 `UV_THREADPOOL_SIZE` 环境变量同值） | `4` |

## 📋 支持格式

| 方向 | 格式                                        | 说明                          |
| ---- | ------------------------------------------- | ----------------------------- |
| 输入 | jpg / jpeg / png / webp / avif / tiff / gif | 与输出相同                    |
| 输入 | heic / heif                                 | iPhone 照片，自动转 jpeg      |
| 输入 | svg                                         | 矢量图，自动转 png            |
| 输出 | jpeg / png / webp / avif / tiff / gif       | heic 预编译版只能解码不能编码 |

## 💡 PNG 压缩提示

PNG 是无损格式，默认 `-q 80` 只做无损重编码——对已经优化过的 PNG 基本压不动（会被自动跳过）。想真正压小 PNG：

```bash
cantarella compress ./images -q 60    # 开启 palette 量化（≤256 色），典型节省 80%+
cantarella compress ./images -f webp  # 照片类收益最大
```

- **截图 / UI 图形**（大面积纯色）：`-q 60` 效果极好
- **照片**存 PNG：palette 容易出色带，建议转 `webp` 或 `avif`

## 🛠️ 技术栈

| 库                                                       | 用途                                     |
| -------------------------------------------------------- | ---------------------------------------- |
| [sharp](https://sharp.pixelplumbing.com/)                | 图片解码 / 缩放 / 重编码（基于 libvips） |
| [p-limit](https://github.com/sindresorhus/p-limit)       | 并发控制（同时处理 4 张）                |
| [commander](https://github.com/tj/commander.js)          | 子命令与选项解析                         |
| [@clack/prompts](https://github.com/bombshell-dev/clack) | 交互问答 + spinner + 结论行输出          |
| [chalk](https://github.com/chalk/chalk)                  | 终端着色                                 |

## 🔧 开发

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc 类型检查
pnpm start          # 直接运行 TS 源码（--conditions=development，无需编译）
pnpm build          # 编译并压缩到 dist/（发布、npm link 前需要）
```

## 📜 版本记录

### 🚀 1.0.2 · 2026-09-06

- ✨ **新增** `-c, --concurrency <n>` 并发选项（教程练习 1）：CLI 与交互问答双通道，有效范围 1-1024（与 libuv 线程池上限对齐），并发数写入压缩报告的参数行
- 💡 调大并发（>4）时建议同时设置环境变量 `UV_THREADPOOL_SIZE` 同值——sharp 的编解码跑在 libuv 线程池（默认 4 线程），只调 `-c` 不调线程池不会更快

### 🚀 1.0.1 · 2026-09-06

- ✨ **新增** `-V, --version`：打印版本号（从包自身的 package.json 动态读取，发版只改一处）
- ✨ **新增** `-y, --yes` 全默认模式：跳过全部问答、直接用默认值开压，`compress -y` 裸命令也能进脚本；与 `-q` 等选项自由组合（CLI 值优先，其余默认）
- ✨ **新增** `--backup-dir <name>` 自定义备份目录：目录结构原样重现，扫描时自动忽略；非法名（含路径分隔符、`..`）在参数层被拒绝
- 🛡️ **新增** 备份目录撞名防护：非空且非 cantarella 创建的自定义目录直接报错拒用（一个文件都不动），杜绝"用户同名文件被误认成已有备份、原图覆盖后最初版丢失"的数据安全问题

### 🎉 1.0.0 · 2026-09-04

首个版本。

- ✨ **新增** `compress` 子命令：批量压缩目录 / 单文件，覆盖前自动备份到 `.backup/`
- ✨ **新增** 交互问答模式（不传目标路径时）与全参数 CLI 模式（可脚本化）
- ✨ **新增** `-q` `-f` `-w` `-r` `--dry` `--report` 全套选项与参数校验
- ✨ **新增** `--dry` 预览与 `--report` markdown 压缩报告
- ✨ **新增** heic / heif / svg 输入支持（自动转 jpeg / png）
- ⚡ **优化** mozjpeg 编码器、4 路并发、临时文件 + rename 原子写入
- 🐛 **修复** 交互问答空输入直接回车无法应用默认值的问题
- 🐛 **修复** 备份文件路径错误

## 📄 License

[ISC](./LICENSE) © LeoZhao
