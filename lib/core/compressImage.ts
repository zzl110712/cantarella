import sharp, { type Sharp } from 'sharp'
import path from 'path'
import { randomUUID } from 'crypto'
import { readFile, rename, unlink, writeFile } from 'fs/promises'
import { backupFile, replaceExt } from '#lib/utils/fs'

// 工具支持输出格式（单一数据源：CLI 的 --format 白名单和交互问答的可选值都从这派生）
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

// 只能作为输入的格式
const INPUT_ONLY_FORMATS = ['heif', 'svg'] as const
export type InputFormat = OutputFormat | (typeof INPUT_ONLY_FORMATS)[number]

// 【输出格式】写文件用的扩展名
const EXT_BY_FORMAT: Record<OutputFormat, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  tiff: '.tiff',
  gif: '.gif'
}

// 只能解码的格式必须转出，设置默认转换目标
const FALLBACK_OUTPUT: Record<
  (typeof INPUT_ONLY_FORMATS)[number],
  OutputFormat
> = {
  heif: 'jpeg',
  svg: 'png'
}

// 扩展名和输入格式映射
const EXT_TO_INPUT_FORMAT: Record<string, InputFormat> = {
  ".jpg": "jpeg",
  ".jpeg": "jpeg",
  ".png": "png",
  ".webp": "webp",
  ".avif": "avif",
  ".tiff": "tiff",
  ".gif": "gif",
  ".heic": "heif",
  ".heif": "heif",
  ".svg": "svg",
}

/**
 * 压缩参数（CLI 选项与交互问答最终汇聚成这一个对象，传给每个文件）
 * quality 1-100；png 会映射成压缩等级（见 pngOptions）
 * format 指定输出格式；undefined = 尽量保持原格式
 * maxWidth 最大宽度 px；只缩小不放大
 * dry true = 真实编码计算大小，但不写任何文件
 * backupDir 备份目录名（默认 .backup，可被 --backup-dir 覆盖）
 */
export interface CompressParams {
  quality: number;
  format?: OutputFormat;
  maxWidth?: number;
  dry: boolean;
  backupDir: string;
}

/**
 * 单个文件的处理结果（报告与终端汇总的数据来源）
 * file 输入文件绝对路径
 * output 输出文件路径（dry 时是"将会写入"的路径）
 * format 实际输出格式
 * beforeBytes 输入的时候文件大小
 * afterBytes 输出的时候文件大小 失败的时候是 0
 * status 
 * error failed 的时候的错误信息
 */
export interface FileResult {
  file: string;
  output: string;
  format: OutputFormat;
  beforeBytes: number;
  afterBytes: number;
  status: "done" | "skipped" | "failed";
  error?: string;
}

// 【类型守卫】将 string 类型收窄为 输出格式字面量类型
function isOutputFormat(f: string): f is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(f)
}

/**
 * png 是无损格式，没有 jpeg 那种"有损 quality"：
 *  把 quality 反向映射成 0-9 压缩等级（quality 越低，压得越狠、编码越慢）
 *  quality <= 60 时追加 palette（量化到最多 256 色），这是 png 唯一有效的"有损"手段
 * @param quality 压缩等级
 * @returns 压缩结果
 */
function pngOptions(quality: number): {
  compressionLevel: number;
  palette?: boolean;
} {
  const compressionLevel = Math.round(((100 - quality) / 100) * 9)
  return quality <= 60
    ? { compressionLevel, palette: true }
    : { compressionLevel }
}

/**
 * 给 Sharp 管道装上编码器（.jpeg 就是编码器）
 * 为什么叫管道：每个环节的输出都会成为下一个环节的输入
 * @param p 管道对象
 * @param format 输出格式
 * @param quality 压缩质量
 * @returns 管道对象
 */
function applyOutputFormat(p: Sharp, format: OutputFormat, quality: number): Sharp {
  switch (format) {
    case 'jpeg':
      return p.jpeg({ quality, mozjpeg: true }) // mozjpeg: true 换用 Mozilla 的 JPEG 编码器（更优的霍夫曼表 + trellis 量化），同质量再小 5-10%，代价是编码稍慢
    case 'png':
      return p.png(pngOptions(quality))
    case 'webp':
      return p.webp({ quality })
    case 'avif':
      return p.avif({ quality }) // 同质量体积远小于 jpeg，但编码慢一个量级，spinner 转得久是正常现象
    case 'tiff':
      return p.tiff({ quality }) // sharp 默认 compression:'jpeg'（有损），quality 直接生效；显式用 lzw/zstd 才是无损，届时 quality 无效
    case 'gif':
      return p.gif() // 调色板格式（最多 256 色），没有有损 quality；可调的是 colours/effort 等，默认近似无损重编码
  }
}

/**
 * 压缩每一张图片
 * @param file 图片路径
 * @param params 压缩参数
 * @param root 基准目录
 * @param batch 本批所有待处理文件的绝对路径集合，用来检测"输出路径撞车"
 * @returns 压缩后图片信息
 */
