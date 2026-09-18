import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSkills } from '../dist/wizard/skills.js'
import { makeSkillsDir } from './helpers/harness.js'

test('skill installation cannot follow a project symlink outside the repo', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-skills-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'fp-skills-outside-'))
  const skillsDir = makeSkillsDir()
  const previous = process.env.FINGERPRINT_SKILLS_DIR
  process.env.FINGERPRINT_SKILLS_DIR = skillsDir
  symlinkSync(outside, join(root, '.claude'))

  try {
    assert.throws(() => installSkills(root, ['fingerprint-react']), /install skills outside the project/)
  } finally {
    if (previous === undefined) delete process.env.FINGERPRINT_SKILLS_DIR
    else process.env.FINGERPRINT_SKILLS_DIR = previous
  }
})

test('skill installation cannot overwrite an external file through a child symlink', () => {
  const root = mkdtempSync(join(tmpdir(), 'fp-skills-root-'))
  const outside = mkdtempSync(join(tmpdir(), 'fp-skills-outside-'))
  const victim = join(outside, 'victim.md')
  const destination = join(root, '.claude', 'skills', 'fingerprint-react')
  const skillsDir = makeSkillsDir()
  const previous = process.env.FINGERPRINT_SKILLS_DIR
  process.env.FINGERPRINT_SKILLS_DIR = skillsDir
  writeFileSync(victim, 'do not overwrite\n')
  mkdirSync(destination, { recursive: true })
  symlinkSync(victim, join(destination, 'SKILL.md'))

  try {
    assert.throws(() => installSkills(root, ['fingerprint-react']), /install skills outside the project/)
    assert.equal(readFileSync(victim, 'utf8'), 'do not overwrite\n')
  } finally {
    if (previous === undefined) delete process.env.FINGERPRINT_SKILLS_DIR
    else process.env.FINGERPRINT_SKILLS_DIR = previous
  }
})
