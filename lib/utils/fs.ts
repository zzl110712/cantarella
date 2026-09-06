import { readdir, copyFile, mkdir, stat, writeFile } from "fs/promises";
import { constants } from 'fs' // 文件系统常量集合 => 用于给各种文件操作 API 传递标志位
import path from 'path'
import config from '#config'

/**
 * 把字节数格式化成人类可读的大小
 * @param bytes - 文件的字节大小
 * @returns 可读字符串，1024 进制保留两位小数，如 '1.18 MB'
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(2)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb.toFixed(2)} MB`
  return `${(mb / 1024).toFixed(2)} GB`
}

/**
 * 节省百分比
 * @param before 压缩之前大小
 * @param after 压缩之后大小
 * @returns 压缩比例
 */
export function formatPercent(before: number, after: number): string {
  if (before <= 0) return '-'
  return `${((1 - after / before) * 100).toFixed(1)}%`
}

/**
 * 解析基准目录 备份位置、报告位置、相对路径展示全部要根据 root 为基准
 * @param target 当前目标路径
 * @returns { root: 基准目录路径, isFile: 是否是文件 }
 */
export async function resolveRoot(target: string): Promise<{ root: string, isFile: boolean }> {
  const s = await stat(target)
  return s.isFile()
    ? { root: path.dirname(target), isFile: true }
    : { root: target, isFile: false }
}

/**
 * 收集 root 下所有支持的图片文件
 * @param root 根目录
 * @param recursive 是否递归目录下所有文件
 * @param backupDir 本次实际使用的备份目录名（--backup-dir 覆盖后的值）；
 *                  扫描时把它并入忽略集——自定义备份目录里的原图绝不能被再压一遍，
 *                  config.ignoreDirs 里的默认 .backup 残留也继续忽略
 * @returns
 */
export async function collectImages(root: string, recursive: boolean, backupDir: string = config.compress.backupDir): Promise<string[]> {
  /**
   * withFileTypes 必须是字面量类型（true）不能是抽象类型（boolean）
   * withFileTypes的作用 => 返回 Dirent 对象数组，每项自带类型信息和判断方法
   */
  const dirents = await readdir(root, { withFileTypes: true, recursive })
  const ignoreDirs = backupDir && !config.compress.ignoreDirs.includes(backupDir)
    ? [...config.compress.ignoreDirs, backupDir]
    : config.compress.ignoreDirs
  const files: string[] = []
  for (const d of dirents) {
    if (!d.isFile()) continue

    const full = path.join(d.parentPath, d.name)
    const ext = path.extname(d.name).toLowerCase() // extname => 获取后缀名
    // 如果 sharp 不能处理的文件类型 => 直接跳过
    if (!config.compress.extensions.includes(ext)) continue

    if (recursive) {
      // 计算 full 路径相对于 root 的相对路径，再用系统路径分隔符拆分路径为数组
      const segments = path.relative(root, full).split(path.sep)
      // 跳过 ignoreDirs 下的所有文件
      if (segments.some(seg => ignoreDirs.includes(seg))) continue
    }
    files.push(full)
  }
  return files.sort()
}

/**
 * 备份路径规则：root/<备份目录>/<文件相对 root 的路径>
 * @param root 根目录
 * @param file 目标文件目录
 * @param backupDir 备份目录名（默认取 config，CLI --backup-dir 覆盖后传入）
 * @returns 备份文件路径
 */
export function backupPathFor(root: string, file: string, backupDir: string = config.compress.backupDir): string {
  return path.join(root, backupDir, path.relative(root, file))
}

/**
 * 备份单个文件，返回是否真的执行了复制
 * @param root 根目录
 * @param file 需要复制的文件
 * @param backupDir 备份目录名（默认取 config，CLI --backup-dir 覆盖后传入）
 * @returns 是否真的复制了目标文件
 */
export async function backupFile(root: string, file: string, backupDir: string = config.compress.backupDir): Promise<boolean> {
  const dest = backupPathFor(root, file, backupDir)
  await mkdir(path.dirname(dest), { recursive: true })

  try {
    await copyFile(file, dest, constants.COPYFILE_EXCL)
    return true
  } catch (err) {
    // Error EXISTs，文件/目录已存在
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * 备份目录的"身份标记"文件名：目录里存在它，即代表这个目录是 cantarella 创建并托管的。
 * 备份文件本身永远保持原名原目录结构（可直接拷回去回退），标记只是目录里多出的一个说明文件
 */
const BACKUP_SENTINEL = '.cantarella-backup'

/**
 * 备份目录的四种状态（预检用，只读不写）
 * absent  目录还不存在——直接创建使用
 * empty   目录存在但是空的——无风险，视同 absent 直接收编
 * ours    目录存在且有 cantarella 标记——我们自己的，续用即可（二次运行不打扰用户）
 * foreign 目录存在、无标记、非空——可能是用户自己的目录，由调用方决定如何处理
 * @param root 根目录
 * @param backupDir 备份目录名
 */
export async function backupDirState(
  root: string,
  backupDir: string,
): Promise<'absent' | 'empty' | 'ours' | 'foreign'> {
  const dir = path.join(root, backupDir)
  try {
    // stat 判断当前文件状态
    await stat(path.join(dir, BACKUP_SENTINEL))
    return 'ours'
  } catch {
    // 标记不存在：目录可能不存在，也可能是用户的目录，继续分辨
  }
  let s
  try {
    s = await stat(dir)
  } catch {
    return 'absent'
  }
  if (s.isDirectory() && (await readdir(dir)).length === 0) return 'empty'
  return 'foreign'
}

/**
 * 把目录标记为 cantarella 托管的备份目录（幂等；并发下同时调用也只有一个能写入）
 * dry 模式不要调用——预览模式承诺零写入
 * @param root 根目录
 * @param backupDir 备份目录名
 */
export async function markBackupDir(root: string, backupDir: string): Promise<void> {
  const dir = path.join(root, backupDir)
  await mkdir(dir, { recursive: true })
  try {
    // wx = 存在即失败：和备份的 COPYFILE_EXCL 同一思路，宁可失败也不覆盖
    await writeFile(
      path.join(dir, BACKUP_SENTINEL),
      'cantarella 备份目录标记：本目录由 cantarella 创建并管理，请勿手动混入其他文件。\n',
      { flag: 'wx' },
    )
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') return
    throw err
  }
}

/**
 * 换扩展名：格式转换时生成输出文件名 a.jpg -> a.webp
 * @param file 源文件
 * @param newExt 新后缀名
 * @returns 返回替换文件名的后缀路径
 */
export function replaceExt(file: string, newExt: string): string {
  const base = path.basename(file, path.extname(file))
  return path.join(path.dirname(file), base + newExt)
}
