/**
 * Core-logic tests for the React SVG canvas migration:
 * geometry transforms, DSU netlist compilation, junction dots and the
 * legacy mxGraph XML round-trip.
 */

import { screenToCanvas, zoomAtPoint, snap, orthogonalRoute, pinAbsolutePosition, buildSpatialIndex } from '../geometry'
import { buildNetwork, compileNetlist, checkErc, DSU } from '../dsuNetlist'
import { computeJunctions, snapProbeToWire } from '../junctions'
import { toLegacyXml, fromLegacyXml } from '../LegacyMxGraphSerializer'

const resistor = (id, x, y) => ({
  id,
  name: 'R',
  symbol: 'R',
  x,
  y,
  width: 60,
  height: 20,
  rotation: 0,
  svgPath: 'kicad-symbols/symbol_svgs/device/R.svg',
  compObject: { name: 'R', svg_path: 'kicad-symbols/symbol_svgs/device/R.svg', symbol_prefix: 'R' },
  properties: { NAME: 'R', VALUE: '1k' },
  pins: [
    { number: '1', name: '~', type: 'Input', dx: 0, dy: 10 },
    { number: '2', name: '~', type: 'Output', dx: 60, dy: 10 }
  ]
})

const ground = (id, x, y) => ({
  id,
  name: 'GND',
  symbol: 'PWR',
  x,
  y,
  width: 20,
  height: 20,
  rotation: 0,
  svgPath: 'kicad-symbols/symbol_svgs/power/GND.svg',
  compObject: null,
  properties: { NAME: 'GND' },
  pins: [{ number: '1', name: 'GND', type: 'Input', dx: 10, dy: 0 }]
})

describe('geometry', () => {
  it('converts screen to canvas honouring pan/zoom', () => {
    const view = { s: 2, dx: 100, dy: 50 }
    expect(screenToCanvas(140, 90, view)).toEqual({ x: 20, y: 20 })
  })

  it('keeps the cursor point fixed during pointer-centred zoom', () => {
    const view = { s: 1, dx: 0, dy: 0 }
    const zoomed = zoomAtPoint(view, 200, 150, 2)
    const before = screenToCanvas(200, 150, view)
    const after = screenToCanvas(200, 150, zoomed)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(zoomed.s).toBe(2)
  })

  it('snaps to the 20px grid', () => {
    expect(snap(28)).toBe(20)
    expect(snap(31)).toBe(40)
  })

  it('routes L-shapes in both directions', () => {
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 40, y: 60 }, 'HV')).toEqual([{ x: 40, y: 0 }])
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 40, y: 60 }, 'VH')).toEqual([{ x: 0, y: 60 }])
    expect(orthogonalRoute({ x: 0, y: 0 }, { x: 40, y: 0 }, 'HV')).toEqual([])
  })

  it('rotates pin positions around the component centre', () => {
    const comp = resistor('2', 0, 0)
    comp.rotation = 90
    // centre (30,10); pin1 local (-30, 0) -> rotated (0, -30) -> abs (30, -20)
    expect(pinAbsolutePosition(comp, comp.pins[0])).toEqual({ x: 30, y: -20 })
  })

  it('finds pins in O(1) neighbourhoods via the spatial hash', () => {
    const comps = [resistor('2', 0, 0), resistor('3', 500, 500)]
    const index = buildSpatialIndex(comps, [])
    const hit = index.nearestPoint(2, 12, 20)
    expect(hit.payload.componentId).toBe('2')
    expect(index.nearestPoint(300, 300, 20)).toBeNull()
  })
})

