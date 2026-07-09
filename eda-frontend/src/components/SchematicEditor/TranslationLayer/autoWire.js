/**
 * autoWire.js — draws the wires for imported nets using the editor's own
 * routing, instead of copying KiCad wire geometry.
 *
 * Input is the topological netlist ({reference, pin} groups) plus the
 * components already placed on the canvas. For every net the pins are
 * chained with a greedy minimum-spanning-tree (Prim on Manhattan distance)
 * and each tree edge is routed with the same obstacle-aware Manhattan
 * router the interactive wire tool uses, so imported wires look exactly
 * like hand-drawn ones and connect by coordinate coincidence.
 */

import { pinAbsolutePosition, componentBBox, routeManhattan } from '../Canvas/geometry'
import { schematicStore } from '../Canvas/schematicStore'

/**
 * Canvas endpoint for one net pin: the placed component + its matching pin.
 * Pins are matched by number; when the library symbol numbers its pins
 * differently from KiCad, falls back to sorted index order.
 */
function resolveNetPin (netPin, placedByUuid) {
  const comp = placedByUuid.get(netPin.instanceUuid)
  if (!comp || !comp.pins || comp.pins.length === 0) return null
  let pin = comp.pins.find((p) => String(p.number) === String(netPin.pin))
  if (!pin) {
    const sorted = [...comp.pins].sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }))
    const idx = parseInt(netPin.pin, 10) - 1
    pin = sorted[idx] || null
  }
  if (!pin) return null
  const p = pinAbsolutePosition(comp, pin)
  return { x: p.x, y: p.y }
}

function manhattan (a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

/** Prim's MST over the net's pin positions; returns index pairs [i, j] */
export function mstEdges (points) {
  const edges = []
  if (points.length < 2) return edges
  const inTree = new Array(points.length).fill(false)
  inTree[0] = true
  for (let step = 1; step < points.length; step++) {
    let best = null
    for (let i = 0; i < points.length; i++) {
      if (!inTree[i]) continue
      for (let j = 0; j < points.length; j++) {
        if (inTree[j]) continue
        const d = manhattan(points[i], points[j])
        if (!best || d < best.d) best = { d, i, j }
      }
    }
    inTree[best.j] = true
    edges.push([best.i, best.j])
  }
  return edges
}

/**
 * Wire up the imported nets. Components must already be committed to the
 * schematic store so the router can see their bounding boxes as obstacles.
 *
 * @param {Array} nets      output of extractNets
 * @param {Map} placedByUuid KiCad instance uuid → placed SchematicComponent
 * @returns {{wired: number, openNets: number}}
 */
export function autoWireNets (nets, placedByUuid) {
  const obstacles = schematicStore.getState().components.map(componentBBox)
  let wired = 0
  let openNets = 0

  for (const net of nets) {
    const points = []
    for (const netPin of net.pins) {
      const p = resolveNetPin(netPin, placedByUuid)
      if (p) points.push(p)
    }
    if (points.length < 2) {
      if (net.pins.length >= 2) openNets++ // pins existed but components were not resolved
      continue
    }

    for (const [i, j] of mstEdges(points)) {
      const from = points[i]
      const to = points[j]
      const dir = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y) ? 'HV' : 'VH'
      const corners = routeManhattan(from, to, dir, obstacles)
      const id = schematicStore.addWire([from, ...corners, to], { undoable: false })
      if (id) wired++
    }
  }
  return { wired, openNets }
}
