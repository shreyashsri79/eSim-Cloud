/**
 * geometry.js — pure math for the React SVG schematic canvas.
 *
 * Coordinate spaces:
 *  - Screen space  (clientX/clientY relative to the svg element)
 *  - Canvas space  (schematic coordinates; components/wires live here)
 *  - Grid space    (canvas coordinates quantised to GRID_SIZE)
 *
 * screen -> canvas:  x = (cx - dx) / s ,  y = (cy - dy) / s
 * canvas -> screen:  cx = x * s + dx  ,  cy = y * s + dy
 */

export const GRID_SIZE = 20

/** @typedef {{x: number, y: number}} Point */
/** @typedef {{s: number, dx: number, dy: number}} ViewTransform */

/** Snap a scalar to the grid: round(v / G) * G */
export function snap (v, grid = GRID_SIZE) {
  return Math.round(v / grid) * grid
}

/** Snap a point to the grid */
export function snapPoint (p, grid = GRID_SIZE) {
  return { x: snap(p.x, grid), y: snap(p.y, grid) }
}

/** Convert a screen-space point (relative to the svg) to canvas space */
export function screenToCanvas (cx, cy, view) {
  return {
    x: (cx - view.dx) / view.s,
    y: (cy - view.dy) / view.s
  }
}

/** Convert a canvas-space point to screen space */
export function canvasToScreen (x, y, view) {
  return {
    x: x * view.s + view.dx,
    y: y * view.s + view.dy
  }
}

/**
 * Pointer-centred zoom. Returns the new view transform such that the canvas
 * point under the cursor stays put:
 *   dx' = cx - (cx - dx) * (s' / s)
 */
export function zoomAtPoint (view, cx, cy, factor, minScale = 0.1, maxScale = 10) {
  const sNew = Math.min(maxScale, Math.max(minScale, view.s * factor))
  if (sNew === view.s) return view
  const k = sNew / view.s
  return {
    s: sNew,
    dx: cx - (cx - view.dx) * k,
    dy: cy - (cy - view.dy) * k
  }
}

/** Rotate a point by `rot` degrees (multiples of 90) around origin */
export function rotate90 (x, y, rot) {
  switch (((rot % 360) + 360) % 360) {
    case 90: return { x: -y, y: x }
    case 180: return { x: -x, y: -y }
    case 270: return { x: y, y: -x }
    default: return { x, y }
  }
}

/**
 * Absolute canvas position of a component pin, honouring rotation.
 * Pins are stored relative to the un-rotated top-left of the component;
 * rotation happens around the component centre.
 */
export function pinAbsolutePosition (component, pin) {
  const cx = component.x + component.width / 2
  const cy = component.y + component.height / 2
  const local = rotate90(pin.dx - component.width / 2, pin.dy - component.height / 2, component.rotation || 0)
  return { x: cx + local.x, y: cy + local.y }
}

/** Axis-aligned bounding box of a rotated component */
export function componentBBox (component) {
  const rot = ((component.rotation || 0) / 90) % 2 !== 0
  const w = rot ? component.height : component.width
  const h = rot ? component.width : component.height
  const cx = component.x + component.width / 2
  const cy = component.y + component.height / 2
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h }
}

/**
 * Orthogonal project of point P onto segment AB, clamped to the segment.
 * Returns { x, y, d } where d is the distance from P to the projection.
 */
export function projectOntoSegment (p, a, b) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
  const x = a.x + t * dx
  const y = a.y + t * dy
  return { x, y, d: Math.hypot(p.x - x, p.y - y), t }
}

/**
 * KiCad-style L-route between two points.
 * dir 'HV' = horizontal-then-vertical; 'VH' = vertical-then-horizontal.
 * Returns intermediate corner points only (may be empty for straight runs).
 */
export function orthogonalRoute (from, to, dir = 'HV') {
  if (from.x === to.x || from.y === to.y) return []
  return dir === 'HV'
    ? [{ x: to.x, y: from.y }]
    : [{ x: from.x, y: to.y }]
}

/** Expand a wire's ordered vertex list into [ [a, b], ... ] segments */
export function wireSegments (wire) {
  const segs = []
  for (let i = 0; i < wire.points.length - 1; i++) {
    const a = wire.points[i]
    const b = wire.points[i + 1]
    if (a.x !== b.x || a.y !== b.y) segs.push([a, b])
  }
  return segs
}

