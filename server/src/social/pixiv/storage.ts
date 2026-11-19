import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { newestFirst, validPixivId } from './source.js'

export interface StoredPixivImage { id: string; name: string; modifiedAt: Date }
export class PixivStorage {
  constructor(mediaRoot: string, provider: 'pixiv' | 'twitter' = 'pixiv') {
    this.root = join(mediaRoot, provider); this.provider = provider
  }
  private readonly provider: 'pixiv' | 'twitter'
  private readonly root: string

  directory(pixivId: string) {
    if (!validPixivId(pixivId)) throw new Error(`${this.provider} 存储用户 ID 无效`)
    return join(this.root, pixivId)
  }

  async list(pixivId: string): Promise<StoredPixivImage[]> {
    const directory = this.directory(pixivId)
    let info
    try { info = await lstat(directory) } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
      throw error
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${this.provider} 图片路径不是普通目录`)
    const files: StoredPixivImage[] = []
    for (const file of await readdir(directory, { withFileTypes: true })) {
      const match = /^([1-9]\d{0,31})(?:_p0)?\.(png|jpe?g|gif|webp)$/i.exec(file.name)
      if (!match) continue
      if (!file.isFile() || file.isSymbolicLink()) throw new Error(`${this.provider} 图片不是普通文件`)
      files.push({ id: match[1]!, name: file.name, modifiedAt: (await stat(join(directory, file.name))).mtime })
    }
    const order = newestFirst(files.map(file => file.id))
    return files.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id) || a.name.localeCompare(b.name))
  }

  async stage(pixivId: string, imageId: string, body: Buffer, extension: string) {
    if (!validPixivId(imageId) || !/^(png|jpg|gif|webp)$/.test(extension)) throw new Error(`${this.provider} 图片文件名无效`)
    const directory = this.directory(pixivId)
    await mkdir(directory, { recursive: true })
    const name = `${imageId}.${extension}`
    const temporary = join(directory, `${name}.${randomUUID()}.tmp`)
    await writeFile(temporary, body, { flag: 'wx' })
    return {
      commit: () => rename(temporary, join(directory, name)),
      clean: () => unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      }),
    }
  }

  async prune(pixivId: string, keep: string[]) {
    const retained = new Set<string>()
    for (const file of await this.list(pixivId)) {
      if (keep.includes(file.id) && !retained.has(file.id)) retained.add(file.id)
      else await unlink(join(this.directory(pixivId), file.name))
    }
  }
}
