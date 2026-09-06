// compress 命令的 action：参数补全（交互/CLI）-> 扫描 -> 并发压缩 -> 汇总与报告
import type { Command, OptionValues } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import pLimit from "p-limit";
import path from "node:path";
import {
  backupDirState,
  collectImages,
  formatBytes,
  formatPercent,
  markBackupDir,
  resolveRoot,
} from "#lib/utils/fs";
import { accent } from "#lib/utils/theme";
import { compressOne, OUTPUT_FORMATS, type CompressParams, type OutputFormat } from "./compressImage.ts";
import { buildReport, writeReport, type RunInfo } from "./report.ts";
import config from "#config";

// 收窄 OptionValues 宽松类型，声明这个命令真正会用到的字段类型
// （format 在 commander 眼里是 string，合法值已由 choices 校验，用时再断言成 OutputFormat）
// 空串来自交互问答"保持原格式"选项的 value，不在 OutputFormat 联合里——
// 提前声明 OutputFormat 会让问答回写和 === "" 比较都报错。宽进严出：边界宽松，内核严格
export interface CompressOptions extends OptionValues {
  quality?: number; // 压缩质量，0-100
  format?: string; // "" = 保持原格式
  maxWidth?: number; // 最大宽度，超过则按比例缩放
  dry?: boolean; // 是否预览（不写入文件）
  recursive?: boolean; // 是否递归扫描子目录
  report?: boolean; // 是否生成报告文件
  yes?: boolean; // 是否跳过问答
  backupDir?: string; // 备份目录名（CLI --backup-dir，经 parseBackupDir 校验过）
  concurrency?: number; // 并发数量 默认是 4
}

// 交互问答的答案类型（被 CLI 选项跳过的问题不会出现在结果里，全部可选；
// clack 的 text 返回字符串，quality / maxWidth 的数字转换放在合并答案时做；
// 路径不在问答里——target 缺失就固定用 process.cwd()，即用户运行命令时所在的目录）
interface Answers {
  quality?: string;
  format?: string; // '' = 保持原格式
  maxWidth?: string;
  recursive?: boolean;
  report?: boolean;
  concurrency?: string;
}

/**
 * 命令行执行函数
 * @param target 可选的目标路径；undefined 时改用 process.cwd() 并进入交互问答
 * @param options 命令行选项对象；交互模式下问答的答案会写回这个对象
 * @param command 当前这条子命令的 Command 实例；用于 getOptionValueSource 查选项值来源
 * @returns 
 */
