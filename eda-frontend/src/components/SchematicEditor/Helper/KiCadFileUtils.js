/* eslint-disable camelcase */
/**
 * KiCadFileUtils.js — imports native KiCad .sch files by mapping their
 * properties straight onto the JSON canvas state (components + wires).
 */

import store from '../../../redux/store'
import api from '../../../utils/Api'
import { fetchSymbolSchema, initialProperties } from './SvgParser'
import ComponentParameters from './ComponentParametersData'
import { schematicStore } from '../Canvas/schematicStore'
import { snapPoint } from '../Canvas/geometry'

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

// Reads KiCad .sch files and returns the schematic as instructions
const readKicadSchematic = (text) => {
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
        if (splt[1].indexOf(':') !== -1) {
          component.library = splt[1].split(':')[0].trim().toLowerCase()
          component.componentName = splt[1].split(':')[1].trim().toLowerCase()
        } else if (splt[1].indexOf('_') !== -1) {
          component.componentName = splt[1].split('_')[0].toLowerCase()
          component.library = splt[1].split('_')[1].toLowerCase()
        } else {
          component.componentName = splt[1].toLowerCase()
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
 * Resolve KiCad component references against the library API and push
 * component descriptors + wires into the canvas state.
 */
const loadComponents = async (components, wires) => {
  const token = store.getState().authReducer.token
  const config = { headers: { 'Content-Type': 'application/json' } }
  if (token) { config.headers.Authorization = `Token ${token}` }

  for (const comp of components) {
    let url
    if (comp.componentName && comp.library) {
      url = `components/?component_library__library_name__icontains=${comp.library}&name__icontains=${comp.componentName}`
    } else {
      url = `components/?name__icontains=${comp.componentName}`
    }
    try {
      const res = await api.get(url, config)
      if (!res.data || res.data.length === 0) continue
      const compData = findApprComp(res.data, comp.componentName)
      const schema = await fetchSymbolSchema(compData)
      const rotated = (comp.rotation / 90) % 2 !== 0
      const w = rotated ? schema.height : schema.width
      const h = rotated ? schema.width : schema.height
      // KiCad stores the component centre; the canvas stores the top-left
      const topLeft = snapPoint({ x: comp.x - w / 2, y: comp.y - h / 2 })
      schematicStore.addComponent({
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
    } catch (e) {
      console.error('Failed to import component', comp.componentName, e)
    }
  }

  // Each KiCad wire line is a straight segment; the DSU compiler unions
  // touching segments, so a 1:1 mapping preserves connectivity.
  for (const w of wires) {
    schematicStore.addWire([
      { x: w.startx, y: w.starty },
      { x: w.endx, y: w.endy }
    ], { undoable: false })
  }
}

export function importSCHFile (fileContents) {
  const rawInstr = readKicadSchematic(fileContents)
  loadComponents([...rawInstr.components], [...rawInstr.wires])
}
