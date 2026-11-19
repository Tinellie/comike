import { Router } from 'express'
import { validPixivId } from './pixiv/source.js'

export function previewImages(
  load: (boothId: string, imageId: string, signal: AbortSignal) => Promise<{ body: Buffer; extension: string } | null>,
) {
  const router = Router()
  router.get('/preview/:boothId/:imageId', async (req, res) => {
    if (!/^\d{1,32}$/.test(req.params.boothId) || !validPixivId(req.params.imageId)) {
      console.warn('Rejected invalid preview image path')
      res.status(400).json({ message: '图片路径无效' }); return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    res.once('close', cancel)
    try {
      const image = await load(req.params.boothId, req.params.imageId, controller.signal)
      if (res.destroyed) return
      if (!image) { res.status(404).json({ message: '图片已不在当前社团列表中，请重新打开详情' }); return }
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }).vary('Cookie')
      res.type(image.extension).send(image.body)
    } finally { res.off('close', cancel) }
  })
  return router
}
