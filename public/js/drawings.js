/**
 * Public drawing API.
 *
 * The old single-file implementation lived here; it is now split into:
 *   drawings/registry.js  - tool definitions and categories
 *   drawings/store.js     - persistence and migration
 *   drawings/render.js    - geometry, drawing and hit-testing
 *   drawings/engine.js    - selection, editing, history, magnet
 */

export { DrawingLayer, normalizeShape, defaultsFor } from './drawings/engine.js';
export {
  TOOLS, TOOL_GROUPS, TOOL_LIST, TOOL_BY_ID, GROUP_BY_ID,
  DRAW_TOOL_IDS, FIB_LEVELS, FIB_EXT_LEVELS, toolDef, groupOf, toolsInGroup,
} from './drawings/registry.js';
export { drawingStore, DrawingStore, DRAWING_STORAGE_KEYS } from './drawings/store.js';
export { renderShape, hitShape, shapeHandles, shapeOutline, positionMetrics } from './drawings/render.js';