/** Stable string key for a canvas coordinate (grid resolution) */
export function coordKey (x, y) {
  return Math.round(x) + ',' + Math.round(y)
}

/**
 * SpatialHash — square-cell spatial index giving O(1) neighbourhood queries.
 *
 * Pins and wire vertices are inserted once per committed-state change; every
 * mousemove during a drag then only inspects the 3x3 cell neighbourhood of
 * the cursor instead of sweeping all canvas nodes.
 */
export class SpatialHash {
  constructor (cellSize = 100) {
    this.cellSize = cellSize
    this.cells = new Map()
  }

  _key (x, y) {
    return Math.floor(x / this.cellSize) + ',' + Math.floor(y / this.cellSize)
  }

  insert (x, y, payload) {
    const key = this._key(x, y)
    let bucket = this.cells.get(key)
    if (!bucket) {
      bucket = []
      this.cells.set(key, bucket)
    }
    bucket.push({ x, y, payload })
  }

  /**
   * Insert a segment by registering it in every cell its bounding box covers,
   * so point→segment queries stay O(1) for orthogonal wires.
   */
  insertSegment (a, b, payload) {
    const minX = Math.floor(Math.min(a.x, b.x) / this.cellSize)
    const maxX = Math.floor(Math.max(a.x, b.x) / this.cellSize)
    const minY = Math.floor(Math.min(a.y, b.y) / this.cellSize)
    const maxY = Math.floor(Math.max(a.y, b.y) / this.cellSize)
    for (let gx = minX; gx <= maxX; gx++) {
      for (let gy = minY; gy <= maxY; gy++) {
        const key = gx + ',' + gy
        let bucket = this.cells.get(key)
        if (!bucket) {
          bucket = []
          this.cells.set(key, bucket)
        }
        bucket.push({ a, b, payload, isSegment: true })
      }
    }
  }

  /** All entries within the 3x3 cell neighbourhood of (x, y) */
  neighbourhood (x, y) {
    const gx = Math.floor(x / this.cellSize)
    const gy = Math.floor(y / this.cellSize)
    const out = []
    for (let ix = gx - 1; ix <= gx + 1; ix++) {
      for (let iy = gy - 1; iy <= gy + 1; iy++) {
        const bucket = this.cells.get(ix + ',' + iy)
        if (bucket) out.push(...bucket)
      }
    }
    return out
  }

  /** Nearest point entry within `tolerance` of (x, y); null when none */
  nearestPoint (x, y, tolerance) {
    let best = null
    let bestD = tolerance
    for (const e of this.neighbourhood(x, y)) {
      if (e.isSegment) continue
      const d = Math.hypot(e.x - x, e.y - y)
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return best
  }

  /** Nearest segment (projected) within `tolerance`; null when none */
  nearestSegment (x, y, tolerance) {
    let best = null
    let bestD = tolerance
    for (const e of this.neighbourhood(x, y)) {
      if (!e.isSegment) continue
      const pr = projectOntoSegment({ x, y }, e.a, e.b)
      if (pr.d < bestD) {
        bestD = pr.d
        best = { x: pr.x, y: pr.y, d: pr.d, a: e.a, b: e.b, payload: e.payload }
      }
    }
    return best
  }
}

/**
 * Build the spatial index for a schematic snapshot: pins as points,
 * wire segments as segments, wire vertices as points.
 */
export function buildSpatialIndex (components, wires, cellSize = 100) {
  const index = new SpatialHash(cellSize)
  for (const comp of components) {
    for (const pin of comp.pins) {
      const p = pinAbsolutePosition(comp, pin)
      index.insert(p.x, p.y, { kind: 'pin', componentId: comp.id, pinNumber: pin.number })
    }
  }
  for (const wire of wires) {
    for (const pt of wire.points) {
      index.insert(pt.x, pt.y, { kind: 'wireVertex', wireId: wire.id })
    }
    for (const [a, b] of wireSegments(wire)) {
      index.insertSegment(a, b, { kind: 'wireSegment', wireId: wire.id })
    }
  }
  return index
}
