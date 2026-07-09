/**
 * LegacyMxGraphSerializer.js — backward-compatibility adapter between the
 * declarative canvas document and the legacy mxGraph XML schema stored in the
 * backend (`data_dump`) and consumed by the read-only Viewer.
 *
 * Legacy schema essentials (see old ToolbarTools.parseXmlToGraph):
 *  - <mxGraphModel><root> with base cells id="0" and id="1"
 *  - components: vertex="1" Component="1", geometry as first child,
 *    an Object as="properties" child carrying NAME/VALUE/... attributes
 *  - pins: vertex="1" Pin="1" parent="<compId>", tiny 0.5x0.5 geometry
 *  - wires: edge="1" with sourceVertex/targetVertex pin ids, tarx/tary
 *    endpoint coordinates, and waypoints as the second child's mxPoint list
 *  - every cell carries Component and Pin attributes (the legacy parser
 *    dereferences them unconditionally)
 */

import { pinAbsolutePosition, coordKey } from './geometry'
import { bumpIdCounter } from './schematicStore'

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }

function esc (v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES[c])
}

function attrs (obj) {
  return Object.keys(obj)
    .filter((k) => obj[k] !== undefined && obj[k] !== null)
    .map((k) => `${k}="${esc(obj[k])}"`)
    .join(' ')
}

function componentStyle (comp) {
  let style = 'shape=image;fontColor=blue;image=../' + comp.svgPath +
    ';imageVerticalAlign=bottom;verticalAlign=bottom;imageAlign=bottom;align=bottom;spacingLeft=25;'
  if (comp.rotation) style += 'rotation=' + comp.rotation + ';'
  return style
}

/**
 * Serialize the canvas document to legacy mxGraph XML.
 * @param {{components: Array, wires: Array, probes: Array}} doc
 * @returns {string}
 */
export function toLegacyXml (doc) {
  const parts = []
  parts.push('<mxGraphModel><root>')
  parts.push('<mxCell id="0" CellType="This is where you say what the vertex is" pinType=" " Component="0" Pin="0" PinNumber="0" PinName=""><Object as="properties"/></mxCell>')
  parts.push('<mxCell id="1" parent="0" CellType="This is where you say what the vertex is" pinType=" " Component="0" Pin="0" PinNumber="0" PinName=""><Object as="properties"/></mxCell>')

  // Map coordKey -> pin id so wires can rebind their legacy terminals
  const pinIdAt = new Map()
  let pinIdCursor = maxNumericId(doc) + 1

  for (const comp of doc.components) {
    parts.push('<mxCell ' + attrs({
      id: comp.id,
      value: comp.name,
      style: componentStyle(comp),
      vertex: '1',
      parent: '1',
      connectable: '0',
      Component: '1',
      Pin: '0',
      CellType: 'Component',
      symbol: comp.symbol,
      pinType: ' ',
      PinNumber: '0',
      PinName: ''
    }) + '>')
    parts.push(`<mxGeometry ${attrs({ x: comp.x, y: comp.y, width: comp.width, height: comp.height })} as="geometry"/>`)
    if (comp.compObject) {
      parts.push('<Object ' + attrs({
        id: comp.compObject.id,
        name: comp.compObject.name,
        svg_path: comp.compObject.svg_path,
        thumbnail_path: comp.compObject.thumbnail_path,
        symbol_prefix: comp.compObject.symbol_prefix,
        component_library: comp.compObject.component_library,
        description: comp.compObject.description,
        data_link: comp.compObject.data_link,
        full_name: comp.compObject.full_name,
        keyword: comp.compObject.keyword
      }) + ' as="CompObject"><Array as="alternate_component"/></Object>')
    }
    parts.push('<Object ' + attrs(comp.properties || {}) + ' as="properties"/>')
    parts.push('</mxCell>')

    for (const pin of comp.pins) {
      const pid = pin.id || String(pinIdCursor++)
      const abs = pinAbsolutePosition(comp, pin)
      pinIdAt.set(coordKey(abs.x, abs.y), pid)
      parts.push('<mxCell ' + attrs({
        id: pid,
        value: pin.number,
        style: 'align=right;verticalAlign=bottom;rotation=0',
        vertex: '1',
        parent: comp.id,
        Pin: '1',
        Component: '0',
        pinType: pin.type || 'Output',
        PinNumber: pin.number,
        PinName: pin.name || '',
        CellType: 'This is where you say what the vertex is'
      }) + '>')
      parts.push(`<mxGeometry ${attrs({ x: pin.dx, y: pin.dy, width: 0.5, height: 0.5 })} as="geometry"/>`)
      parts.push('</mxCell>')
    }
  }

  for (const wire of doc.wires) {
    if (wire.points.length < 2) continue
    const first = wire.points[0]
    const last = wire.points[wire.points.length - 1]
    const sourcePin = pinIdAt.get(coordKey(first.x, first.y))
    const targetPin = pinIdAt.get(coordKey(last.x, last.y))
    parts.push('<mxCell ' + attrs({
      id: wire.id,
      style: '',
      edge: '1',
      parent: '1',
      source: sourcePin,
      target: targetPin,
      sourceVertex: sourcePin || '0',
      targetVertex: targetPin || '0',
      srcx: first.x,
      srcy: first.y,
      tarx: last.x,
      tary: last.y,
      Component: '0',
      Pin: '0',
      CellType: 'Wire'
    }) + '>')
    parts.push('<mxGeometry relative="1" as="geometry">' +
      `<mxPoint ${attrs({ x: first.x, y: first.y })} as="sourcePoint"/>` +
      `<mxPoint ${attrs({ x: last.x, y: last.y })} as="targetPoint"/>` +
      '</mxGeometry>')
    // Interior waypoints — second child so the legacy parser's
    // `cells[i].children[1].children` picks them up as mxPoints.
    const waypoints = wire.points.slice(1, -1)
    parts.push('<Array as="PointsArray">' +
      waypoints.map((p) => `<mxPoint ${attrs({ x: p.x, y: p.y })}/>`).join('') +
      '</Array>')
    parts.push('</mxCell>')
  }

  for (const probe of doc.probes || []) {
    parts.push('<mxCell ' + attrs({
      id: probe.id,
      value: probe.label,
      vertex: '1',
      parent: '1',
      Component: '0',
      Pin: '0',
      CellType: 'Probe',
      probeType: probe.probeType,
      probeColor: probe.color
    }) + '>')
    parts.push(`<mxGeometry ${attrs({ x: probe.x, y: probe.y, width: 60, height: 50 })} as="geometry"/>`)
    parts.push('</mxCell>')
  }

  parts.push('</root></mxGraphModel>')
  return parts.join('')
}

