/* eslint-disable camelcase */
/**
 * KiCadFileUtils.js — imports legacy KiCad v4/v5 .sch files.
 *
 * Placement resolves each component against the library API; wiring is
 * netlist-driven: the original wire geometry is only used to reconstruct
 * pin-to-pin connectivity (TranslationLayer/legacyNets), then every net is
 * re-routed between the pins of the placed library symbols
 * (TranslationLayer/autoWire). Copying the file's wires verbatim is what
 * used to produce stubs that miss the pins — the legacy symbols' pin
 * positions never match the local library's.
 *
 * KiCad v6+ (.kicad_sch) files are handled by TranslationLayer/importKicadSch.
 */

import store from '../../../redux/store'
import api from '../../../utils/Api'
import { fetchSymbolSchema, initialProperties } from './SvgParser'
import ComponentParameters from './ComponentParametersData'
import { schematicStore } from '../Canvas/schematicStore'
import { snapPoint, pinAbsolutePosition } from '../Canvas/geometry'
import { extractLegacyNets } from '../TranslationLayer/legacyNets'
import { wirePointGroups } from '../TranslationLayer/autoWire'
import { parseLegacyLib, legacyPinPosition, buildPlaceholder } from '../TranslationLayer/legacyLib'

// orientation matrix [x1, y1, x2, y2] (KiCad defined)
// used for defining rotation and x mirrored states
const orientations = [
  [1, 0, 0, -1], [0, 1, 1, 0], [-1, 0, 0, 1], [0, -1, -1, 0],
  [1, 0, 0, 1], [0, -1, 1, 0], [1, 0, 0, -1], [0, 1, -1, 0],
  [-1, 0, 0, -1], [0, 1, -1, 0], [1, 0, 0, 1], [0, -1, 1, 0]
]

// KiCad-units to canvas-units divisor (matches the symbol svg scale)
const defScale = 5

/** Legacy bootstrap hook — the declarative canvas needs no graph handle. */
export default function KiCadFileUtils () {}

/**
 * Normalise a legacy symbol name for library lookup.
 * KiCad's rescue pass renames symbols to "<name>-RESCUE-<sheet>"; the suffix
 * never exists in the component library.
 */
export function normalizeLegacyName (raw) {
  return String(raw || '').replace(/-RESCUE-.*$/i, '').trim().toLowerCase()
}

// Reads KiCad .sch files and returns the schematic as instructions
export const readKicadSchematic = (text) => {
  const textSplit = text.split('\n')
  let i = 0
  const instructions = {}

  // Metadata and description of the schematic
  for (i = 0; i < textSplit.length; i++) {
    let brk = false
    const splt = textSplit[i].split(' ')
    switch (splt[0]) {
      case '$Descr':
        instructions.pageSize = splt[1]
        instructions.oreientation = parseInt(splt[1]) > parseInt(splt[2]) ? 'L' : 'P'
        break
      case 'Title':
        instructions.title = splt[1].substr(1, splt[1].length - 2)
        break
      case '$EndDescr':
        brk = true
        break
      default:
        break
    }
    if (brk) break
  }

  instructions.components = []
  instructions.wires = []
  instructions.connections = []
  instructions.labels = []
  let component = {}
  let wire = {}
  let connection = {}
  for (; i < textSplit.length; i++) {
    let splt = textSplit[i].split(' ')
    switch (splt[0]) {
      case '$Comp':
        i += 1
        component = {}
        splt = textSplit[i].split(' ')
        component.rawName = splt[1]
        component.reference = (splt[2] || '').trim()
        if (splt[1].indexOf(':') !== -1) {
          component.library = splt[1].split(':')[0].trim().toLowerCase()
          component.componentName = normalizeLegacyName(splt[1].split(':')[1])
        } else {
          component.componentName = normalizeLegacyName(splt[1])
          component.library = null
        }
        i += 2 // skips identifier line
        splt = textSplit[i].split(' ')
        component.x = parseInt(splt[1]) / defScale
        component.y = parseInt(splt[2]) / defScale
        i++
        // skips F command lines
        do {
          i++
        } while (textSplit[i].split(' ')[0] === 'F')
        i += 1 // skips redundant x y position line
        {
          let compOrient = textSplit[i].split(' ')
          compOrient[0] = compOrient[0].split('\t')[1]
          compOrient = compOrient.filter((e) => e !== '').map((e) => parseInt(e))
          let rotation = 0
          let mirrorX = false
          let mirrorY = false
          for (let index = 0; index < orientations.length; index++) {
            if (compOrient[0] === orientations[index][0] && compOrient[1] === orientations[index][1] &&
              compOrient[2] === orientations[index][2] && compOrient[3] === orientations[index][3]) {
              rotation = (index % 4) * 90
              if (index > 7) { mirrorY = true } else if (index > 3) { mirrorX = true }
              break
            }
          }
          component.rotation = rotation
          component.mirrorX = mirrorX
          component.mirrorY = mirrorY
          component.matrix = compOrient.slice(0, 4) // raw legacy transform
        }
        while (textSplit[i].split(' ')[0] !== '$EndComp') {
          i++
        }
        instructions.components.push(component)
        break
      case 'Wire':
        if (splt[1] === 'Wire') {
          i += 1
          wire = {}
          let posWire = textSplit[i].split(' ')
          posWire = posWire.filter((e) => e.length !== 0)
          wire.startx = parseInt(posWire[0].split('\t')[1]) / defScale
          wire.starty = parseInt(posWire[1]) / defScale
          wire.endx = parseInt(posWire[2]) / defScale
          wire.endy = parseInt(posWire[3]) / defScale
          instructions.wires.push(wire)
        }
        break
      case 'Connection':
        connection = {}
        {
          const posConn = splt.filter((e) => e.length !== 0)
          connection.x = parseInt(posConn[2]) / defScale
          connection.y = parseInt(posConn[3]) / defScale
        }
        instructions.connections.push(connection)
        break
      case 'Text':
        // "Text GLabel X Y ..." / "Text Label X Y ..." — the text sits on
        // the following line. Labels only name nets; no geometry imported.
        if (splt[1] === 'GLabel' || splt[1] === 'Label' || splt[1] === 'HLabel') {
          const parts = splt.filter((e) => e.length !== 0)
          instructions.labels.push({
            kind: parts[1],
            x: parseInt(parts[2]) / defScale,
            y: parseInt(parts[3]) / defScale,
            text: (textSplit[i + 1] || '').trim()
          })
          i += 1
        }
        break
      default:
        break
    }
  }
  return instructions
}

