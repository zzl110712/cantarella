import sharp, { type Sharp } from 'sharp';
import path from 'path';
import { randomUUID } from 'crypto';
import { readFile, rename, unlink, writeFile } from 'fs/promises';
import { backupFile, replaceExt } from '#lib/utils/fs';
import {
  EXT_BY_FORMAT,
  EXT_TO_INPUT_FORMAT,
  applyOutputFormat,
  baseOutputFormat,
  type FileResult
} from './compressImage.ts';

/**
 * 这里解释一下为什么用 as const 但是不用枚举
 * 1. enum 是运行时语法，会生成真实 JS 对象，擦除型运行器处理不了
 * 2. WATERMARK_POSITIONS 如果用 as const 可以直接支持迭代，但是 enum 不行，enum 是普通对象，不可直接迭代（as const 的作用是锁住字面量类型）；enum 迭代真正的毛病：键（Tl）和值（'tl'）是两套名字，处处要 Object.values 中转
 * 3. 因为 WatermarkPosition 是根据 WATERMARK_POSITIONS 派生的，未来新增一个，如果其他对象没有实装，tsc 直接报错，但是 enum 如果用了 switch 判断，如果没有这个分支也会走默认分支
 */
export const WATERMARK_POSITIONS = ['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'] as const
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number]

export const GRAVITY_BY_POSITION: Record<WatermarkPosition, string> = {
  tl: 'northwest',
  t: 'north',
  tr: 'northeast',
  l: 'west',
  c: 'centre',
  r: 'east',
  bl: 'southwest',
  b: 'south',
  br: 'southeast'
}

export const POSITION_LABEL: Record<WatermarkPosition, string> = {
  tl: '左上',
  t: '上中',
  tr: '右上',
  l: '左中',
  c: '正中',
  r: '右中',
  bl: '左下',
  b: '下中',
  br: '右下'
}

// 水印命令的编码质量。故意不是 compress 的 80
export const WATERMARK_QUALITY = 90

export interface WatermarkOptions {
  markBuffer?: Buffer; // -m 的图片（logo）的字节（action 层读一次，全批共享）
  markName?: string; // 报错与汇总显示用文件名
  text?: string; // -t 文字（与 markBuffer 互斥，action 层面校验）
  position: WatermarkPosition;
  opacity: number; // .1 - 1 不透明度
  scale: number; // 1 - 100 logo 宽 / 文字字号 = 主图宽 * scale%
  tile: boolean; // true = 平铺防盗图
  angle: number; // 平铺时的倾斜角度（度）。0 = 轴对齐（不倾斜）
}

// composite 数组里的那一项：单贴 = { input, gravity }；平铺 = { input, tile: true }
export interface WatermarkOverlay {
  input: Buffer;
  gravity?: string;
  tile?: boolean;
}

// watermarkOne 的参数：一批图共享同一份
export interface WatermarkFileParams {
  watermark: WatermarkOptions; // 规范化好的水印参数（全批一致）
  dry: boolean; // true = 真实合成但不写盘
  backupDir: string; // 备份目录名
}

// 转义用户输入文字
const escapePango = (s: string) => 
  s.replace(/&/g, '&amp;') // 先转 & 防止后面误转已经转义的字符
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/**
 * 算水印目标宽度
 * 上界挡的是「水印本体比主图宽」，平铺 + 方形 + scale > ~66% 仍会越线，由 watermarkOne 兜成 failed
 * 下界 1——极小图 × 小百分比会算出 0，Math.round(0.4) = 0，水印不能是 0 像素
 * @param imgW 图片宽度
 * @param scale 水印占图片宽度百分比
 * @returns 
 */
const clampMarkWidth = (imgW: number, scale: number): number =>
  Math.max(1, Math.min(Math.round((imgW * scale) / 100), Math.round(imgW * 0.9)))

