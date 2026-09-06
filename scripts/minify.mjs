// 对 tsc 产出的 dist/ 内所有 JS 做压缩（缩短标识符、去除空白），原地覆盖
// 用 esbuild 的 transform API 逐文件纯语法压缩：不做模块解析，
// import 说明符（#config、#lib/*、#pkg、裸包名）原样保留，由 Node 运行时解析
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { transform } from 'esbuild'

// tsc 的 resolveJsonModule 会把源码导入的 package.json 复制到 dist/。
// 这个"幽灵 package.json"会截住 Node 向上的包查找，令 imports 映射的
// 解析基准错位（#lib/* 解析成 dist/dist/...），必须删掉
rmSync('dist/package.json', { force: true })

const files = readdirSync('dist', { recursive: true })
  .filter((f) => f.endsWith('.js'))
  .map((f) => `dist/${f}`)

if (files.length === 0) {
  console.error('dist/ 里没有 JS 文件，请先运行 tsc 编译')
  process.exit(1)
}

for (const file of files) {
  const { code } = await transform(readFileSync(file, 'utf8'), {
    loader: 'js',
    minify: true,
    target: 'es2023'
  })
  writeFileSync(file, code)
}

console.log(`已压缩 ${files.length} 个文件`)