export const compress = async (
  target: string | undefined,
  options: CompressOptions,
  command: Command,
): Promise<void> => {
  // intro/outro 是 clack 的"画框"：intro 开框、outro 收框，log.* 是框内带符号的行。
  p.intro(accent("Cantarella 图片压缩工具"));

  // 传了 target (相对 / 绝对) 就压 target，没传压当前目录
  const finalTarget = target === undefined ? process.cwd() : path.resolve(target.trim())

  let recursive = options.recursive ?? false
  let report = options.report ?? false
  // 备份目录名：CLI 给了用 CLI 的（parseBackupDir 已保证是单纯目录名），否则走 config 默认
  const backupDir = options.backupDir ?? config.compress.backupDir

  if (target === undefined && !options.yes) {
    // 进入交互模式
    // getOptionValueSource：commander 记录了每个选项值从哪来，'cli' = 用户亲手输入
    const fromCli = (name: string) => command.getOptionValueSource(name) === 'cli'
    
    // 条件展开实现跳过某个问题，如果展开的是一个空对象就相当于什么都没发生
    const a: Answers = await p.group({
      ...(fromCli('concurrency') ? {}: {
        concurrency: () =>
          p.text({
            message: '同时压缩文件数量',
            placeholder: '4',
            defaultValue: '4',
            validate: v => {
              if (v === undefined || v.trim() === '') return
              const n = Number(v)
              if (!Number.isInteger(n) || n < 1 || n > 1024) {
                return '请输入 1 - 1024 范围内的正整数'
              }
            }
          })
      }),
      ...(fromCli('quality') ? {} : {
        quality: () => 
          p.text({
            message: '压缩质量（1-100）',
            placeholder: '80',
            defaultValue: '80',
            validate: v => {
              // clack 的顺序是"先 validate 原始输入，后 finalize 补 defaultValue"——
              // 空输入必须在这里放行（返回 undefined），'80' 才有机会在 finalize 阶段生效
              if (v === undefined || v.trim() === '') return
              const n = Number(v)
              if (!Number.isInteger(n) || n < 1 || n > 100) {
                return '请输入 1 - 100 范围内的整数'
              }
            }
          })
      }),
      ...(fromCli('format') ? {} : {
        format: () =>
          p.select({
            message: '输出格式',
            options: [
              {
                value: '', // 这正是 compress.ts:18-20 注释说的——空串不在 OutputFormat 联合类型里，所以 Answers.format 只能声明成宽泛的 string。
                label: '保持原格式',
                hint: 'heic => jpeg, svg => png 自动转换',
              },
              // 格式清单从 OUTPUT_FORMATS 派生，与 CLI 的 --format 白名单共用一份
              ...OUTPUT_FORMATS.map(f => ({ value: f, label: f })),
            ]
          })
      }),
      ...(fromCli('maxWidth') ? {} : {
        maxWidth: () =>
          p.text({
            message: '最大宽度 px（0 = 不缩放）',
            placeholder: '0',
            defaultValue: '0',
            validate: v => {
              // 同上：放行空输入，让 defaultValue '0'（= 不缩放）在 finalize 生效
              if (v === undefined || v.trim() === '') return
              const n = Number(v)
              if (!Number.isInteger(n) || n < 0) {
                return '请输入不小于 0 的整数'
              }
            }
          })
      }),
      ...(fromCli('recursive') ? {} : {
        recursive: () =>
          p.confirm({
            message: '递归处理子目录？',
            initialValue: false, // confirm 默认停在 Yes，这里按原行为默认 No
          })
      }),
      ...(fromCli("report") ? {} : {
        report: () =>
          p.confirm({
            message: "生成 markdown 压缩报告？",
            initialValue: false,
          }),
      })
    },
    {
      // 任何一个问题被 ESC / Ctrl + C 取消，都会走这里
      onCancel: () => {
        // 用户主动取消不算失败（退出码 0 ）此刻 spinner 还没启动、没有待 flush 的输出，回调里也没有别的办法中断主流程，直接退出即可，立刻终止进程
        p.cancel('用户取消操作')
        process.exit(0)
      }
    })

    if (a.concurrency !== undefined) options.concurrency = Number(a.concurrency)
    // 把答案写回 options text 的答案此时才转数字——validate 已保证 Number() 能安全转换
    if (a.quality !== undefined) options.quality = Number(a.quality)
    if (a.format !== undefined) options.format = a.format
    if (a.maxWidth !== undefined && Number(a.maxWidth) > 0) options.maxWidth = Number(a.maxWidth)
    if (a.recursive !== undefined) recursive = a.recursive
    if (a.report !== undefined) report = a.report
  }
  // target 已经给出的时候没有交互，选项全部是 CLI 的默认值 - 保证命令可脚本化
  const quality = options.quality ?? 80
  const concurrency = options.concurrency ?? 4
  const format = options.format === undefined || options.format === '' ?
    undefined : (options.format as OutputFormat)
  const maxWidth = options.maxWidth
  const dry = options.dry ?? false

  // spinner 在问答结束后才启动：问答期间终端整块交给 clack 的问答渲染，
  // 转圈动画和问答界面会互相覆盖对方的行
  const spinner = p.spinner()
  try {
    spinner.start('正在扫描文件...')
    let root = ''
    let isFile = false
    try {
      const r = await resolveRoot(finalTarget)
      root = r.root
      isFile = r.isFile
    } catch {
      spinner.error(`路径不存在或无法访问：${finalTarget}`)
      process.exitCode = 1 // 让脚本调用方能感知失败，但不会立刻终止进程
      return
    }

    let files: string[]
    if (isFile) {
      const ext = path.extname(finalTarget).toLowerCase()
      if (!config.compress.extensions.includes(ext)) {
        spinner.error(`不支持的图片类型：${ext === "" ? "（无扩展名）" : ext}`);
        process.exitCode = 1
        return
      }
      files = [finalTarget]
    } else {
      files = await collectImages(root, recursive, backupDir)
    }

    if (files.length === 0) {
      // 永远不需要写 process.exitCode = 0——自然退出的默认值就是 0，成功路径“什么都不设”正是标准写法
      spinner.stop()
      p.outro('没有找到可处理的图片') // 没事可做也算正常退出
      return
    }

    // 备份目录预检：已存在、非空、且没有 cantarella 标记的自定义目录
    // 视为用户自己的地盘、不共用、一个文件都不动，报错指路。
    // 撞名的目录一旦被共用，EXCL 会把用户的同名文件误判成"已备份"，原图被覆盖后最初版就永久丢了。
    // 例外：默认名 .backup 无标记视为旧版本产生的历史备份目录，放行收编——
    // .backup 是工具的保留命名空间，是历史备份的概率远大于用户故意占用
    const bdState = await backupDirState(root, backupDir)
    if (bdState === 'foreign' && backupDir !== config.compress.backupDir) {
      spinner.error(`备份目录 ${backupDir} 已存在且包含非 cantarella 创建的文件，为避免覆盖或混淆已停止（未改动任何文件）。请换一个 --backup-dir 名字，或先处理该目录`)
      process.exitCode = 1
      return
    }
    // 首次使用（absent/empty）或收编历史目录时写入标记：之后运行认出标记直接续用、不再打扰——
    // 否则"再跑一遍压新图"这种正常工作流每次都会撞上预检
    if (bdState !== 'ours' && !dry) await markBackupDir(root, backupDir)

    const params: CompressParams = { quality, format, maxWidth, dry, backupDir }
    const limit = pLimit(concurrency)
    const batch = new Set(files) // 传给每个任务，用于输出冲突检测
    let processed = 0 // 当前处理文件的下标

    spinner.message(`${ dry ? '预览' : '压缩' } ${processed}/${files.length}`)
    const results = await Promise.all(
      files.map(f => {
        return limit(async () => {
          const r = await compressOne(f, params, root, batch)
          processed += 1
          spinner.message(
            `${ dry ? '预览' : '压缩' } ${processed}/${files.length} ${path.basename(f)}`,
          )
          return r
        })
      })
    )

    const skipped = results.filter(r => r.status === 'skipped')
    const failed = results.filter(r => r.status === 'failed')
    const beforeTotal = results.reduce((s, r) => s + r.beforeBytes, 0)
    const afterTotal = results.reduce((s, r) =>
      s + (r.status === 'failed' ? r.beforeBytes : r.afterBytes), 0)

    const summary = [
      `${dry ? "预览" : "压缩"}完成：${results.length} 个文件`,
      `${formatBytes(beforeTotal)} → ${formatBytes(afterTotal)}`,
      `节省 ${formatPercent(beforeTotal, afterTotal)}`
    ]
    if (skipped.length > 0) summary.push(`跳过 ${skipped.length}`)
    spinner.stop()
    p.log.success(summary.join(','))

    if (failed.length > 0) {
      p.log.error(`失败 ${failed.length} 个：`);
      for (const f of failed) {
        p.log.error(
          `${path.relative(root, f.file)} —— ${f.error ?? '未解析出发生了什么'}`
        )
      }
      process.exitCode = 1 // 非零退出码：脚本调用方能感知"这轮有失败"
    }

    // 此时还未输出任何文件
    if (dry) {
      p.log.message(chalk.bold("预览明细（未写入任何文件）："));
      for (const r of results) {
        const rel = path.relative(root, r.file)
        if (r.status === 'failed') {
          p.log.error(`${rel} —— ${r.error}`)
        } else if (r.status === 'skipped') {
          p.log.warn(`${rel} 会跳过（重压缩不会变小）`)
        } else {
          p.log.success(
            `${rel} ${formatBytes(r.beforeBytes)} => ${formatBytes(r.afterBytes)}（节省 ${formatPercent(r.beforeBytes, r.afterBytes)}）`
          )
        }
      }
      if (report) {
        p.log.warn('--dry 模式承诺不会输出任何文件，已忽略 --report')
      }
      p.outro('预览完成')
      return
    }

    if (report) {
      const info: RunInfo = {
        target: finalTarget,
        root,
        recursive,
        concurrency,
        params,
        startedAt: new Date()
      }
      const reportFile = await writeReport(root, buildReport(info, results))
      p.log.info(`报告已生成：${reportFile}`)
      p.outro('完成')
    }
  } catch (err) {
    // 兜底：扫描/写报告等环节的意外错误
    //（单文件错误已在 compressOne 内部消化，问答取消由 onCancel 处理——所以问答不进 try）
    spinner.stop()
    p.log.error(err instanceof Error ? err.message: String(err))
    process.exitCode = 1
  }
}
