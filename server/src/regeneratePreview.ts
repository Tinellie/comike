import { spawn } from 'node:child_process'
import { join } from 'node:path'

export function regeneratePreview(root: string, output: string): Promise<void> {
  const tool = join(root, 'tools', 'booth-recognition')
  const python = process.platform === 'win32'
    ? join(tool, '.venv', 'Scripts', 'python.exe')
    : join(tool, '.venv', 'bin', 'python')
  return new Promise((resolve, reject) => {
    const child = spawn(python, [
      '-u', join(tool, 'test_recognition.py'), join(root, 'ref', 'official-map.pdf'),
      '--pages', 'all', '--output', output,
    ], { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`PDF recognition failed (${signal ?? `exit ${code}`}); see server logs`))
    })
  })
}
