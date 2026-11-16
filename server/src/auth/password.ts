import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const cost = { N: 16384, r: 8, p: 1 }

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, cost, (error, key) => error ? reject(error) : resolve(key))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, hash, extra] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !/^[a-f0-9]{32}$/.test(salt)
    || !hash || !/^[a-f0-9]{128}$/.test(hash) || extra !== undefined) {
    throw new Error('Invalid stored password hash')
  }
  return timingSafeEqual(await derive(password, salt), Buffer.from(hash, 'hex'))
}
