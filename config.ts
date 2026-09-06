export default {
  compress: {
    // 扫描时认作图片的扩展名（统一小写）
    extensions: ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.tiff', '.gif', '.heic', '.heif', '.svg'],
    // 备份目录名（CLI --backup-dir 可覆盖；必须是单纯的目录名，不能带路径）
    backupDir: '.backup',
    // 扫描时要跳过的目录名：备份目录绝不能被再压缩一遍。
    // 注意这里是"固有忽略集"——--backup-dir 换了名字时，collectImages 会把新名字
    // 临时并进来（旧的 .backup 残留也继续忽略），见 fs.ts 的 collectImages
    ignoreDirs: ['.backup'],
    // 并发数：sharp 的编解码跑在 libuv 线程池（默认 4 线程）所以并发数量也控制在 4
    defaultConcurrency: 4
  }
}