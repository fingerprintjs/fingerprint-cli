import { query } from '@anthropic-ai/claude-agent-sdk'
import { RepoAnalysis } from './detect.js'
import { resolveLlmConfig } from './llm.js'
import { log } from './log.js'
import { installSkills, skillMeta, SkillMeta, skillsForMatch } from './skills.js'

// Tools the agent may use. No Bash for now: the agent edits code; the CLI reports the
// package installs to run (auto-install via Bash + sandbox is a follow-up).
const ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep']

export async function runAgent(analysis: RepoAnalysis): Promise<boolean> {
  if (!analysis.skillId) throw new Error('No matching skill to apply.')

  const llm = resolveLlmConfig()
  const ids = skillsForMatch(analysis.skillId)

  // Install skills into the repo's .claude/skills/ so the agent reads them on demand,
  // rather than us stuffing their full text into the prompt every turn.
  installSkills(analysis.root, ids)
  const metas = ids.map(skillMeta)

  log.step(`Applying ${ids.join(' + ')} in ${analysis.root}`)

  const response = query({
    prompt: buildTaskPrompt(analysis, ids),
    options: {
      model: llm.model,
      env: llm.env,
      cwd: analysis.root,
      permissionMode: 'acceptEdits',
      systemPrompt: SYSTEM_PROMPT,
      settingSources: ['project'], // discover .claude/skills/
      skills: 'all',
      allowedTools: ALLOWED_TOOLS,
    },
  })

  let ok = false
  for await (const msg of response as AsyncIterable<any>) {
    const status = handleMessage(msg)
    if (status !== undefined) ok = status
  }

  if (ok) reportInstalls(metas)
  return ok
}

const SYSTEM_PROMPT = [
  'You are the Fingerprint integration wizard. You add Fingerprint device intelligence to a',
  "developer's app for fraud prevention.",
  '',
  'The integration skills are installed under .claude/skills/. For each skill named in the task,',
  'read .claude/skills/<id>/SKILL.md (and its snippets/) and follow it exactly.',
  '',
  'Rules:',
  '- Make minimal, focused changes; match the existing code style.',
  '- The secret key is server-side only; never reference it in frontend code.',
  '- Do NOT read or print .env. Reference keys by env-var name only.',
  '- Do not run install commands; the CLI handles package installs after you finish.',
  '- When done, briefly summarize the files you changed.',
].join('\n')

function buildTaskPrompt(analysis: RepoAnalysis, ids: string[]): string {
  const fe = analysis.frontend ? `frontend (${analysis.frontend.framework}) at ./${analysis.frontend.rel}` : null
  const be = analysis.backend ? `backend (${analysis.backend.framework}) at ./${analysis.backend.rel}` : null
  return [
    'Integrate Fingerprint into this repository.',
    `Detected: ${[fe, be].filter(Boolean).join(' and ')}.`,
    'Apply the frontend identification skill to the frontend app and the backend verification',
    'skill to the backend app. The .env already defines FINGERPRINT_PUBLIC_API_KEY and',
    'FINGERPRINT_SECRET_API_KEY. Protect the login flow as the first sensitive action.',
    `Skills to apply (read each from .claude/skills/<id>/SKILL.md): ${ids.join(', ')}.`,
  ].join('\n')
}

// Returns true/false on a final result message, undefined otherwise.
function handleMessage(msg: any): boolean | undefined {
  if (msg.type === 'assistant') {
    for (const block of msg.message?.content ?? []) {
      if (block.type === 'text' && block.text?.trim()) log.info(block.text.trim())
      else if (block.type === 'tool_use') log.tool(block.name, summarizeToolInput(block.name, block.input))
    }
    return undefined
  }
  if (msg.type === 'result') {
    // A result can carry subtype:'success' yet is_error:true (e.g. an API 429) — check both.
    if (msg.is_error || (msg.subtype && msg.subtype !== 'success')) {
      log.error(`Agent did not complete: ${msg.result ?? msg.subtype ?? 'unknown error'}`)
      return false
    }
    log.success('Agent finished applying the integration.')
    return true
  }
  return undefined
}

function summarizeToolInput(_name: string, input: any): string {
  if (!input) return ''
  if (input.file_path) return String(input.file_path)
  if (input.path) return String(input.path)
  if (input.pattern) return String(input.pattern)
  return ''
}

function reportInstalls(skills: SkillMeta[]): void {
  const pkgs = [...new Set(skills.flatMap((s) => s.packages))]
  if (pkgs.length === 0) return
  log.step('Install the Fingerprint packages in the relevant app(s):')
  log.info(`npm install ${pkgs.join(' ')}`)
}