function maxNumericId (doc) {
  let max = 1
  const track = (id) => {
    const n = parseInt(id, 10)
    if (!isNaN(n) && n > max) max = n
  }
  doc.components.forEach((c) => {
    track(c.id)
    c.pins.forEach((p) => p.id && track(p.id))
  })
  doc.wires.forEach((w) => track(w.id))
  ;(doc.probes || []).forEach((p) => track(p.id))
  return max
}

function styleValue (style, key) {
  const m = (style || '').match(new RegExp('(?:^|;)' + key + '=([^;]*)'))
  return m ? m[1] : null
}

function childByAs (cell, tag, asName) {
  for (let i = 0; i < cell.children.length; i++) {
    const ch = cell.children[i]
    if (ch.tagName === tag && ch.getAttribute('as') === asName) return ch
  }
  return null
}

function objectAttrs (node) {
  const out = {}
  if (!node) return out
  for (let i = 0; i < node.attributes.length; i++) {
    const a = node.attributes[i]
    if (a.name !== 'as') out[a.name] = a.value
  }
  return out
}

function geomOf (cell) {
  const g = childByAs(cell, 'mxGeometry', 'geometry') || cell.getElementsByTagName('mxGeometry')[0]
  if (!g) return { x: 0, y: 0, width: 0, height: 0, node: null }
  return {
    x: parseFloat(g.getAttribute('x')) || 0,
    y: parseFloat(g.getAttribute('y')) || 0,
    width: parseFloat(g.getAttribute('width')) || 0,
    height: parseFloat(g.getAttribute('height')) || 0,
    node: g
  }
}

/** Insert L-corners so imported polylines stay orthogonal */
function orthogonalize (points) {
  const out = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && last.x !== p.x && last.y !== p.y) {
      out.push({ x: p.x, y: last.y })
    }
    if (!last || last.x !== p.x || last.y !== p.y) out.push({ x: p.x, y: p.y })
  }
  return out
}

/**
 * Parse legacy mxGraph XML into a canvas document.
 * Handles both mxCodec-encoded saves from the old editor and files written
 * by toLegacyXml above.
 *
 * @param {string} xml
 * @returns {{components: Array, wires: Array, probes: Array}}
 */
