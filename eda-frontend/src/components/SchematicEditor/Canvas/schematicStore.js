/**
 * schematicStore.js — the committed schematic document state.
 *
 * Holds only durable data: placed components, committed wires, probes,
 * selection, view transform and generated node names. High-frequency
 * interaction state (drag previews, active wire) lives in interactionStore.
 *
 * State is replaced immutably on every commit so React.memo'd layers can
 * bail out on identity checks, and undo/redo is plain snapshot stacks.
 *
 * @typedef {Object} SchematicComponent
 * @property {string} id            numeric-string id (mxGraph-compatible)
 * @property {string} name
 * @property {string} symbol        prefix, e.g. 'R', 'V', 'PWR'
 * @property {number} x  top-left (un-rotated)
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} rotation      0 | 90 | 180 | 270
 * @property {string} svgPath       e.g. 'kicad-symbols/symbol_svgs/...'
 * @property {Object} compObject    raw library descriptor from the API
 * @property {Object} properties    simulation properties (NAME, VALUE, ...)
 * @property {Array<{number: string, name: string, type: string, dx: number, dy: number}>} pins
 *
 * @typedef {Object} SchematicWire
 * @property {string} id
 * @property {Array<{x: number, y: number}>} points ordered orthogonal polyline
 *
 * @typedef {Object} SchematicProbe
 * @property {string} id
 * @property {string} label      e.g. 'PR1'
 * @property {string} probeType  'V' | 'I'
 * @property {string} color
 * @property {number} x  top-left of the 60x50 glyph
 * @property {number} y
 */

import { buildSpatialIndex, pinAbsolutePosition, componentBBox, snapPoint } from './geometry'

let idCounter = 2 // 0 and 1 are reserved by the legacy mxGraph root cells

export function nextCellId () {
  return String(++idCounter)
}

/** Keep the id counter ahead of ids loaded from files */
export function bumpIdCounter (numericId) {
  const n = parseInt(numericId, 10)
  if (!isNaN(n) && n > idCounter) idCounter = n
}

const emptyDoc = () => ({
  components: [],
  wires: [],
  probes: [],
  selection: [],
  view: { s: 1, dx: 0, dy: 0 },
  nodeNames: {} // wireId -> generated SPICE node label (display only)
})

let state = emptyDoc()

const listeners = new Set()
const undoStack = []
const redoStack = []
const MAX_HISTORY = 100

// Lazily rebuilt spatial index over the committed doc (pins + wire segments)
let spatialIndexCache = null
let spatialIndexFor = null

function notify () {
  listeners.forEach((l) => l())
}

function docSnapshot () {
  return { components: state.components, wires: state.wires, probes: state.probes }
}

/** Commit a mutation. Records undo history unless opts.undoable === false. */
function commit (patch, opts = {}) {
  if (opts.undoable !== false) {
    undoStack.push(docSnapshot())
    if (undoStack.length > MAX_HISTORY) undoStack.shift()
    redoStack.length = 0
  }
  state = { ...state, ...patch }
  notify()
}