// 渲染文字水印：颜色和不透明度都写进 Pango span，一个函数出成品
async function renderTextMark(text: string, opacity: number, fontPx: number): Promise<Buffer> {
  return sharp({
    text: {
      text: `<span foreground="white" alpha="${Math.round(opacity * 100)}%">${escapePango(text)}</span>`, // span 的两个属性就是全部样式：白色 + 半透明。alpha 单位是百分比字符串
      font: `Microsoft YaHei ${fontPx}`,
      rgba: true, // 不开它，span 里的颜色/透明度全不生效（输出没有 alpha 通道）
    }
  })
    .png() // 文字层必须有 alpha（png），否则叠上去就是一块白底
    .toBuffer()
}

// 渲染图片水印：先缩放到目标宽，再用 dest-in mask 统一乘透明度
async function renderImageMark(mark: Buffer, opacity: number, targetW: number): Promise<Buffer> {
  // 等比缩放到目标宽度，只给 width 高度按照比例自动生成
  const scaled = await sharp(mark).resize({ width: targetW }).png().toBuffer()

  // 获取缩放后的水印宽高
  const meta = await sharp(scaled).metadata()
  const w = meta.width ?? targetW
  const h = meta.height ?? 1

 // 造一张同尺寸的半透明矩形作为 mask
 const mask = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
  +
  `<rect width="100%" height="100%" fill="rgba(255,255,255,${opacity})"/></svg>`
 )

 return sharp(scaled)
  .composite([{ input: mask, blend: 'dest-in' }]) // 合成图片 => dest-in 将水印图片的每一个像素 alpha * mask 每一个像素的 alpha，完成水印图片透明度
  .png()
  .toBuffer()
}

/**
 * 主入口：渲染水印（文字或图片），产出 composite 直接可用的一项
 * @param opts 规范化水印参数（markBuffer / text 二选一，action 层收敛好传入）
 * @param imgW 主图视觉宽度 px（EXIF orientation ≥ 5 时已换算；水印尺寸 = imgW × scale%）
 * @param imgH 主图视觉高度 px 平铺格子超出主图时按高度参与 clamp（fit 缩入）
 */
