<div align="center">

# 🖼️ cantarella

**批量压缩与加水印的命令行工具**

两个子命令：`compress` 压缩（默认覆盖原文件，覆盖前自动备份到 `.backup/`，可用 `--backup-dir` 自定义；或用 `--out` 写进独立目录树，原图一个字节都不动）；`watermark` 批量加水印（图片 logo 或文字，九宫格定位、平铺防盗图、可调倾斜角）。

[![Node.js](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen)](https://nodejs.org/)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-zero--build-3178C6)](https://www.typescriptlang.org/)

</div>

---

## ✨ 特性

- **两种使用方式**：不传参数进入交互问答模式；传参数则为纯 CLI 模式，可写进脚本；`-y` 全默认模式让裸命令也能进脚本
- **`watermark` 批量加水印**：图片 logo（`-m`）或文字（`-t`）二选一；九宫格定位（`-p`）、不透明度（`--opacity`）、大小按主图宽百分比（`-s`）；`--tile` 平铺防盗图，`-a` 斜向平铺；覆盖前同样自动备份，`--dry` 零写入预览；手机竖拍照片自动摆正（EXIF orientation）
- **安全第一**：覆盖原文件前自动备份（目录名可用 `--backup-dir` 自定义，带撞名防护，绝不共用你已有的文件夹）；重压缩不会变小的文件自动跳过
- **`--out` 输出模式**：结果写进独立目录树（镜像源目录结构），不动原图、不写备份；压不动的文件原样拷贝进去，目录树永远完整；同名输出冲突（如 heic→jpg 撞已有 a.jpg）被拦截报错而不是静默覆盖
- **`-s` 智能模式**：每张图按候选格式真实编码比大小、哪个小留哪个（png 输入额外加赛无损 webp）；所有候选都没赢过原图就跳过，绝不产出更大的文件
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
cantarella compress ./photos -o dist            # 输出到独立目录 dist/（镜像结构，不动原图）
cantarella compress ./photos -s               # 智能模式：每张图自动选体积最小的格式
cantarella watermark                          # 交互模式：选水印类型逐项问答
cantarella watermark ./photos -t "© LeoZhao"  # 文字水印，默认右下角
cantarella watermark ./photos -m logo.png     # 图片水印（透明底 png 最佳）
cantarella watermark ./photos -t "内部资料" --tile -a 30 -s 8   # 斜向平铺防盗图
cantarella watermark ./photos -m logo.png -p c --opacity 0.8 -s 20   # 居中、80% 不透明度、宽 20%
cantarella watermark ./photos -t "x" --dry    # 预览：真实合成但不写任何文件
```

交互模式中直接回车即采用默认值；ESC / Ctrl+C 随时取消。

## ⚙️ 选项

### compress

| 选项                     | 说明                                                                                                       | 默认值                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------- |
| `-q, --quality <number>` | 压缩质量 1-100（png 映射为压缩等级）                                                                       | `80`                  |
| `-f, --format <format>`  | 输出格式：`jpeg` `png` `webp` `avif` `tiff` `gif`                                                          | 保持原格式            |
| `-w, --max-width <px>`   | 等比缩放的最大宽度，只缩小不放大                                                                           | `0`（不缩放）         |
| `-r, --recursive`        | 递归处理子目录                                                                                             | 关闭                  |
| `--dry`                  | 预览模式：真实计算压缩后大小，但不写任何文件                                                               | 关闭                  |
| `--report`               | 在目标目录生成 markdown 压缩报告                                                                           | 关闭                  |
| `-y, --yes`              | 跳过全部问答、直接用默认值开压（裸命令可脚本化）                                                           | 关闭                  |
| `--backup-dir <name>`    | 备份目录名（须为单纯目录名；非空且非本工具创建的目录会被拒绝使用）                                         | `.backup`             |
| `-c, --concurrency <n>`  | 同时处理几张图，1-1024（调大超过 4 时建议同时设 `UV_THREADPOOL_SIZE` 环境变量同值）                        | `4`                   |
| `-o, --out <dir>`        | 输出到独立目录（镜像源目录结构，不动原图、不写备份；压不动的文件原样拷贝保证树完整；不能指向目标目录本身） | 无（原地覆盖 + 备份） |
| `-s, --smart`            | 智能模式：每张图在原格式与 webp 间实测选最小（png 额外加赛无损 webp）；与 `-f` 互斥                        | 关闭                  |

### watermark

| 选项                     | 说明                                                                                                        | 默认值                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| `-m, --mark <file>`      | 水印图片路径（透明底 png 最佳；与 `-t` 互斥）                                                               | 无                    |
| `-t, --text <string>`    | 水印文字（与 `-m` 互斥）                                                                                    | 无                    |
| `-p, --position <pos>`   | 水印位置九宫格：`tl` `t` `tr` `l` `c` `r` `bl` `b` `br`（平铺模式下无效）                                    | `br`                  |
| `--opacity <0.1-1>`      | 不透明度                                                                                                    | `0.5`                 |
| `-s, --scale <1-100>`    | 水印大小 = 主图宽的百分比（文字即字号基准）                                                                 | 图片 `15` / 文字 `5`  |
| `--tile`                 | 平铺整张图（防盗图）                                                                                        | 关闭                  |
| `-a, --angle <deg>`      | 平铺倾斜角度，`-89` ~ `89`（0 = 不倾斜；仅在 `--tile` 下生效）                                              | `0`                   |
| `-r, --recursive`        | 递归子目录（与 compress 同义）                                                                              | 关闭                  |
| `--dry`                  | 预览模式：真实合成但不写任何文件（与 compress 同义）                                                        | 关闭                  |
| `-y, --yes`              | 跳过全部问答、直接用默认值（与 compress 同义）                                                              | 关闭                  |
| `--backup-dir <name>`    | 备份目录名（与 compress 同义）                                                                              | `.backup`             |
| `-c, --concurrency <n>`  | 同时处理几张图（与 compress 同义）                                                                          | `4`                   |

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

### 🚀 1.2.0 · 2026-09-15

- ✨ **新增** `watermark` 子命令：批量给图片加水印——图片 logo（`-m`）或文字（`-t`）二选一；九宫格定位（`-p`）、不透明度（`--opacity`）、大小按主图宽百分比（`-s`，图片默认 15 / 文字默认 5）
- ✨ **新增** `--tile` 平铺防盗图与 `-a, --angle` 斜向平铺：sharp 的 tile 只会轴对齐复制，采用"转贴纸不转网格"（先旋转水印本体再平铺）；格子比小图还大时自动等比缩入，不再整张失败
- 🛡️ 与 compress 同款安全机制：覆盖前自动备份、`--dry` 零写入预览、输出路径冲突（如 svg→png 撞已有 a.png）拦截报错、heic/svg 自动转出、交互问答 ESC 随时取消
- 🛡️ 手机竖拍照片（EXIF orientation ≥ 5）自动摆正后再贴水印，不会出现"躺平"或水印错位
- 🐛 **修复**（compress）：`-s` 与 `-f` 同时给出时报错信息不显示的问题

### 🚀 1.1.0 · 2026-09-08

- ✨ **新增** `-s, --smart` 智能模式：每张图按候选格式各真实编码一次——原格式 + webp，png 输入额外加赛无损 webp（无损赛道对截图/图形类常比 png 再小 10-25%），哪个小留哪个；所有候选都没赢过原图时跳过（负优化保护），跳过的文件保持原扩展名（覆盖模式原图不动、`--out` 模式原样拷贝）
- 🛡️ 与 `-f` 互斥（同时给出直接报错退出）；交互模式下自动跳过"输出格式"问答
- 💡 smart 每张图编码 2-3 次，批量跑比平时慢是正常现象；`--dry` 预览显示每张图的格式选择（如 `（.png -> .webp）`），报告"输出格式"列可见全部决策

### 🚀 1.0.2 · 2026-09-07

- ✨ **新增** `-c, --concurrency <n>` 并发选项：CLI 与交互问答双通道，有效范围 1-1024（与 libuv 线程池上限对齐），并发数写入压缩报告的参数行
- 💡 调大并发（>4）时建议同时设置环境变量 `UV_THREADPOOL_SIZE` 同值——sharp 的编解码跑在 libuv 线程池（默认 4 线程），只调 `-c` 不调线程池不会更快
- ✨ **新增** `-o, --out <dir>` 输出模式：结果写进独立目录树（`path.relative` + `path.join` 镜像源目录结构，含嵌套子目录），原图零改动、零备份；压不动的文件原样拷贝进目录树（报告标注"原样复制"），目录树永远完整
- 🛡️ **新增** 输出路径认领集：同名输出冲突（heic→jpg 撞已有 a.jpg、两个文件争同一个输出名）被拦截报错，不再静默"后写者胜"；覆盖模式的撞车检测同时收编进同一机制
- 🛡️ out 模式细节：`--out` 指向目标目录本身会被拒绝（那等于无备份的原地覆盖）；`--report` 的报告也写进输出目录，源目录一个字节不动

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