describe('DSU netlist compiler', () => {
  it('unions with path compression', () => {
    const dsu = new DSU()
    dsu.union('a', 'b')
    dsu.union('b', 'c')
    expect(dsu.find('a')).toBe(dsu.find('c'))
    expect(dsu.find('a')).not.toBe(dsu.add('d'))
  })

  it('nets two resistors joined by a wire', () => {
    const r1 = resistor('2', 0, 0) // pins at (0,10) and (60,10)
    const r2 = resistor('3', 200, 0) // pins at (200,10) and (260,10)
    const wire = { id: '4', points: [{ x: 60, y: 10 }, { x: 200, y: 10 }] }
    const net = buildNetwork({ components: [r1, r2], wires: [wire] })
    expect(net.pinNode.get('2:2')).toBe(net.pinNode.get('3:1'))
    expect(net.pinNode.get('2:1')).not.toBe(net.pinNode.get('2:2'))
  })

  it('grounds nets touching a PWR pin as node 0', () => {
    const r1 = resistor('2', 0, 0)
    const gnd = ground('3', 50, 100) // pin at (60, 100)
    const wire = { id: '4', points: [{ x: 60, y: 10 }, { x: 60, y: 100 }] }
    const compiled = compileNetlist({ components: [r1, gnd], wires: [wire] })
    expect(compiled.main).toContain('R1')
    const line = compiled.main.trim().split('\n')[0]
    expect(line.split(/\s+/)[2]).toBe('0') // pin 2 grounded
    expect(line).toContain('1k')
  })

  it('unions T-junctions between wires', () => {
    // wireB ends on the interior of wireA
    const wireA = { id: '4', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
    const wireB = { id: '5', points: [{ x: 50, y: 0 }, { x: 50, y: 80 }] }
    const net = buildNetwork({ components: [], wires: [wireA, wireB] })
    expect(net.dsu.find('0,0')).toBe(net.dsu.find('50,80'))
  })

  it('runs ERC: detects unconnected pins and missing ground', () => {
    const r1 = resistor('2', 0, 0)
    const erc = checkErc({ components: [r1], wires: [] })
    expect(erc.isValid).toBe(false)
    expect(erc.pinNC).toBe(2)
    expect(erc.errorMsg).toBe('Pins not connected')
  })
})

describe('junction dots', () => {
  it('marks T junctions but not plain crossings', () => {
    const wireA = { id: '4', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
    const tee = { id: '5', points: [{ x: 50, y: 0 }, { x: 50, y: 80 }] }
    const crossing = { id: '6', points: [{ x: 80, y: -40 }, { x: 80, y: 40 }] }
    const junctions = computeJunctions([wireA, tee, crossing], [])
    expect(junctions).toEqual([{ x: 50, y: 0 }])
  })

  it('snaps probes onto segments within 8px only', () => {
    const wire = { id: '4', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] }
    const hit = snapProbeToWire({ x: 40, y: 6 }, [wire])
    expect(hit).toMatchObject({ x: 40, y: 0, wireId: '4' })
    expect(snapProbeToWire({ x: 40, y: 12 }, [wire])).toBeNull()
  })
})

describe('LegacyMxGraphSerializer', () => {
  it('round-trips components, wires and probes through mxGraph XML', () => {
    const doc = {
      components: [resistor('2', 20, 40)],
      wires: [{ id: '10', points: [{ x: 80, y: 50 }, { x: 140, y: 50 }, { x: 140, y: 100 }] }],
      probes: [{ id: '11', label: 'PR1', probeType: 'V', color: '#e41a1c', x: 130, y: 60 }]
    }
    const xml = toLegacyXml(doc)
    expect(xml).toContain('<mxGraphModel><root>')
    expect(xml).toContain('id="0"')
    expect(xml).toContain('id="1"')
    expect(xml).toContain('Component="1"')
    expect(xml).toContain('edge="1"')

    const back = fromLegacyXml(xml)
    expect(back.components).toHaveLength(1)
    expect(back.components[0]).toMatchObject({ id: '2', symbol: 'R', x: 20, y: 40, width: 60, height: 20 })
    expect(back.components[0].pins).toHaveLength(2)
    expect(back.components[0].properties.VALUE).toBe('1k')
    expect(back.wires).toHaveLength(1)
    // wire starts on R pin 2 (80, 50), keeps its corner and end
    expect(back.wires[0].points[0]).toEqual({ x: 80, y: 50 })
    expect(back.wires[0].points[back.wires[0].points.length - 1]).toEqual({ x: 140, y: 100 })
    expect(back.probes).toHaveLength(1)
    expect(back.probes[0]).toMatchObject({ label: 'PR1', probeType: 'V', x: 130, y: 60 })
  })

  it('keeps electrical connectivity across the round-trip', () => {
    const doc = {
      components: [resistor('2', 0, 0), ground('3', 50, 100)],
      wires: [{ id: '4', points: [{ x: 60, y: 10 }, { x: 60, y: 100 }] }],
      probes: []
    }
    const back = fromLegacyXml(toLegacyXml(doc))
    const net = buildNetwork(back)
    expect(net.pinNode.get('2:2')).toBe('0')
  })
})
