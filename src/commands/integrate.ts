import { confirm } from '@inquirer/prompts'
import { resolve } from 'node:path'
import { analyzeRepo, formatAnalysis } from '../wizard/detect.js'
import { runAgent } from '../wizard/runner.js'
import { saveState } from '../wizard/session.js'
import { skillsForMatch } from '../wizard/skills.js'

export async function integrateCommand(opts: { path?: string; analyze?: boolean } = {}) {
  const root = resolve(opts.path ?? process.cwd())

  const analysis = analyzeRepo(root)
  console.log(formatAnalysis(analysis))
  saveState(root, { phase: 'analyzed', completedSteps: ['analyze'], skillsApplied: [] })

  if (!analysis.skillId) {
    console.log('\nNothing to apply yet for this stack.')
    return
  }
  if (opts.analyze) return

  const proceed = await confirm({
    message: `Apply the Fingerprint integration to ${root}? (edits files)`,
    default: true,
  })
  if (!proceed) return

  const ok = await runAgent(analysis)
  if (ok) {
    saveState(root, {
      phase: 'applied',
      completedSteps: ['analyze', 'apply'],
      skillsApplied: skillsForMatch(analysis.skillId),
    })
  }
}
