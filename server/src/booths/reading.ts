import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import kuromoji from 'kuromoji'
import type { IpadicFeatures, Tokenizer } from 'kuromoji'

const require = createRequire(import.meta.url)
let tokenizer: Promise<Tokenizer<IpadicFeatures>> | undefined

export async function nameReading(name: string): Promise<string> {
  tokenizer ??= new Promise((resolve, reject) => {
    kuromoji.builder({ dicPath: join(dirname(require.resolve('kuromoji/package.json')), 'dict') })
      .build((error, result) => {
        if (error) reject(error)
        else resolve(result)
      })
  })
  const tokens = (await tokenizer).tokenize(name.normalize('NFKC'))
  if (tokens.some(token => !token.reading && /[\u3400-\u9fff]/u.test(token.surface_form))) {
    console.warn('Automatic circle name reading contains unknown kanji:', name)
  }
  return tokens.map(token => token.reading && token.reading !== '*' ? token.reading : token.surface_form)
    .join('').replace(/[\u30a1-\u30f6]/g, character => String.fromCharCode(character.charCodeAt(0) - 0x60))
    .toLowerCase()
}
