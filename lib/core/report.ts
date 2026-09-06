import { writeFile } from "fs/promises";
import path from "path";
import type { CompressParams, FileResult } from "./compressImage.ts";
import { formatBytes, formatPercent } from "#lib/utils/fs";

// 以此运行的完整上下文 => 将会写入文件头部
export interface RunInfo {
  target: string; // 用户输入的原始路径
  root: string; // 基准目录
  recursive: boolean; // 是否递归
  concurrency: number; // 并发数（批处理层信息，与 recursive 平级——不是传给每个文件的参数）
  params: CompressParams; // 压缩参数
  startedAt: Date; // 开始时间
}

// 本地时间戳，保证运行得到的报告不会覆盖旧报告
function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 编辑文件内容，和写入文件分离
 * @param info 运行上下文
 * @param results 文件输出结果
 * @returns 文件真实内容
 */
export function buildReport(info: RunInfo, results: FileResult[]): string {
  const done = results.filter(r => r.status === "done")
  const skipped = results.filter(r => r.status === "skipped")
  const failed = results.filter(r => r.status === "failed")

  const beforeTotal = results.reduce((sum, r) => sum + r.beforeBytes, 0)
  // 失败的文件没有产出，大小需要按照原文件大小计算
  const afterTotal = results.reduce((sum, r) => {
    return sum + (r.status === 'failed' ? r.beforeBytes : r.afterBytes)
  }, 0)

  const lines: string[] = []
  lines.push("# 图片压缩报告", "")
  lines.push(
    `- 运行时间：${info.startedAt.toLocaleString("zh-CN", { hour12: false })}`,
  );
  lines.push(`- 目标：${info.target}${info.recursive ? "（递归）" : ""}`)
  lines.push(
    `- 参数：quality=${info.params.quality}` +
      ` format=${info.params.format ?? "保持原格式"}` +
      ` maxWidth=${info.params.maxWidth ?? "不缩放"}` +
      ` 并发=${info.concurrency}` +
      `${info.params.dry ? "（dry 预览，未写入）" : ""}`,
    "",
  )

  lines.push("## 汇总", "")
  lines.push("| 指标 | 值 |", "|---|---|")
  lines.push(`| 处理文件数 | ${results.length} |`)
  lines.push(
    `| 成功 / 跳过 / 失败 | ${done.length} / ${skipped.length} / ${failed.length} |`,
  )
  lines.push(`| 压缩前总大小 | ${formatBytes(beforeTotal)} |`)
  lines.push(`| 压缩后总大小 | ${formatBytes(afterTotal)} |`)
  lines.push(
    `| 节省 | ${formatBytes(beforeTotal - afterTotal)}（${formatPercent(beforeTotal, afterTotal)}） |`,
    "",
  )

  lines.push("## 明细", "")
  lines.push("| 文件 | 输出格式 | 原大小 | 压缩后 | 节省 | 状态 |")
  lines.push("|---|---|---|---|---|---|")

  for (const r of results) {
    const rel = path.relative(info.root, r.file)
    const after = r.status === 'failed' ? '-' : formatBytes(r.afterBytes)
    const saved = r.status === 'failed' ? '-' : formatPercent(r.beforeBytes, r.afterBytes)
    const status = r.status === 'failed' ? `failed: ${r.error ?? '未知错误'}` : r.status
    lines.push(`| ${rel} | ${r.format} | ${formatBytes(r.beforeBytes)} | ${after} | ${saved} | ${status} |`,)
  }
  lines.push("")

  return lines.join("\n")
}

export async function writeReport(root: string, content: string): Promise<string> {
  const file = path.join(root, `compress-report-${timestamp(new Date())}.md`)
  await writeFile(file, content, "utf-8")
  return file
}
