import type { Command, OptionValues } from "commander";
import * as p from '@clack/prompts';
import pLimit from 'p-limit';
import path from 'path'
import { readFile } from "fs/promises";
import {
  backupDirState,
  collectImages,
  formatBytes,
  markBackupDir,
  resolveRoot
} from '#lib/utils/fs'
import { accent } from "#lib/utils/theme";
import config from '#config'
import {
  POSITION_LABEL,
  WATERMARK_POSITIONS,
  describeWatermark,
  watermarkOne,
  type WatermarkFileParams,
  type WatermarkOptions,
  type WatermarkPosition
} from "./watermarkImage.ts";

export interface WatermarkCliOptions extends OptionValues {
  mark?: string;
  text?: string;
  position?: string;
  opacity?: number;
  scale?: number;
  tile?: boolean;
  angle?: number;
  recursive?: boolean;
  dry?: boolean;
  yes?: boolean;
  backupDir?: string;
  concurrency?: number;
}

// dry 明细 => 加水印之后图片边大多少
const formatDelta = (before: number, after: number): string => {
  if (before <= 0) return '-'
  const d = (after / before - 1) * 100 // -1 计算多出来的部分
  return `${ d >= 0 ? '+' : '' }${d.toFixed(1)}%`
}

export const watermark = async (
  target: string | undefined,
  options: WatermarkCliOptions,
  command: Command,
): Promise<void> => {
  const spinner = p.spinner()
  p.intro(accent('Cantarella 图片水印工具'))

  if (options.mark !== undefined && options.mark.trim() === '') options.mark = undefined
  if (options.text !== undefined && options.text.trim() === '') options.text = undefined
  
  if (options.mark !== undefined && options.text !== undefined) {
    p.log.error('-m 和 -t 只能二选一')
    process.exitCode = 1
    return
  }

  const hasSource = options.mark !== undefined || options.text !== undefined;
  if (!hasSource && (target !== undefined || options.yes)) {
    p.log.error('请用 -m 指定水印图片，或 -t 指定水印文字')
    process.exitCode = 1
    return
  }

  const finalTarget = target === undefined ? process.cwd() : path.resolve(target.trim());
  let recursive = options.recursive ?? false;
  const backupDir = options.backupDir ?? config.compress.backupDir;
  const dry = options.dry ?? false;

  if (target === undefined && !options.yes) {
    const fromCli = (name: string) => command.getOptionValueSource(name) === 'cli'
    const handleCancel = () => {
      p.cancel('用户取消操作')
      process.exit(0)
    }

    // 这里为什么要单独将水印类型拎出来做，因为 p.group 的时候全部选项引用不了之前选项的答案，而之后的每一个选项都会依赖水印类型这个答案，因此要先做，之后再在每一个选项中进行判断
    const kindAnswer = fromCli('mark')
      ? 'mark'
      : fromCli('text')
        ? 'text'
        : await p.select({
          message: '水印类型',
          options: [
            { value: 'mark', label: '图片水印', hint: 'logo 角标，透明底最佳' },
            { value: 'text', label: '文字水印', hint: '© / 内部资料' }
          ]
        })
    
    // 官方类型收尾 (value: unknown) => value is symbol => 类型收窄可以将 Symbol 类型的返回值拦截下来
    if (p.isCancel(kindAnswer)) {
      p.cancel('用户取消操作')
      // process.exit 在 @types/node 里的返回类型是 never（“永不正常返回”）。 if 分支里面的 process.exit 可以告诉 TS 这个结果永远不会到结尾，那之后的代码就会剔除 Symbol
      // 这里需要处理 Symbol 的原因是以为内 Symbol === 'mark' 成立，程序会继续向下走不会中断 => 和用户点击 ESC 意愿相悖
      process.exit(0)
    }

    const kind: 'mark' | 'text' = kindAnswer

    const tileAnswer = fromCli('tile')
      ? (options.tile ?? false)
      : await p.confirm({ message: '平铺防盗图？', initialValue: false })
    
    if (p.isCancel(tileAnswer)) {
      p.cancel('用户取消操作')
      process.exit(0)
    }

    options.tile = tileAnswer

    const a = await p.group(
      {
        // 路径 / 内容二选一。没有 defaultValue 的问题要拦空——路径和内容不许为空
        ...(kind === 'mark' && !fromCli('mark')
          ? {
              mark: () =>
                p.text({
                  message: '水印图片路径',
                  placeholder: 'logo.png',
                  validate: v => ((v ?? '').trim() === '' ? '请输入路径' : undefined)
                })
            }
          : {}),
        ...(kind === 'text' && !fromCli('text')
          ? {
              text: () =>
                p.text({
                  message: '水印文字',
                  placeholder: '© LeoZhao',
                  validate: v => ((v ?? '').trim() === '' ? '请输入内容' : undefined)
                })
            }
          : {}),
        ...(tileAnswer || fromCli('position')
          ? {}
          : {
              position: () =>
                p.select({
                  message: '水印位置',
                  // 选项从 WATERMARK_POSITIONS + POSITION_LABEL 派生——和 compress 的
                  // 格式选项从 OUTPUT_FORMATS 派生是同一个套路（单一数据源）
                  options: WATERMARK_POSITIONS.map(pos => ({ value: pos, label: POSITION_LABEL[pos] }))
                })
            }),
        ...(tileAnswer && !fromCli('angle')
          ? {
              angle: () =>
                p.text({
                  message: '平铺倾斜角度（度）',
                  defaultValue: '30',
                  validate: v => {
                    if (v === undefined || v.trim() === '') return
                    const n = Number(v)
                    if (!Number.isInteger(n) || n < -89 || n > 89) {
                      return '请输入 -89 - 89 的整数（0 = 不倾斜）'
                    }
                  }
                })
            }
          : {}),

        ...(fromCli('scale')
          ? {}
          : {
              scale: () =>
                p.text({
                  message: '水印大小（主图宽的百分比）',
                  defaultValue: kind === 'mark' ? '15' : '5',   // 模式化默认在这落地
                  validate: v => {
                    // 有 defaultValue 的问题必须放行空输入——clack 先 validate 后 finalize，
                    // 拦空的话默认值永远没机会生效（compress.ts L113-115 注释同款）
                    if (v === undefined || v.trim() === '') return
                    const n = Number(v)
                    if (!Number.isInteger(n) || n < 1 || n > 100) {
                      return '请输入 1 - 100 的整数'
                    }
                  }
                })
            })
      },
      { onCancel: handleCancel }
    )

    // 答案写回 options。text 的答案是 string，数字在这一步统一转——
    // validate 已保证 Number() 能安全转换，后面只消费成品
    if (a.mark !== undefined) options.mark = a.mark
    if (a.text !== undefined) options.text = a.text
    if (a.angle !== undefined) options.angle = Number(a.angle)
    if (a.position !== undefined) options.position = a.position
    if (a.scale !== undefined) options.scale = Number(a.scale)
  }


  let markBuffer: Buffer | undefined;
  let markName: string | undefined;
  if (options.mark !== undefined) {
    const markPath = path.resolve(options.mark.trim())
    try {
      markBuffer = await readFile(markPath)
    } catch {
      p.log.error(`无法读取水印图片：${markPath}`)
      process.exitCode = 1
      return
    }
    markName = path.basename(markPath)
  }

  const wm: WatermarkOptions = {
    markBuffer,
    markName,
    text: options.text,
    position: (options.position ?? 'br') as WatermarkPosition,
    opacity: options.opacity ?? 0.5,
    scale: options.scale ?? (markBuffer !== undefined ? 15 : 5),
    tile: options.tile ?? false,
    angle: options.angle ?? 0,
  }
  const concurrency = options.concurrency ?? 4;

  try {
    spinner.start('正在扫描文件......')
    let root = ''
    let isFile = false

    try {
      const r = await resolveRoot(finalTarget)
      root = r.root
      isFile = r.isFile
    } catch {
      spinner.error(`路径不存在或无法访问：${finalTarget}`)
      process.exitCode = 1
      return
    }

    let files: string[];
    if (isFile) {
      const ext = path.extname(finalTarget).toLowerCase()
      if (!config.compress.extensions.includes(ext)) {
        spinner.error(`不支持的图片类型：${ext === '' ? '（无扩展名）' : ext}`)
        process.exitCode = 1
        return
      }
      files = [finalTarget]
    } else {
      files = await collectImages(root, recursive, backupDir)
    }

    if (files.length === 0) {
      spinner.stop()
      p.outro('没有找到可处理的图片')
      return
    }

    const bdState = await backupDirState(root, backupDir)
    if (bdState === 'foreign' && backupDir !== config.compress.backupDir) {
      spinner.error(`备份目录 ${backupDir} 已存在且包含非 cantarella 创建的文件，为避免覆盖或混淆已停止（未改动任何文件）。请换一个 --backup-dir 名字，或先处理该目录`)
      process.exitCode = 1
      return
    }

    if (bdState !== 'ours' && !dry) await markBackupDir(root, backupDir)

    const params: WatermarkFileParams = { watermark: wm, dry, backupDir }
    const limit = pLimit(concurrency)

    const claimed = new Set<string>(files)
    let processed = 0

    spinner.message(`${dry ? '预览' : '水印'} ${processed}/${files.length}`)
    const results = await Promise.all(
      files.map(f => 
        limit(async () => {
          const r = await watermarkOne(f, params, root, claimed)
          processed += 1
          spinner.message(`${dry ? '预览' : '水印'} ${processed}/${files.length} ${path.basename(f)}`)
          return r
        })
      )
    )

    const failed = results.filter(r => r.status === 'failed')
    const beforeTotal = results.reduce((s, r) => s + r.beforeBytes, 0)
    const afterTotal = results.reduce((s, r) => 
      s + (r.status === 'failed' ? r.beforeBytes : r.afterBytes), 0)

    spinner.stop()
    p.log.success(
      [
        `${dry ? '预览' : '水印'}完成：${results.length} 个文件`,
        describeWatermark(wm),
        `${formatBytes(beforeTotal)} → ${formatBytes(afterTotal)}`
      ].join('，')
    )

    if (failed.length > 0) {
      p.log.error(`失败 ${failed.length} 个：`)
      for (const f of failed) {
        p.log.error(`${path.relative(root, f.file)} —— ${f.error ?? '未解析出发生了什么'}`)
      }
      process.exitCode = 1
    }

    if (dry) {
      p.log.message('预览明细（未写入任何文件）：')
      for (const r of results) {
        const rel = path.relative(root, r.file)
        if (r.status === 'failed') {
          p.log.error(`${rel} —— ${r.error}`)
        } else {
          p.log.success(
            `${rel} ${formatBytes(r.beforeBytes)} => ${formatBytes(r.afterBytes)}（${formatDelta(r.beforeBytes, r.afterBytes)}）`
          )
        }
      }
      p.outro('预览完成')
      return
    }
    p.outro('完成')
  } catch (err) {
    spinner.stop()
    p.log.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}