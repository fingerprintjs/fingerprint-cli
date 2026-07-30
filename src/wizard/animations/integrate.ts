// Integrate loading animation — frames authored for the ASCII Motion JSON export shape
// (https://ascii-motion.app → Export → JSON). To replace: design in the app, export JSON
// (disable "Include Empty Cells"), then convert frames to the string[] form below, or drop a
// raw export next to this file and point INTEGRATE_ANIMATION at it.
//
// Theme: a compact "visitor identify" pulse — concentric scan rings around a core, in the
// Fingerprint brand orange when the terminal supports truecolor.

export interface AsciiMotionLikeExport {
  metadata: { projectName: string; source: string }
  canvas: { width: number; height: number }
  /** duration ms per frame; lines are pre-rasterized rows (same as Text export of that frame). */
  frames: { duration: number; lines: string[] }[]
}

export const INTEGRATE_ANIMATION: AsciiMotionLikeExport = {
  metadata: {
    projectName: 'fingerprint-integrate',
    source: 'https://ascii-motion.app',
  },
  canvas: { width: 29, height: 5 },
  frames: [
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '           ( · )                 ',
        '         ·   ◉   ·               ',
        '           ( · )                 ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '         · ( · ) ·               ',
        '       ·     ◉     ·             ',
        '         · ( · ) ·               ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '       ·   ( · )   ·             ',
        '     ·       ◉       ·           ',
        '       ·   ( · )   ·             ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '     ·     ( · )     ·           ',
        '   ·         ◉         ·         ',
        '     ·     ( · )     ·           ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '   ·       ( · )       ·         ',
        ' ·           ◉           ·       ',
        '   ·       ( · )       ·         ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 120,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        ' ·         ( · )         ·       ',
        '·            ◉            ·      ',
        ' ·         ( · )         ·       ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    // hold / fade back in
    {
      duration: 100,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '           (   )                 ',
        '             ◉                   ',
        '           (   )                 ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
    {
      duration: 100,
      lines: [
        '    ┌ · · · · · · · · · · · ┐    ',
        '           ( · )                 ',
        '             ◉                   ',
        '           ( · )                 ',
        '    └ · · · · · · · · · · · ┘    ',
      ],
    },
  ],
}