const findApprComp = (compDataList, key) => {
  for (let i = 0; i < compDataList.length; i++) {
    if (compDataList[i].name.toLowerCase() === key.toLowerCase()) {
      return compDataList[i]
    }
  }
  return compDataList[0]
}

/**
 * Library lookup with fallbacks. The old importer split names containing an
 * underscore into name + library ("plot_v1" → "plot" in library "v1"), which
 * broke every component whose real name contains an underscore — so the full
 * name is tried first, then the scoped and split variants.
 */
async function resolveLegacyComponent (comp, cache, config) {
  const cacheKey = (comp.library || '') + ':' + comp.componentName
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  const attempts = []
  if (comp.library) {
    attempts.push(`components/?component_library__library_name__icontains=${comp.library}&name__icontains=${comp.componentName}`)
  }
  attempts.push(`components/?name__icontains=${comp.componentName}`)
  if (comp.componentName.indexOf('_') !== -1) {
    const [name, library] = comp.componentName.split('_')
    attempts.push(`components/?component_library__library_name__icontains=${library}&name__icontains=${name}`)
  }

  let result = null
  for (const url of attempts) {
    try {
      const res = await api.get(url, config)
      if (res.data && res.data.length > 0) {
        const compData = findApprComp(res.data, comp.componentName)
        const schema = await fetchSymbolSchema(compData)
        result = { compData, schema }
        break
      }
    } catch (e) {
      console.error('Legacy import: lookup failed for', comp.rawName, e)
    }
  }
  cache.set(cacheKey, result)
  return result
}

/** Cache-lib def for a component, trying raw and rescue-stripped names */
function defForComponent (defs, comp) {
  if (!defs) return null
  return defs.get(comp.rawName) ||
    defs.get(comp.componentName) ||
    defs.get(comp.rawName.replace(/-RESCUE-.*$/i, '')) ||
    null
}

/**
 * Net points carry (componentId, pin number, pin index); wiring happens at
 * the pins of the *placed* symbol, looked up by number with an index
 * fallback for symbols the library numbers differently.
 */
function placedPinPoint (netPoint, placedById) {
  const comp = placedById.get(netPoint.componentId)
  if (!comp || !comp.pins || comp.pins.length === 0) return null
  let pin = comp.pins.find((p) => String(p.number) === String(netPoint.pin))
  if (!pin && netPoint.idx != null) pin = comp.pins[netPoint.idx]
  if (!pin) return null
  return pinAbsolutePosition(comp, pin)
}

