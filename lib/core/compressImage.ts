import sharp, { type Sharp } from 'sharp'
import path from 'path'
import { randomUUID } from 'crypto'
import { readFile, rename, unlink, writeFile, mkdir } from 'fs/promises'
import { backupFile, replaceExt } from '#lib/utils/fs'

// 工具支持输出格式（单一数据源：CLI 的 --format 白名单和交互问答的可选值都从这派生）
export const OUTPUT_FORMATS = ['jpeg', 'png', 'webp', 'avif', 'tiff', 'gif'] as const
export type OutputFormat = (typeof OUTPUT_FORMATS)[number]

// 只能作为输入的格式
const INPUT_ONLY_FORMATS = ['heif', 'svg'] as const
export type InputFormat = OutputFormat | (typeof INPUT_ONLY_FORMATS)[number]

// 【输出格式】写文件用的扩展名
export const EXT_BY_FORMAT: Record<OutputFormat, string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
  avif: '.avif',
  tiff: '.tiff',
  gif: '.gif'
}

// 只能解码的格式必须转出，设置默认转换目标
export const FALLBACK_OUTPUT: Record<
  (typeof INPUT_ONLY_FORMATS)[number],
  OutputFormat
> = {
  heif: 'jpeg',
  svg: 'png'
}

// 扩展名和输入格式映射
export const EXT_TO_INPUT_FORMAT: Record<string, InputFormat> = {
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
 * outDir 指定输出目录
 * 注意：并发数不在这里——它属于批处理层（compress.ts 的 pLimit 与 RunInfo），不是单文件参数
 */
export interface CompressParams {
  quality: number;
  format?: OutputFormat;
  maxWidth?: number;
  dry: boolean;
  backupDir: string;
  outDir?: string;
  smart?: boolean;
}

/**
 * 单个文件的处理结果（报告与终端汇总的数据来源）
 * file 输入文件绝对路径
 * output 输出文件路径（dry 时是"将会写入"的路径）
 * format 实际输出格式
 * beforeBytes 输入的时候文件大小
 * afterBytes 输出的时候文件大小 失败的时候是 0
 * status done=已写入压缩结果；skipped=未压缩（覆盖模式=原图未动，out 模式=原样拷贝进目录树）；failed=失败
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

// png 是无损格式，png→webp 是"有损换体积"。要不要给 png 加一条无损赛道——把 .webp({ lossless: true }) 也纳入候选，无损 webp 对截图/图形类常常比 png 小 10-25%，对照片类常常反而更大。把它加进候选集，输的那边自然会被淘汰，正好用上"比大小"机制本身。
interface Candidate {
  format: OutputFormat; // 编成什么格式（决定扩展名、报告显示）
  lossless?: boolean; // webp 专有变体：true = 无损模式 => 只有 png 特殊处理
}

// png 压缩档位表：把 quality 踩在深位台阶上（表必须按 minQuality 降序排，find 才能命中最近档）
interface PngGear {
  minQuality: number; // 命中条件：quality >= minQuality
  colours: number; // 调色板颜色上限：>16=8bpp，<=16=4bpp，<=4=2bpp，<=2=1bpp
  dither: number; // 抖动强度：视觉上防色带，字节上是 deflate 压不动的噪声
}

const PNG_GEARS: PngGear[] = [
  { minQuality: 80, colours: 256, dither: 1 }, // 近无损量化；开 palette 本身就是第一级台阶（photo 1340->280）
  { minQuality: 70, colours: 256, dither: 0.5 }, // 只降抖动：8bpp 内照片不动，平滑图形 -15%
  { minQuality: 60, colours: 16, dither: 1 }, // 4bpp 台阶：照片第一次断崖（-68%）；16 色必须全抖动防色带
  { minQuality: 50, colours: 16, dither: 0.5 }, // 档内微调：平滑图形 -17%
  { minQuality: 40, colours: 16, dither: 0 }, // 关抖动：平滑图形 -94%（索引流重新变得可压）
  { minQuality: 10, colours: 4, dither: 0 }, // 2bpp 台阶：照片再腰斩
  { minQuality: 1, colours: 2, dither: 0 } // 1bpp 极限：黑白二值
]

// 【类型守卫】将 string 类型收窄为 输出格式字面量类型
export function isOutputFormat(f: string): f is OutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(f)
}

/**
 * 输入格式 -> 输出基准：能保持原格式的保持，只能输入的（heif/svg）走兜底表转出
 * @param input 输入格式
 * @returns 输出格式
 */
export function baseOutputFormat(input: InputFormat): OutputFormat {
  return isOutputFormat(input) ? input : FALLBACK_OUTPUT[input]
}

/**
 * png 是无损格式，没有 jpeg 那种平滑的"有损 quality"：
 * 体积的硬台阶是位深（24bpp -> 8bpp -> 4bpp -> 2bpp -> 1bpp），档位表就是把 quality 踩在台阶上
 * compressionLevel 恒定 9：zlib 无损、压多狠都不损画质，没有理由不顶格
 * （旧公式"quality 越低 cl 越高"是语义倒置：q100 会算出 cl0 = 完全不压缩）
 * 为什么不用 sharp 的 quality：它传给 libimagequant 的"感知质量目标"实测在 60-100 区间躺平，砍掉
 * @param quality 压缩质量 1-100
 * @returns png 编码参数
 */
function pngOptions(quality: number): {
  compressionLevel: number;
  palette?: boolean;
  colours?: number;
  dither?: number;
  adaptiveFiltering?: boolean;
} {
  if (quality > 80) return { compressionLevel: 9, adaptiveFiltering: true }
  const gear = PNG_GEARS.find(g => quality >= g.minQuality)
  // quality 恒 >= 1，find 必命中；这个分支是给类型系统看的
  if (gear === undefined) return { compressionLevel: 9 }
  return { compressionLevel: 9, palette: true, colours: gear.colours, dither: gear.dither }
}

/**
 * 给 Sharp 管道装上编码器（.jpeg 就是编码器）
 * 为什么叫管道：每个环节的输出都会成为下一个环节的输入
 * @param p 管道对象
 * @param format 输出格式
 * @param quality 压缩质量
 * @returns 管道对象
 */
export function applyOutputFormat(p: Sharp, format: OutputFormat, quality: number): Sharp {
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
 * @param claimed 输出路径认领集（compress.ts 预填了本批输入路径）：写盘前认领自己的 output，已被占用则报错失败
 * @returns 压缩后图片信息
 */
export async function compressOne(
  file: string,
  params: CompressParams,
  root: string,
  claimed: Set<string>
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

    // 组装一个 input 到某种格式编码结果的管道，每个候选各调用一次，sharp 的链式调用是在同一个实例上配置编码器，一个实例只能有一个输出格式，不能交叉使用
    const buildPipeline = (c: Candidate): Sharp => {
      let pipeline: Sharp = sharp(input).rotate()

      if (params.maxWidth !== undefined && meta.width !== undefined && meta.width > params.maxWidth) {
        pipeline = pipeline.resize({
          width: params.maxWidth,
          withoutEnlargement: true // 只缩小不放大
        })
      }

      // flatten 只装给 jpeg 候选，webp 支持透明
      // jpeg 不支持透明通道，带 alpha 的图片，例如透明 png 转 jpeg 前先铺白底
      if (c.format === 'jpeg' && meta.hasAlpha) {
        pipeline.flatten({ background: '#ffffff' })
      }

      if (c.lossless) return pipeline.webp({ lossless: true }) // 变体直连编码器
      return applyOutputFormat(pipeline, c.format, params.quality)
    }

    // 基准格式：可输出的用原格式；svg/heif 只能输入，用 FALLBACK 兜底
    const base = baseOutputFormat(inputFormat)
    // smart 的候选集是“格式”不是路径，非 smart 就是长度为 1 的候选集 -- 单格式是特例，两种模式走一套代码
    const candidates: Candidate[] = params.smart
      ? [
          { format: base },
          { format: 'webp' },
          ...(base === 'png' ? [{ format: 'webp' as const, lossless: true }] : []),  // png 专属赛道
        ]
      : [{ format: params.format ?? base }]

    let winner: { format: OutputFormat, data: Buffer } | undefined
    for (const c of candidates) {
      const { data } = await buildPipeline(c).toBuffer({ resolveWithObject: true }) //  resolveWithObject 让 toBuffer() 不只是返回裸 Buffer，而是返回一个对象，里面同时包含图片数据和图片信息, 那么结构还可以拿到另外一个属性 info ，但是这里只用 data 就够了。
      if (winner === undefined || data.byteLength < winner.data.byteLength) {
        winner = { format: c.format, data }
      }
    }
    // candidates 至少有一个值，winner 必然有值，这个 throw 是给系统类型看的
    if (winner === undefined) throw new Error('没有可用的输出候选')
    
    const outputFormat = winner.format
    const keepFormat = outputFormat === inputFormat
    // smart 模式换格式是工具选择而非用户选择：所有候选没有赢过原文件就跳，不看 keepFormat，不是 smart 模式，用户指定换格式，变大也要换
    // （必须算在路径计算之前：跳过状态下"输出"就是输入自己，落点扩展名依赖这个判定）
    const wouldSkip = (params.smart || keepFormat) && winner.data.byteLength >= input.byteLength

    const rel = path.relative(root, file)
    // 在"相对 root 的空间"里表达输出结构：svg -> png 的扩展名替换也在这里完成。
    // 跳过 = 原样字节：落点必须保持原扩展名——按胜者格式命名的 relOut 在拷贝场景下
    // 会让文件名和内容对不上（覆盖模式虽不写盘，报告"输出位置"也该显示没动过的原名）
    const relOut = wouldSkip || keepFormat ? rel : replaceExt(rel, EXT_BY_FORMAT[outputFormat])
    // out 模式嫁接到新根；否则维持原地覆盖的旧语义（覆盖）
    const output = params.outDir !== undefined
      ? path.join(params.outDir, relOut)
      : wouldSkip || keepFormat ? file : replaceExt(file, EXT_BY_FORMAT[outputFormat])

    result.output = output
    result.format = outputFormat

    // 撞车检测不在这里做：这里只算出路径，"这个路径最终归谁"要等编码与跳过判定之后——
    // 覆盖模式的 skipped 直接 return（不写盘、不认领），out 模式的 skipped 原样拷贝落盘（要认领）
    result.afterBytes = winner.data.byteLength

    // out 模式 skipped 实际落盘的是原样拷贝：afterBytes 如实记回原文件大小（节省 0%）、format 回退到输入侧基准。
    // 提前设置是安全的：若后续认领/写盘失败，status 保持 failed，所有消费方都按 failed 分支处理
    if (wouldSkip) {
      result.afterBytes = input.byteLength
      result.format = base
    }
    // 如果用户明确需要更换文件后缀名，那也要正常输出（wouldSkip 只在保持原格式时才可能成立）
    // 跳过压缩的两种结局：覆盖模式 = 不写任何文件（原图保持原样）；
    // out 模式 = 把原始字节原样拷进目录树——目录树完整性优先，宁可复制一份也不留缺口
    if (wouldSkip && params.outDir === undefined) {
      result.status = 'skipped'
      return result
    }
    // 认领输出路径。集合里站着三类占用者：预填的输入路径（覆盖模式下它们会被原地重写）、
    // 本批其他任务已认领的输出、自己（add 幂等，重复认领无害）。
    // 位置讲究：必须在 wouldSkip 之后——覆盖模式的 skipped 已在上面 return（不写盘也就不认领），
    // out 模式的 skipped 以原样拷贝落盘、走到这里认领；不变式：认领 = 真的会占用这个路径；
    // 必须在 dry 分支之前——预览和真实运行要看到同一套撞车结论。
    // check + add 之间没有 await，单线程事件循环里是一步原子操作：并发任务不可能同时通过检测
    if (output !== file && claimed.has(output)) {
      throw new Error(`输出路径冲突：${path.basename(output)} 已被本批其他文件占用`)
    }
    claimed.add(output)

    // 如果是 dry 模式，不需要写盘直接输出即可（状态到终点才定，中途失败不会误标成 skipped/done）
    if (params.dry) {
      result.status = wouldSkip ? 'skipped' : 'done'
      return result
    }

    // 备份文件，保证文件不会丢失，如果后缀名不一样不需要备份（out 模式不覆盖原图，无需备份）
    if (keepFormat && params.outDir === undefined) await backupFile(root, file, params.backupDir)
    if (params.outDir !== undefined) {
      // 覆盖模式下输出目录必然存在（就是源文件所在目录）；
      // out 模式的目标目录树是全新的，recursive 幂等，并发下重复调用无害
      await mkdir(path.dirname(output), { recursive: true })
    }
    const tmp = `${output}${randomUUID()}.tmp`
    try {
      // 写入临时文件；out 模式跳过压缩的文件写原始字节（原样拷贝），其余写编码结果
      await writeFile(tmp, wouldSkip ? input : winner.data)
      // 替换旧文件
      await rename(tmp, output)
    } catch(err) {
      // 删除残留文件
      await unlink(tmp).catch(() => {})
      throw err
    }
    result.status = wouldSkip ? 'skipped' : 'done'
    return result
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    return result
  }
}
