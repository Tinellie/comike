import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { catalogOrigin, isLoginPage, LoginRequiredError } from './parser.js'
import type { RemoteLogin } from './login.js'

export async function listStoredBoothImages(mediaRoot: string): Promise<string[]> {
  const root = join(mediaRoot, 'booths')
  let directory
  try { directory = await lstat(root) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('拒绝清空：booths 图片目录不是普通目录')
  }
  const files: string[] = []
  for (const edition of await readdir(root, { withFileTypes: true })) {
    if (!edition.isDirectory() || edition.isSymbolicLink() || !/^c\d+$/.test(edition.name)) {
      throw new Error('拒绝清空：booths 目录包含未知条目或符号链接')
    }
    const editionPath = join(root, edition.name)
    for (const file of await readdir(editionPath, { withFileTypes: true })) {
      if (!file.isFile() || file.isSymbolicLink()
        || !/^\d+_[1-9]\d*\.(?:png|jpe?g|gif|webp)(?:\.[a-f0-9-]+\.tmp)?$/i.test(file.name)) {
        throw new Error('拒绝清空：图片目录包含未知文件或符号链接')
      }
      files.push(join(editionPath, file.name))
    }
  }
  return files
}

export function imageExtension(body: Buffer): string {
  if (body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png'
  if (body[0] === 255 && body[1] === 216 && body[2] === 255) return 'jpg'
  if (/^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))) return 'gif'
  if (body.subarray(0, 4).toString() === 'RIFF' && body.subarray(8, 12).toString() === 'WEBP') return 'webp'
  throw new Error('图片内容不是支持的 PNG/JPEG/GIF/WebP，可能返回了登录页')
}

export async function saveImage(
  image: { url: string; stem: string },
  comiket: number,
  mediaRoot: string,
  login: Pick<RemoteLogin, 'cookieHeader'>,
  signal: AbortSignal,
) {
  if (!/^\d+_[1-9]\d*$/.test(image.stem) || !Number.isSafeInteger(comiket) || comiket < 1) {
    throw new Error('Invalid image storage key')
  }
  let url = new URL(image.url)
  if (url.origin !== catalogOrigin || !/^\/Spa\/CachedImage\/\d+\/2\//.test(url.pathname)) {
    throw new Error('Image URL is outside the catalog image endpoint')
  }
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  let response: Response | undefined
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetch(url, {
      redirect: 'manual',
      headers: {
        ...(url.origin === catalogOrigin ? { Cookie: await login.cookieHeader(url.href) } : {}),
        Referer: `${catalogOrigin}/Spa`,
      },
      signal: timeout,
    })
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel()
      throw new LoginRequiredError()
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location) throw new Error('图片重定向缺少 Location')
    const next = new URL(location, url)
    if (isLoginPage(next.href, '')) throw new LoginRequiredError()
    const azureImage = /^[a-z0-9-]+\.blob\.core\.windows\.net$/i.test(next.hostname)
    if (next.protocol !== 'https:' || next.username || next.password
      || (next.origin !== catalogOrigin && !azureImage)) {
      throw new Error(`图片重定向目标不受支持：${next.hostname}`)
    }
    if (redirects === 5) throw new Error('图片重定向次数超过限制')
    url = next
  }
  if (!response) throw new Error('图片请求没有收到响应')
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`图片下载失败：HTTP ${response.status}`)
  }
  const limit = 20 * 1024 * 1024
  const chunks: Buffer[] = []
  let bytes = 0
  if (!response.body) throw new Error('图片响应体为空')
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > limit) throw new Error('图片超过 20 MiB 限制')
    chunks.push(Buffer.from(chunk))
  }
  const body = Buffer.concat(chunks)
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('image/') && !contentType.startsWith('application/octet-stream')) {
    if (isLoginPage(url.href, body.toString('utf8')) || body.toString('utf8').includes('ログイン')) throw new LoginRequiredError()
    throw new Error('图片接口返回了非图片内容')
  }
  const name = `${image.stem}.${imageExtension(body)}`
  const directory = join(mediaRoot, 'booths', `c${comiket}`)
  await mkdir(directory, { recursive: true })
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, body, { flag: 'wx' })
    await rename(temporary, join(directory, name))
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
  return name
}