export const schematicStore = {
  getState () {
    return state
  },

  subscribe (fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },

  /** O(1)-query spatial index over committed pins and wire segments */
  getSpatialIndex () {
    const key = state.components === (spatialIndexFor && spatialIndexFor.c) &&
      state.wires === (spatialIndexFor && spatialIndexFor.w)
    if (!spatialIndexCache || !key) {
      spatialIndexCache = buildSpatialIndex(state.components, state.wires)
      spatialIndexFor = { c: state.components, w: state.wires }
    }
    return spatialIndexCache
  },

  // ---------- view ----------

  setView (view) {
    // View changes are not undoable and never touch the doc slices.
    state = { ...state, view }
    notify()
  },

  // ---------- selection ----------

  setSelection (ids) {
    state = { ...state, selection: ids }
    notify()
  },

  selectAll () {
    schematicStore.setSelection([
      ...state.components.map((c) => c.id),
      ...state.wires.map((w) => w.id),
      ...state.probes.map((p) => p.id)
    ])
  },

  // ---------- components ----------

  addComponent (component) {
    const comp = { rotation: 0, properties: {}, pins: [], ...component, id: component.id || nextCellId() }
    commit({ components: [...state.components, comp], selection: [comp.id] })
    return comp.id
  },

  updateComponent (id, patch, opts) {
    commit({
      components: state.components.map((c) => (c.id === id ? { ...c, ...patch } : c))
    }, opts)
  },

  setComponentProperties (id, properties) {
    // Properties dialog sync — silent, matches legacy store.subscribe behaviour
    state = {
      ...state,
      components: state.components.map((c) => (c.id === id ? { ...c, properties } : c))
    }
    notify()
  },

  moveCells (ids, dx, dy, opts) {
    const idSet = new Set(ids)
    commit({
      components: state.components.map((c) =>
        idSet.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c),
      wires: state.wires.map((w) =>
        idSet.has(w.id) ? { ...w, points: w.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) } : w),
      probes: state.probes.map((p) =>
        idSet.has(p.id) ? { ...p, x: p.x + dx, y: p.y + dy } : p)
    }, opts)
  },

  rotateComponent (id, delta) {
    commit({
      components: state.components.map((c) =>
        c.id === id ? { ...c, rotation: (((c.rotation || 0) + delta) % 360 + 360) % 360 } : c)
    })
  },

  // ---------- wires ----------

  addWire (points, opts) {
    const clean = dedupePoints(points)
    if (clean.length < 2) return null
    const wire = { id: nextCellId(), points: clean }
    commit({ wires: [...state.wires, wire] }, opts)
    return wire.id
  },

  // ---------- probes ----------

  addProbe (probe) {
    const label = probe.label || 'PR' + (maxProbeNumber() + 1)
    const p = { probeType: 'V', color: '#00e676', ...probe, label, id: probe.id || nextCellId() }
    commit({ probes: [...state.probes, p], selection: [p.id] })
    return p.id
  },

  // ---------- deletion / clearing ----------

  deleteCells (ids) {
    const idSet = new Set(ids)
    if (idSet.size === 0) return
    commit({
      components: state.components.filter((c) => !idSet.has(c.id)),
      wires: state.wires.filter((w) => !idSet.has(w.id)),
      probes: state.probes.filter((p) => !idSet.has(p.id)),
      selection: [],
      nodeNames: {}
    })
  },

  deleteSelection () {
    schematicStore.deleteCells(state.selection)
  },

  clearAll () {
    commit({ ...emptyDoc(), view: state.view })
  },

  /** Replace the whole document (file open / gallery / template load) */
  loadDocument (doc, opts = {}) {
    commit({
      components: doc.components || [],
      wires: doc.wires || [],
      probes: doc.probes || [],
      selection: [],
      nodeNames: {}
    }, opts)
  },

  setNodeNames (nodeNames) {
    state = { ...state, nodeNames }
    notify()
  },

  // ---------- clipboard ----------

  copySelection () {
    const idSet = new Set(state.selection)
    clipboard = {
      components: state.components.filter((c) => idSet.has(c.id)),
      wires: state.wires.filter((w) => idSet.has(w.id))
    }
    pasteOffset = 20
    return clipboard.components.length + clipboard.wires.length
  },

  paste () {
    if (!clipboard) return
    const off = pasteOffset
    pasteOffset += 20
    const newComps = clipboard.components.map((c) => ({
      ...c,
      id: nextCellId(),
      x: c.x + off,
      y: c.y + off,
      properties: { ...c.properties },
      pins: c.pins.map((p) => ({ ...p }))
    }))
    const newWires = clipboard.wires.map((w) => ({
      id: nextCellId(),
      points: w.points.map((p) => ({ x: p.x + off, y: p.y + off }))
    }))
    commit({
      components: [...state.components, ...newComps],
      wires: [...state.wires, ...newWires],
      selection: [...newComps.map((c) => c.id), ...newWires.map((w) => w.id)]
    })
  },

  // ---------- history ----------

  undo () {
    const prev = undoStack.pop()
    if (!prev) return
    redoStack.push(docSnapshot())
    state = { ...state, ...prev, selection: [], nodeNames: {} }
    notify()
  },

  redo () {
    const next = redoStack.pop()
    if (!next) return
    undoStack.push(docSnapshot())
    state = { ...state, ...next, selection: [], nodeNames: {} }
    notify()
  },

  clearHistory () {
    undoStack.length = 0
    redoStack.length = 0
  },

  // ---------- queries ----------

  getComponent (id) {
    return state.components.find((c) => c.id === id) || null
  },

  /** All pins with absolute positions: [{x, y, componentId, pin, component}] */
  getAllPinPositions () {
    const out = []
    for (const comp of state.components) {
      for (const pin of comp.pins) {
        const p = pinAbsolutePosition(comp, pin)
        out.push({ x: p.x, y: p.y, componentId: comp.id, pin, component: comp })
      }
    }
    return out
  },

  /**
   * Magnetic snap after a drop/move: if a pin of the moved component is within
   * `tolerance` of another component's pin, shift the component so they touch.
   * O(1) via the spatial index.
   */
  magneticSnapDelta (componentId, tolerance = 20) {
    const comp = schematicStore.getComponent(componentId)
    if (!comp) return null
    const index = schematicStore.getSpatialIndex()
    let best = null
    let bestD = tolerance
    for (const pin of comp.pins) {
      const p = pinAbsolutePosition(comp, pin)
      for (const e of index.neighbourhood(p.x, p.y)) {
        if (e.isSegment || e.payload.kind !== 'pin' || e.payload.componentId === componentId) continue
        const d = Math.hypot(e.x - p.x, e.y - p.y)
        if (d < bestD) {
          bestD = d
          best = { dx: e.x - p.x, dy: e.y - p.y }
        }
      }
    }
    return best
  }
}

let clipboard = null
let pasteOffset = 20

function maxProbeNumber () {
  let max = 0
  for (const p of state.probes) {
    const n = parseInt(String(p.label).replace('PR', ''), 10)
    if (!isNaN(n) && n > max) max = n
  }
  return max
}

function dedupePoints (points) {
  const out = []
  for (const p of points) {
    const sp = snapPoint(p)
    const last = out[out.length - 1]
    if (!last || last.x !== sp.x || last.y !== sp.y) out.push(sp)
  }
  // Merge colinear runs (a-b-c on one axis -> a-c)
  for (let i = out.length - 2; i > 0; i--) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) out.splice(i, 1)
  }
  return out
}

export { componentBBox }
