import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { DetectedApp } from './detect.js'
import { packageName } from './skills.js'

export function missingPackages(app: DetectedApp, packages: string[]): string[] {
  const manifest = join(app.dir, 'package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }
  const require = createRequire(manifest)
  return packages.filter((spec) => {
    const name = packageName(spec)
    // Explicit versions still go through the package manager; presence alone cannot satisfy them.
    if (spec !== name || !dependencies[name]) return true
    try {
      require.resolve(name)
      return false
    } catch {
      // A declaration without the installed package (e.g. after a failed install) still needs it.
      return true
    }
  })
}
