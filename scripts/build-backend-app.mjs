import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const backendDir = path.join(root, 'backend')
const python = path.join(backendDir, 'venv', 'bin', 'python')
const outDir = path.join(root, 'build', 'backend-app')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    stdio: 'inherit',
    env: { ...process.env, PYTHONUNBUFFERED: '1', ...(options.env || {}) },
  })
  if (result.status !== 0) {
    process.exit(result.status || 1)
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

run(python, ['-m', 'pip', 'install', 'pyinstaller==6.11.1'])
run(python, [
  '-m', 'PyInstaller',
  '--clean',
  '--noconfirm',
  '--name', 'earmaster-backend',
  '--distpath', outDir,
  '--workpath', path.join(root, 'build', 'pyinstaller-work'),
  '--specpath', path.join(root, 'build', 'pyinstaller-spec'),
  '--hidden-import', 'music21',
  '--hidden-import', 'uvicorn',
  '--hidden-import', 'fastapi',
  path.join(backendDir, 'main.py'),
], { cwd: backendDir })

copyFileSync(path.join(backendDir, 'requirements.txt'), path.join(outDir, 'earmaster-backend', 'requirements.txt'))
