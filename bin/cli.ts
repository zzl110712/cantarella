#! /usr/bin/env node
// 命令行入口：只负责把 commander 的 program 装配起来并解析 argv
import { createRequire } from 'node:module'
import { program } from 'commander'
import { myCompress } from '#lib/core/command'

// 版本号从包自身的 package.json 读取（#pkg 在源码/发布两种形态下都映射到包根，避免发版改两处）。
// 用 createRequire 的 require 加载 json：无需 import attributes，也不触发 tsc 复制 json 到 dist
const { version } = createRequire(import.meta.url)('#pkg') as { version: string }

program.name('cantarella') // help 里显示的命令名（不设的话按入口文件名显示成 cli）
program.version(version)
myCompress(program)
program.parse(process.argv)