export async function compressOne(
  file: string,
  params: CompressParams,
  root: string,
  batch: Set<string>
): Promise<FileResult> {
  // 先组装错误信息，Promise.all 是一个异常全部异常的模式，所以整个函数不能异常
  const result: FileResult = {
    file,
    output: file,
    format: 'jpeg',
    beforeBytes: 0,
    afterBytes: 0,
    status: 'failed'
  }

  try {
    // 这里为什么先读文件，而不是直接将文件目录传给 Sharp，因为之前也提到过，sharp 内部是依赖 libvips 实现的，libvips 在 windows 里面有个习惯，不会将文件内容直接读进来，而是把文件直接映射到内存里面（mmap），那也就是说文件可能在后面覆盖的时候仍然被占用，改成 readFile 读取文件 Buffer 之后，会将文件生成一个副本存到内存中，libvips  读取的始终是没内存里面的副本，readFile 读完文件就会立刻释放文件
    const input = await readFile(file)
    result.beforeBytes = input.byteLength
    const ext = path.extname(file).toLowerCase()
    const inputFormat = EXT_TO_INPUT_FORMAT[ext]
    // 打开 tsconfig.json 的 noUncheckedIndexedAccess 开关，索引访问的类型就会强制变为 type | undefined
    if (inputFormat === undefined) {
      throw new Error(`不支持的图片扩展名：${ext === '' ? '无扩展名' : ext}`)
    }

    /**
     * HEIF 是容器规范（ISO 23008-12），AVIF = HEIF 容器 + AV1 编码器，HEIC = 同容器 + HEVC 编码器。
     * libheif 统一把这两者报成 format: 'heif'，于是 .avif 会被误判成“只能解码的 heif”而强制转 jpeg——把批里最小的文件越压越大。
     * 扩展名虽不“聪明”，但它是用户眼里的事实，行为可预期。元数据只取它真正可靠的两个字段：width 和 hasAlpha。
     */
    const meta = await sharp(input).metadata()
    // 在 compressImage.ts 142 行代码 => 会将 format 的类型收窄为 undefined
    const outputFormat: OutputFormat = 
      params.format ?? (
        isOutputFormat(inputFormat)
          ? inputFormat
          : FALLBACK_OUTPUT[inputFormat]
      )
    // 确定输出文件路径和输出文件路径扩展名
    const keepFormat = outputFormat === inputFormat
    const output = keepFormat ? file : replaceExt(file, EXT_BY_FORMAT[outputFormat])
    result.output = output
    result.format = outputFormat
    // 因为 heic 文件输入之后会被转换为 heif ，但是 heif 只能输入，输出会转换为 jpeg，如果待转换列表中本身就有 a.jpeg，那么输出会有冲突
    if (output !== file && batch.has(output)) {
      throw new Error(`输出 ${path.basename(output)} 和待处理文件同名，已跳过转换（该文件自身会被处理）`)
    }

    let pipeline: Sharp = sharp(input)

    if (params.maxWidth !== undefined && meta.width !== undefined && meta.width > params.maxWidth) {
      pipeline = pipeline.resize({
        width: params.maxWidth,
        withoutEnlargement: true // 只缩小不放大
      })
    }

    // jpeg 不支持透明通道，带 alpha 的图片，例如透明 png 转 jpeg 前先铺白底
    if (outputFormat === 'jpeg' && meta.hasAlpha) {
      pipeline.flatten({ background: '#ffffff' })
    }

    pipeline = applyOutputFormat(pipeline, outputFormat, params.quality)

    // 编码到内存， dry 模式依赖内存文件拿到压缩后真实大小，但是不会将文件写盘
    const { data } = await pipeline.toBuffer({ resolveWithObject: true }) //  resolveWithObject 让 toBuffer() 不只是返回裸 Buffer，而是返回一个对象，里面同时包含图片数据和图片信息, 那么结构还可以拿到另外一个属性 info ，但是这里只用 data 就够了。
    result.afterBytes = data.byteLength

    const wouldSkip = keepFormat && data.byteLength >= input.byteLength
    // 如果用户明确需要更换文件后缀名，那也要正常输出
    if (wouldSkip) {
      result.status = 'skipped'
      return result
    }
    // 如果是 dry 模式，不需要写盘直接输出即可
    if (params.dry) {
      result.status = 'done'
      return result
    }

    // 备份文件，保证文件不会丢失，如果后缀名不一样不需要备份
    if (keepFormat) await backupFile(root, file, params.backupDir)
    const tmp = `${output}${randomUUID()}.tmp`
    try {
      // 写入临时文件
      await writeFile(tmp, data)
      // 替换旧文件
      await rename(tmp, output)
    } catch(err) {
      // 删除残留文件
      await unlink(tmp).catch(() => {})
      throw err
    }
    result.status = 'done'
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }
}