/**
 * Resolve and place the components, then reconstruct connectivity from the
 * original wires/junctions and re-route every net between the placed pins.
 *
 * With a -cache.lib the original pin positions are exact (legacyPinPosition),
 * so netlist extraction has zero ambiguity and unresolved components get a
 * placeholder symbol with the exact pin layout instead of being dropped.
 * Without it, connectivity falls back to proximity matching of the placed
 * pins against the original wires.
 */
const loadComponents = async (instructions, defs) => {
  const token = store.getState().authReducer.token
  const config = { headers: { 'Content-Type': 'application/json' } }
  if (token) { config.headers.Authorization = `Token ${token}` }

  const cache = new Map()
  const netPins = [] // fed to extractLegacyNets
  const placedById = new Map()
  const skipped = []
  const placeholders = []

  for (const comp of instructions.components) {
    const def = defForComponent(defs, comp)
    const resolved = await resolveLegacyComponent(comp, cache, config)

    let placed = null
    if (resolved) {
      const { compData, schema } = resolved
      const rotated = (comp.rotation / 90) % 2 !== 0
      const w = rotated ? schema.height : schema.width
      const h = rotated ? schema.width : schema.height
      // KiCad stores the component centre; the canvas stores the top-left
      const topLeft = snapPoint({ x: comp.x - w / 2, y: comp.y - h / 2 })
      const id = schematicStore.addComponent({
        name: (compData.name || '').toUpperCase(),
        symbol: (compData.symbol_prefix || '').toUpperCase(),
        x: topLeft.x,
        y: topLeft.y,
        width: schema.width,
        height: schema.height,
        rotation: comp.rotation || 0,
        svgPath: compData.svg_path,
        compObject: compData,
        properties: initialProperties(compData, ComponentParameters),
        pins: schema.pins.map((pin) => ({
          number: pin.number,
          name: pin.name,
          type: pin.type,
          dx: pin.dx,
          dy: pin.dy
        }))
      })
      placed = schematicStore.getComponent(id)
    } else if (def) {
      // Not in the library — place an exact-pin placeholder from the cache lib.
      // KiCad references starting with '#' (power symbols, PWR_FLAG) are
      // virtual and must never reach the SPICE netlist — a bare "FLG1 0"
      // line segfaults ngspice. eSim's plot_* symbols are display-only
      // probes, equally not simulatable. Both get the 'PWR' symbol so the
      // netlist compiler's existing skip rule drops them.
      const virtual = def.reference.startsWith('#') || /^plot/i.test(def.name)
      const ph = buildPlaceholder(comp, def)
      const id = schematicStore.addComponent({
        ...ph,
        symbol: virtual ? 'PWR' : (def.reference || 'U'),
        rotation: 0, // transform baked into the pin offsets
        compObject: { name: def.name, placeholder: true },
        properties: { NAME: (comp.reference || def.name).toUpperCase() }
      })
      placed = schematicStore.getComponent(id)
      placeholders.push((comp.reference || '?') + ' (' + comp.rawName + ')')
    } else {
      skipped.push((comp.reference || '?') + ' (' + comp.rawName + ')')
      continue
    }
    placedById.set(placed.id, placed)

    if (def) {
      // Exact: the original sheet position of every pin, straight from the lib
      def.pins.forEach((pin, idx) => {
        const p = legacyPinPosition(comp, pin)
        netPins.push({ x: p.x, y: p.y, componentId: placed.id, pin: pin.number, idx })
      })
    } else {
      // Fuzzy: fall back to the placed symbol's pins (proximity matching)
      placed.pins.forEach((pin, idx) => {
        const p = pinAbsolutePosition(placed, pin)
        netPins.push({ x: p.x, y: p.y, componentId: placed.id, pin: pin.number, idx })
      })
    }
  }

  const nets = extractLegacyNets({
    segments: instructions.wires.map((w) => ({
      a: { x: w.startx, y: w.starty },
      b: { x: w.endx, y: w.endy }
    })),
    junctions: instructions.connections,
    labels: instructions.labels,
    pins: netPins
  })

  const groups = nets.map((n) =>
    n.points.map((pt) => placedPinPoint(pt, placedById)).filter(Boolean))
  const wired = wirePointGroups(groups)

  return {
    placed: placedById.size,
    placeholders,
    skipped,
    nets: nets.filter((n) => n.points.length >= 2).length,
    wired
  }
}

/**
 * @param {string} fileContents .sch text
 * @param {string} [cacheLibContents] optional -cache.lib text for exact pins
 */
export function importSCHFile (fileContents, cacheLibContents) {
  const instructions = readKicadSchematic(fileContents)
  const defs = cacheLibContents ? parseLegacyLib(cacheLibContents) : null
  return loadComponents(instructions, defs)
}
