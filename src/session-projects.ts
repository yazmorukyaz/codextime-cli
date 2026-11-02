import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import type { SessionProject } from './session-sync.js'
const exec = promisify(execFile)
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const safeName = (value: string) =>
  value
    .trim()
    .slice(0, 80)
    .replace(/[\x00-\x1f\x7f/\\]/g, '_') || 'Local project'

export function remoteProject(raw: string): SessionProject | null {
  try {
    const input = raw.trim()
    const scp = input.match(/^(?:[^/@:]+@)?([A-Za-z0-9.-]+):([^\s]+)$/)
    const url = new URL(scp && !input.includes('://') ? `ssh://${scp[1]}/${scp[2]}` : input)
    if (!['https:', 'ssh:', 'git:'].includes(url.protocol) || !/^[a-z0-9.-]+$/i.test(url.hostname))
      return null
    const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    if (
      !path ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /[\x00-\x20]/.test(path)
    )
      return null
    const host = url.hostname.toLowerCase()
    const port = url.port && !['22', '443', '9418'].includes(url.port) ? `:${url.port}` : ''
    const canonical = `${host}${port}/${host === 'github.com' ? path.toLowerCase() : path}`
    return {
      key: hash('git\0' + canonical),
      name: safeName(decodeURIComponent(path.split('/').at(-1)!)),
      kind: 'git_remote'
    }
  } catch {
    return null
  }
}

export async function projectResolver(configDir: string) {
  const identityDir = resolve(configDir, 'project-identities')
  const cache = new Map<string, Promise<SessionProject | null>>()
  const detect = async (cwd: string): Promise<SessionProject | null> => {
    try {
      let root = await realpath(cwd)
      try {
        const git = await exec('git', ['-C', root, 'rev-parse', '--show-toplevel'], {
          timeout: 5000,
          maxBuffer: 8192
        })
        root = await realpath(git.stdout.trim())
        try {
          const remote = await exec('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
            timeout: 5000,
            maxBuffer: 8192
          })
          const project = remoteProject(remote.stdout)
          if (project) return project
        } catch {
          /* Repositories without an origin keep a local identity. */
        }
        try {
          const common = await exec(
            'git',
            ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
            { timeout: 5000, maxBuffer: 8192 }
          )
          root = await realpath(common.stdout.trim())
        } catch {
          /* Older Git versions can still use the repository root. */
        }
      } catch {
        /* Non-Git directories are installation-local projects. */
      }
      await mkdir(identityDir, { recursive: true, mode: 0o700 })
      const file = resolve(identityDir, hash(root))
      try {
        await writeFile(file, hash('local\0' + randomUUID()), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'))
          throw error
      }
      const key = (await readFile(file, 'utf8')).trim()
      if (!/^[a-f0-9]{64}$/.test(key)) throw Error('Local project identity is not ready')
      return {
        key,
        name: safeName(basename(root === cwd ? cwd : root).replace(/^\.git$/, basename(cwd))),
        kind: 'local'
      }
    } catch {
      return null
    }
  }
  return {
    resolve(cwd: string) {
      if (!cache.has(cwd)) cache.set(cwd, detect(cwd))
      return cache.get(cwd)!
    },
    async save() {
      /* Identities are created atomically per project. */
    }
  }
}
