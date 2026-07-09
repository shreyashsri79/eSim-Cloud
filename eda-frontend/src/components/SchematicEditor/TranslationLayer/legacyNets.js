/**
 * legacyNets.js — netlist extraction for legacy KiCad v4/v5 (.sch) imports.
 *
 * The legacy format has no embedded symbol library, so the original pin
 * positions are unknowable from the file alone: wire endpoints sit where the
 * *KiCad* symbol's pins were, while the placed *library* symbol puts its pins
 * somewhere nearby. Copying the wires verbatim therefore always leaves stubs
 * that miss the pins (the classic messy import).
 *
 * Instead, this module reconstructs pure connectivity in canvas space:
 * wire segments + junctions form conductor groups exactly (their coordinates
 * are exact in the file), and each *placed* pin is attached to the nearest
 * conductor by perpendicular projection within a tolerance. The caller then
 * discards the original wires and re-routes each net between the actual pins.
 */

import { DSU, pointOnSegment } from './connectivity'
import { projectOntoSegment } from '../Canvas/geometry'

/** Half a legacy 100 mil grid step is 10 canvas units; pins of the placed
 *  library symbol usually land within ~1–2 grid steps of the original wire. */
const DEFAULT_PIN_TOLERANCE = 50

function key (x, y) {
  return Math.round(x * 100) + ',' + Math.round(y * 100)
}

/**
 * Group placed pins into nets.
 *
 * @param {Object} input
 * @param {Array<{a: Point, b: Point}>} input.segments  wire segments (canvas units)
 * @param {Array<Point>} input.junctions               explicit Connection points
 * @param {Array<{text: string, x, y}>} input.labels   global/local labels
 * @param {Array<{x, y, componentId, pin}>} input.pins placed library pins (absolute)
 * @param {number} [input.pinTolerance]
 * @returns {Array<{name: string|null, points: Array<{x, y, componentId, pin}>}>}
 *          one entry per net with >= 1 attached pin
 */
export function extractLegacyNets ({ segments, junctions = [], labels = [], pins = [], pinTolerance = DEFAULT_PIN_TOLERANCE }) {
  const dsu = new DSU()

  const unionPointToSegments = (p, pk) => {
    for (const s of segments) {
      if (pointOnSegment(p, s.a, s.b)) dsu.union(pk, key(s.a.x, s.a.y))
    }
  }

  // Conductors: exact, straight from the file.
  for (const s of segments) dsu.union(key(s.a.x, s.a.y), key(s.b.x, s.b.y))
  for (const s of segments) {
    unionPointToSegments(s.a, key(s.a.x, s.a.y))
    unionPointToSegments(s.b, key(s.b.x, s.b.y))
  }
  for (const j of junctions) unionPointToSegments(j, key(j.x, j.y))

  const namesByRoot = new Map()
  for (const l of labels) {
    const lk = key(l.x, l.y)
    unionPointToSegments(l, lk)
    const root = dsu.find(lk)
    if (!namesByRoot.has(root)) namesByRoot.set(root, l.text)
  }

  // Pins: fuzzy — attach to the nearest conductor within tolerance.
  const groups = new Map()
  for (const pin of pins) {
    let best = null
    for (const s of segments) {
      const pr = projectOntoSegment(pin, s.a, s.b)
      if (pr.d <= pinTolerance && (!best || pr.d < best.d)) {
        best = { d: pr.d, root: dsu.find(key(s.a.x, s.a.y)) }
      }
    }
    if (!best) continue
    let g = groups.get(best.root)
    if (!g) {
      g = { name: namesByRoot.get(best.root) || null, points: [] }
      groups.set(best.root, g)
    }
    g.points.push(pin)
  }
  return [...groups.values()]
}
