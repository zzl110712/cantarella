import { Command, InvalidArgumentError, Option } from "commander";
import { compress } from "./compress.ts";
import { OUTPUT_FORMATS } from "./compressImage.ts";

// commander 拿到的原始值是字符串 输出 InvalidArgumentError 的时候 commander 自动打印错误信息并以非 0 码退出（不会进入自己的代码）
function parseQuality(value: string): number {
  const n = Number.parseInt(value, 10) // 按 十进制 解析成正数
  if (Number.isNaN(n) || n < 1 || n > 100) {
    // InvalidArgumentError 错误码一般是 1 ，comander 管理，提示更友好，在 parse 函数内部，“让 commander 知道出错了”的唯一手段就是抛 InvalidArgumentErro
    throw new InvalidArgumentError('必须是 1 - 100 的整数')
  }
  return n
}

function parsePositiveInt(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n <= 0) {
    throw new InvalidArgumentError('必须是正整数')
  }
  return n
}

// 备份目录名只是"名字"，不是路径——校验它是单纯的目录名，
// 防止 ../evil、绝对路径、子路径这类注入（否则备份可能写到目标目录之外）
function parseBackupDir(value: string): string {
  const name = value.trim()
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new InvalidArgumentError('必须是单纯的目录名（不能为空，不能包含 / \\ . ..）')
  }
  return name
}

function parseConcurrency(value: string): number {
  const n = Number.parseInt(value, 10)
  if (Number.isNaN(n) || n < 1 || n > 1024) {
    throw new InvalidArgumentError('必须是 1 - 1024 的整数')
  }
  return n
}

/**
 * 有些选项需要更复杂的配置（限定可选值、环境变量、默认值、互斥……）
 * 这些配置是以链式方法的形式挂在选项上的，简写字符串挂不住。
 * 所以 commander 提供了完整形态：先 new Option() 独立构造、链式配置，之后用 .addOption(formatOption) 挂到命令上
 */
const formatOption = new Option(
  "-f, --format <format>",
  "转换输出格式（默认保持原格式）",
).choices([...OUTPUT_FORMATS]); // 白名单从 OUTPUT_FORMATS 派生（单一数据源，加格式只改那一处）；“值在某集合内”用 choices，需要计算才写 parse 函数

export function myCompress(program: Command): void {
  program
    .command('compress [target]')
    .description('批量压缩图片（覆盖原文件前自动备份到备份目录，默认 .backup/）')
    .option(
      '-q, --quality <number>',
      '压缩质量 1-100，默认 80（png 映射为压缩等级）',
      parseQuality,
      80
    )
    .addOption(formatOption)
    .option(
      '-w, --max-width <px>',
      '等比缩放的最大宽度，只缩小不放大',
      parsePositiveInt
    )
    .option('-r, --recursive', '递归处理子目录', false)
    .option('--dry', '预览模式：真实计算压缩后大小，但不写任何文件', false)
    .option('--report', '在目标目录生成 markdown 压缩报告', false)
    .option('-y, --yes', '跳过全部问答、直接用默认值开压', false)
    .option('--backup-dir <name>', '备份目录名（默认 .backup）', parseBackupDir)
    .option('-c, --concurrency <n>', '同时处理多少张图片', parseConcurrency, 4)
    .action(compress) // action 参数是固定的 => 第四个永远是 options（选项参数），第五个永远是 Command实例，现在只有一个位置参数，在 compress [target] target 就是位置参数，也可以声明多个位置参数
}