export function fromLegacyXml (xml) {
  const dom = new DOMParser().parseFromString(xml, 'text/xml')
  const rootEl = dom.documentElement.getElementsByTagName('root')[0] || dom.documentElement.children[0]
  const doc = { components: [], wires: [], probes: [] }
  if (!rootEl) return doc

  const compById = new Map()
  const pinIndex = new Map() // pinId -> { comp, pin }
  const edges = []
  let lastComponent = null

  const cells = rootEl.children
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]
    if (cell.tagName !== 'mxCell') continue
    const id = cell.getAttribute('id')
    if (id === '0' || id === '1') continue
    bumpIdCounter(id)

    const cellType = cell.getAttribute('CellType')
    const isEdge = cell.getAttribute('edge') === '1'
    const isComponent = cell.getAttribute('Component') === '1' || cellType === 'Component'
    const isPin = cell.getAttribute('Pin') === '1'

    if (isEdge) {
      edges.push(cell)
      continue
    }

    if (cellType === 'Probe') {
      const g = geomOf(cell)
      doc.probes.push({
        id,
        label: cell.getAttribute('value') || 'PR' + (doc.probes.length + 1),
        probeType: cell.getAttribute('probeType') || 'V',
        color: cell.getAttribute('probeColor') || '#00e676',
        x: g.x,
        y: g.y
      })
      continue
    }

    if (isComponent) {
      const g = geomOf(cell)
      const style = cell.getAttribute('style') || ''
      const image = styleValue(style, 'image') || ''
      const compObject = objectAttrs(childByAs(cell, 'Object', 'CompObject'))
      const properties = objectAttrs(childByAs(cell, 'Object', 'properties'))
      const comp = {
        id,
        name: cell.getAttribute('value') || properties.NAME || '',
        symbol: cell.getAttribute('symbol') || compObject.symbol_prefix || '',
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
        rotation: parseInt(styleValue(style, 'rotation'), 10) || 0,
        svgPath: compObject.svg_path || image.replace(/^(\.\.\/)+/, ''),
        compObject: Object.keys(compObject).length ? compObject : null,
        properties,
        pins: []
      }
      doc.components.push(comp)
      compById.set(id, comp)
      lastComponent = comp
      continue
    }

    if (isPin) {
      const parentId = cell.getAttribute('parent')
      const comp = compById.get(parentId) || lastComponent
      if (!comp) continue
      const g = geomOf(cell)
      const pin = {
        id,
        number: cell.getAttribute('value') || cell.getAttribute('PinNumber') || String(comp.pins.length + 1),
        name: cell.getAttribute('PinName') || '',
        type: cell.getAttribute('pinType') || 'Output',
        dx: g.x,
        dy: g.y
      }
      comp.pins.push(pin)
      pinIndex.set(id, { comp, pin })
    }
  }

  for (const cell of edges) {
    const id = cell.getAttribute('id')
    const geomNode = geomOf(cell).node

    const pointAt = (asName) => {
      if (!geomNode) return null
      for (let i = 0; i < geomNode.children.length; i++) {
        const ch = geomNode.children[i]
        if (ch.tagName === 'mxPoint' && ch.getAttribute('as') === asName) {
          return { x: parseFloat(ch.getAttribute('x')) || 0, y: parseFloat(ch.getAttribute('y')) || 0 }
        }
      }
      return null
    }

    const pinPoint = (ref) => {
      const entry = ref && pinIndex.get(ref)
      if (!entry) return null
      return pinAbsolutePosition(entry.comp, entry.pin)
    }

    const numAttr = (name) => {
      const v = cell.getAttribute(name)
      return v === null || v === '' ? null : parseFloat(v)
    }

    const start =
      pinPoint(cell.getAttribute('source')) ||
      pinPoint(cell.getAttribute('sourceVertex')) ||
      pointAt('sourcePoint') ||
      (numAttr('srcx') !== null ? { x: numAttr('srcx'), y: numAttr('srcy') || 0 } : null)

    const end =
      pinPoint(cell.getAttribute('target')) ||
      pinPoint(cell.getAttribute('targetVertex')) ||
      pointAt('targetPoint') ||
      (numAttr('tarx') !== null ? { x: numAttr('tarx'), y: numAttr('tary') || 0 } : null)

    // Waypoints: geometry <Array as="points"> (mxCodec) or <Array as="PointsArray">
    const waypoints = []
    const collect = (arrayNode) => {
      if (!arrayNode) return
      for (let i = 0; i < arrayNode.children.length; i++) {
        const p = arrayNode.children[i]
        if (p.tagName === 'mxPoint') {
          waypoints.push({ x: parseFloat(p.getAttribute('x')) || 0, y: parseFloat(p.getAttribute('y')) || 0 })
        }
      }
    }
    collect(geomNode && childByAs({ children: geomNode.children }, 'Array', 'points'))
    if (waypoints.length === 0) collect(childByAs(cell, 'Array', 'PointsArray'))

    if (!start || !end) continue
    const points = orthogonalize([start, ...waypoints, end])
    if (points.length >= 2) doc.wires.push({ id, points })
  }

  return doc
}
