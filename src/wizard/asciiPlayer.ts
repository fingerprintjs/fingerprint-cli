import { color } from '../utils/color.js'
import type { AsciiMotionLikeExport } from './animations/integrate.js'

// Renders one frame of an ASCII Motion–style animation (https://ascii-motion.app JSON/Text export)
// as plain ANSI. Stateless: the caller owns cursor position and timing.

export function frameLines(animation: AsciiMotionLikeExport, index: number): string[] {
  const frames = animation.frames
  return frames[((index % frames.length) + frames.length) % frames.length]?.lines ?? []
}

export function frameDurationMs(animation: AsciiMotionLikeExport, index: number): number {
  const frames = animation.frames
  return frames[((index % frames.length) + frames.length) % frames.length]?.duration ?? 120
}

export function colorizeFrame(lines: string[]): string[] {
  return lines.map((line) => color.brand(line))
}