export async function buildWatermarkOverlay(
  opts: WatermarkOptions,
  imgW: number,
  imgH: number,
): Promise<WatermarkOverlay> {
  // 计算水印占位大小
  const size = clampMarkWidth(imgW, opts.scale)

  const mark = 
    opts.markBuffer !== undefined
      ? await renderImageMark(opts.markBuffer, opts.opacity, size)
      : await renderTextMark(opts.text ?? '', opts.opacity, size)

  if (!opts.tile) {
    return {
      input: mark,
      gravity: GRAVITY_BY_POSITION[opts.position]
    }
  }

  // 平铺 => tile 没有间隙参数——把间隙作为透明 padding 烧进图里
  // sharp 的 tile 只会轴对齐复制（libvips replicate），想斜铺就"转贴纸不转网格"：
  // 先把水印本体转 angle 度，再照老办法平铺
  let cell = mark;
  if (opts.angle !== 0) {
    cell = await sharp(cell)
      .rotate(opts.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer()
  }
  const meta = await sharp(cell).metadata()
  const gap = Math.round(Math.max(meta.width ?? 1, meta.height ?? 1) * 0.5)
  const padded = await sharp(cell)
    .extend({
      top: 0,
      left: 0,
      right: gap,
      bottom: gap,
      background: { r: 0, g: 0, b: 0, alpha: 0 } // 全透明
    })
    .png()
    .toBuffer()
  
  const pm = await sharp(padded).metadata()
  const cw = pm.width ?? 1, ch = pm.height ?? 1;
  // 决定格子（水印 + 周围透明区域）是否还能放大：格子必须同时满足宽和高两个约束，所以听最苛刻那个的——高只允许 0.65，宽就算允许 1.09 也没用
  const fit = Math.min(1, imgW / cw, imgH / ch);
  const finalCell = fit < 1
    ? await sharp(padded)
        .resize({ width: Math.max(1, Math.round(cw * fit)), height: Math.max(1, Math.round(ch * fit)) })
        .png()
        .toBuffer()
    : padded
  return { input: finalCell, tile: true }
}

// 汇总与 dry 明细用。例：文字"内部资料"（平铺）/ 图片 logo.png（右下）
export function describeWatermark(opts: WatermarkOptions): string {
  const kind = 
    opts.markBuffer !== undefined
      ? `图片 ${opts.markName ?? '未命名'}`
      : `文字"${opts.text ?? ''}"`
  const where = opts.tile ? `平铺${opts.angle !== 0 ? ` ${opts.angle}°` : ''}` : POSITION_LABEL[opts.position]

  return `${kind} (${where})`
}

/**
 * 给一张图加水印。永不 reject：出错进 result.error、status = failed，批处理接着跑
 * @param file 图片绝对路径
 * @param params 水印参数
 * @param root 基准目录（备份路径和相对路径展示的基准）
 * @param claimed 输出路径认领集（action 层预填了本批输入路径）写盘前认领，已被占用则失效
 * @returns 增加水印的文件信息
 */
export async function watermarkOne(
  file: string,
  params: WatermarkFileParams,
  root: string,
  claimed: Set<string>
): Promise<FileResult> {
  const result: FileResult = {
    file,
    output: file,
    format: 'jpeg',
    beforeBytes: 0,
    afterBytes: 0,
    status: 'failed'
  }

  // 整个函数不能抛异常（Promise.all 一个炸全炸），try/catch 兜住一切
  try {
    // 不要讲文件路径直接传给 Sharp ，那样在覆盖文件的时候内存仍然会占着文件，用 readFile 读取文件
    const input = await readFile(file)
    result.beforeBytes = input.byteLength

    const ext = path.extname(file).toLowerCase()
    const inputFormat = EXT_TO_INPUT_FORMAT[ext]

    if (inputFormat === undefined) {
      throw new Error(`不支持的图片扩展名：${ext === '' ? '无扩展名' : ext}`)
    }

    const meta = await sharp(input).metadata()
    if (meta.width === undefined || meta.height === undefined) {
      throw new Error('无法确定图片尺寸')
    }

    /**
     * EXIF orientation 5-8 = 旋转 90°/270° 的四种变体：metadata 给的是"存储宽高"，
     * 视觉上横竖是对调的。水印按视觉宽度算尺寸，所以要换
     * 手机竖拍的照片，文件里存的其实是横图 + 一个"请旋转显示"的标记；metadata() 如实报告存储尺寸，orientation ≥ 5 时宽高是反的。水印字号按"视觉宽度"算才不会竖图上贴出横图的比例。（
     */
    const swap = (meta.orientation ?? 1) >= 5
    const imgW = swap ? meta.height : meta.width
    const imgH = swap ? meta.width : meta.height

    // 渲染水印
    const overlay = await buildWatermarkOverlay(params.watermark, imgW, imgH)

    // 输出基准格式 png / jpeg heic => jpeg svg => png
    const base = baseOutputFormat(inputFormat)

    let pipeline: Sharp = sharp(input).rotate()

    // jpeg 不支持透明：输入带 alpha 又要输出 jpeg，先铺白底
    if (base === 'jpeg' && meta.hasAlpha) {
      // flatten 只作用主图，必须在 composite 之前——先贴再铺会把水印的半透明区铺成白色
      pipeline = pipeline.flatten({ background: '#ffffff' })
    }

    pipeline = applyOutputFormat(pipeline.composite([overlay]), base, WATERMARK_QUALITY)
    // resolveWithObject 可以让 toBuffer 返回一个对象而不单单是一个 Buffer
    const { data } = await pipeline.toBuffer({ resolveWithObject: true })

    const keepFormat = base === inputFormat
    const output = keepFormat ? file : replaceExt(file, EXT_BY_FORMAT[base])

    result.output = output
    result.format = base
    result.afterBytes = data.byteLength

    if (output !== file && claimed.has(output)) {
      throw new Error(`输出路径冲突：${path.basename(output)} 已被本批其他文件占用`)
    }
    claimed.add(output)

    if (params.dry) {
      result.status = 'done'
      return result
    }

    if (keepFormat) await backupFile(root, file, params.backupDir)

    const tmp = `${output}${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data)
      await rename(tmp, output)
    } catch (err) {
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