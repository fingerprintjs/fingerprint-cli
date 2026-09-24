import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export function assertPathWithinProject(root: string, target: string, action: string): void {
  const projectRoot = realpathSync(root)
  let current = resolve(target)
  const missing: string[] = []

  while (true) {
    try {
      lstatSync(current)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`Cannot resolve path: ${target}`)
      missing.unshift(basename(current))
      current = parent
    }
  }

  let resolvedTarget: string
  try {
    resolvedTarget = resolve(realpathSync(current), ...missing)
  } catch {
    throw new Error(`Refusing to ${action} through an unresolved symlink: ${target}`)
  }

  const rel = relative(projectRoot, resolvedTarget)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Refusing to ${action} outside the project: ${target}`)
  }
}
