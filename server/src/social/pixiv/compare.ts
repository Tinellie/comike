import { readFile } from 'node:fs/promises'
import { PixivAppSource, pixivAppOptions } from './appSource.js'
import { PIXIV_IMAGE_LIMIT, newestFirst, validPixivId } from './source.js'

async function main() {
  const [pixivId, file, ...extra] = process.argv.slice(2)
  if (!pixivId || !validPixivId(pixivId) || !file || extra.length) {
    throw new Error('用法：npm run pixiv:compare -w server -- <Pixiv用户ID> <网页最新作品ID的JSON文件>')
  }
  const expected: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (!Array.isArray(expected) || expected.length > PIXIV_IMAGE_LIMIT
    || !expected.every((value): value is string => typeof value === 'string' && validPixivId(value))
    || new Set(expected).size !== expected.length) {
    throw new Error('网页参考数据必须是最多 10 个不重复的作品 ID 字符串数组，请合并插画及漫画并选取最新作品')
  }
  const source = new PixivAppSource(pixivAppOptions())
  try {
    const actual = await source.latest(pixivId, AbortSignal.timeout(120_000))
    const website = newestFirst(expected)
    const missingFromApp = website.filter(id => !actual.includes(id))
    const extraInApp = actual.filter(id => !website.includes(id))
    console.info(JSON.stringify({
      pixivId, checkedAt: new Date().toISOString(),
      matches: !missingFromApp.length && !extraInApp.length,
      website, app: actual, missingFromApp, extraInApp,
    }, null, 2))
    if (missingFromApp.length || extraInApp.length) process.exitCode = 1
  } finally { await source.close() }
}

void main().catch((error: unknown) => {
  console.error('Pixiv 可见性对照失败：', error instanceof Error ? error.message : '未知错误')
  process.exitCode = 1
})
