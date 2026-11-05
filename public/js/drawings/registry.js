/**
 * Drawing tool registry.
 *
 * The toolbar, the drawing engine and the property panel all read the same
 * definitions from here, so adding a tool in one place is enough. Rendering
 * lives in render.js; this file only describes tools and their defaults.
 */

const draw = (id, label, anchors, extra = {}) => ({
  id,
  label,
  anchors,
  kind: 'draw',
  color: '#2962ff',
  width: 1.5,
  lineStyle: 0,
  fillOpacity: 0.08,
  fontSize: 12,
  ...extra,
});

const cursor = (id, label, cursorStyle) => ({
  id,
  label,
  kind: 'cursor',
  cursorStyle,
  anchors: 0,
});

const T = {
  /* cursor ------------------------------------------------------------ */
  cursorCross: cursor('cursorCross', 'Cross', 'crosshair'),
  cursorDot: cursor('cursorDot', 'Dot', 'cell'),
  cursorArrow: cursor('cursorArrow', 'Arrow', 'default'),
  eraser: cursor('eraser', 'Eraser', 'eraser'),

  /* trend lines ------------------------------------------------------- */
  trend: draw('trend', 'Trend Line', 2, { group: 'trend' }),
  ray: draw('ray', 'Ray', 2, { group: 'trend' }),
  info: draw('info', 'Info Line', 2, { group: 'trend' }),
  extended: draw('extended', 'Extended Line', 2, { group: 'trend' }),
  trendAngle: draw('trendAngle', 'Trend Angle', 2, { group: 'trend' }),
  hline: draw('hline', 'Horizontal Line', 1, { group: 'trend', color: '#787b86' }),
  hray: draw('hray', 'Horizontal Ray', 1, { group: 'trend', color: '#787b86' }),
  vline: draw('vline', 'Vertical Line', 1, { group: 'trend', color: '#787b86' }),
  crossLine: draw('crossLine', 'Cross Line', 1, { group: 'trend', color: '#787b86' }),
  arrow: draw('arrow', 'Arrow', 2, { group: 'trend' }),
  parallelChannel: draw('parallelChannel', 'Parallel Channel', 3, { group: 'trend', fillOpacity: 0.07 }),
  regression: draw('regression', 'Regression Trend', 2, { group: 'trend', fillOpacity: 0.06 }),
  flatTopBottom: draw('flatTopBottom', 'Flat Top/Bottom', 3, { group: 'trend', fillOpacity: 0.07 }),
  disjointChannel: draw('disjointChannel', 'Disjoint Channel', 3, { group: 'trend', fillOpacity: 0.07 }),

  /* Fibonacci --------------------------------------------------------- */
  fibRetracement: draw('fibRetracement', 'Fib Retracement', 2, { group: 'fib', color: '#f0a029', fillOpacity: 0.06 }),
  fibExtension: draw('fibExtension', 'Trend-Based Fib Extension', 3, { group: 'fib', color: '#f0a029' }),
  fibChannel: draw('fibChannel', 'Fib Channel', 3, { group: 'fib', color: '#f0a029', fillOpacity: 0.05 }),
  fibTimeZone: draw('fibTimeZone', 'Fib Time Zone', 2, { group: 'fib', color: '#f0a029' }),
  fibSpeedFan: draw('fibSpeedFan', 'Fib Speed Resistance Fan', 2, { group: 'fib', color: '#f0a029' }),
  fibTime: draw('fibTime', 'Trend-Based Fib Time', 2, { group: 'fib', color: '#f0a029' }),
  fibCircles: draw('fibCircles', 'Fib Circles', 2, { group: 'fib', color: '#f0a029' }),
  fibSpiral: draw('fibSpiral', 'Fib Spiral', 2, { group: 'fib', color: '#f0a029' }),
  fibArcs: draw('fibArcs', 'Fib Speed Resistance Arcs', 2, { group: 'fib', color: '#f0a029' }),
  fibWedge: draw('fibWedge', 'Fib Wedge', 3, { group: 'fib', color: '#f0a029', fillOpacity: 0.05 }),

  /* Pitchfork --------------------------------------------------------- */
  pitchfork: draw('pitchfork', 'Pitchfork', 3, { group: 'fib', color: '#2962ff', fillOpacity: 0.05 }),
  pitchforkSchiff: draw('pitchforkSchiff', 'Schiff Pitchfork', 3, { group: 'fib', color: '#2962ff', fillOpacity: 0.05 }),
  pitchforkModifiedSchiff: draw('pitchforkModifiedSchiff', 'Modified Schiff Pitchfork', 3, { group: 'fib', color: '#2962ff', fillOpacity: 0.05 }),
  pitchforkInside: draw('pitchforkInside', 'Inside Pitchfork', 3, { group: 'fib', color: '#2962ff', fillOpacity: 0.05 }),

  /* Gann -------------------------------------------------------------- */
  gannBox: draw('gannBox', 'Gann Box', 2, { group: 'fib', color: '#9c6ade', fillOpacity: 0.04 }),
  gannSquareFixed: draw('gannSquareFixed', 'Gann Square Fixed', 2, { group: 'fib', color: '#9c6ade', fillOpacity: 0.04 }),
  gannSquare: draw('gannSquare', 'Gann Square', 2, { group: 'fib', color: '#9c6ade', fillOpacity: 0.04 }),
  gannFan: draw('gannFan', 'Gann Fan', 2, { group: 'fib', color: '#9c6ade' }),

  /* Patterns ---------------------------------------------------------- */
  xabcd: draw('xabcd', 'XABCD Pattern', 5, { group: 'patterns', color: '#f0a029' }),
  cypher: draw('cypher', 'Cypher Pattern', 5, { group: 'patterns', color: '#f0a029' }),
  abcd: draw('abcd', 'ABCD Pattern', 4, { group: 'patterns', color: '#f0a029' }),
  trianglePattern: draw('trianglePattern', 'Triangle Pattern', 3, { group: 'patterns', color: '#f0a029' }),
  threeDrives: draw('threeDrives', 'Three Drives Pattern', 5, { group: 'patterns', color: '#f0a029' }),
  headShoulders: draw('headShoulders', 'Head and Shoulders', 5, { group: 'patterns', color: '#f0a029' }),
  elliottImpulse: draw('elliottImpulse', 'Elliott Impulse Wave (12345)', 6, { group: 'patterns', color: '#2962ff' }),
  elliottTriangle: draw('elliottTriangle', 'Elliott Triangle Wave (ABCDE)', 5, { group: 'patterns', color: '#2962ff' }),
  elliottCorrection: draw('elliottCorrection', 'Elliott Correction Wave (ABC)', 3, { group: 'patterns', color: '#2962ff' }),
  elliottDoubleCombo: draw('elliottDoubleCombo', 'Elliott Double Combo Wave (WXY)', 3, { group: 'patterns', color: '#2962ff' }),
  elliottTripleCombo: draw('elliottTripleCombo', 'Elliott Triple Combo Wave (WXYXZ)', 5, { group: 'patterns', color: '#2962ff' }),
  cyclicLines: draw('cyclicLines', 'Cyclic Lines', 2, { group: 'patterns', color: '#787b86' }),
  timeCycles: draw('timeCycles', 'Time Cycles', 2, { group: 'patterns', color: '#787b86' }),
  sineLine: draw('sineLine', 'Sine Line', 2, { group: 'patterns', color: '#2962ff' }),

  /* Forecasting & measurement ----------------------------------------- */
  longPosition: draw('longPosition', 'Long Position', 3, {
    group: 'forecast', color: '#26a69a', position: 'long', accountSize: 10000, riskPercent: 1,
  }),
  shortPosition: draw('shortPosition', 'Short Position', 3, {
    group: 'forecast', color: '#ef5350', position: 'short', accountSize: 10000, riskPercent: 1,
  }),
  positionForecast: draw('positionForecast', 'Position Forecast', 3, {
    group: 'forecast', color: '#2962ff', position: 'forecast', accountSize: 10000, riskPercent: 1,
  }),
  dateRange: draw('dateRange', 'Date Range', 2, { group: 'forecast', color: '#2962ff', fillOpacity: 0.08 }),
  priceRange: draw('priceRange', 'Price Range', 2, { group: 'forecast', color: '#2962ff', fillOpacity: 0.08 }),
  datePriceRange: draw('datePriceRange', 'Date and Price Range', 2, { group: 'forecast', color: '#2962ff', fillOpacity: 0.08 }),
  barsPattern: draw('barsPattern', 'Bars Pattern', 2, { group: 'forecast', color: '#26a69a', fillOpacity: 0.05 }),
  ghostFeed: draw('ghostFeed', 'Ghost Feed', 2, { group: 'forecast', color: '#787b86', fillOpacity: 0.04 }),
  sector: draw('sector', 'Sector', 3, { group: 'forecast', color: '#2962ff', fillOpacity: 0.08 }),
  fixedRangeVolumeProfile: draw('fixedRangeVolumeProfile', 'Fixed Range Volume Profile', 2, {
    group: 'forecast', color: '#2962ff', fillOpacity: 0.16,
  }),
  anchoredVWAP: draw('anchoredVWAP', 'Anchored VWAP', 1, { group: 'forecast', color: '#2962ff' }),
  anchoredVolumeProfile: draw('anchoredVolumeProfile', 'Anchored Volume Profile', 2, {
    group: 'forecast', color: '#2962ff', fillOpacity: 0.16,
  }),

  /* Geometric shapes -------------------------------------------------- */
  brush: draw('brush', 'Brush', 0, { group: 'shapes', color: '#2962ff' }),
  highlighter: draw('highlighter', 'Highlighter', 0, { group: 'shapes', color: '#f0a029', width: 10, fillOpacity: 0.25 }),
  rectangle: draw('rectangle', 'Rectangle', 2, { group: 'shapes', color: '#2962ff', fillOpacity: 0.08 }),
  rotatedRectangle: draw('rotatedRectangle', 'Rotated Rectangle', 3, { group: 'shapes', color: '#2962ff', fillOpacity: 0.08 }),
  circle: draw('circle', 'Circle', 2, { group: 'shapes', color: '#2962ff', fillOpacity: 0.08 }),
  ellipse: draw('ellipse', 'Ellipse', 2, { group: 'shapes', color: '#2962ff', fillOpacity: 0.08 }),
  path: draw('path', 'Path', -1, { group: 'shapes', color: '#2962ff' }),
  polyline: draw('polyline', 'Polyline', -1, { group: 'shapes', color: '#2962ff' }),
  triangleShape: draw('triangleShape', 'Triangle', 3, { group: 'shapes', color: '#2962ff', fillOpacity: 0.08 }),
  arc: draw('arc', 'Arc', 3, { group: 'shapes', color: '#2962ff' }),
  curve: draw('curve', 'Curve', 3, { group: 'shapes', color: '#2962ff' }),
  doubleCurve: draw('doubleCurve', 'Double Curve', 4, { group: 'shapes', color: '#2962ff' }),

  /* Text & annotations ------------------------------------------------ */
  text: draw('text', 'Text', 1, { group: 'text', color: '#d1d4dc', text: 'Text' }),
  note: draw('note', 'Note', 1, { group: 'text', color: '#f0a029', text: 'Note' }),
  anchoredNote: draw('anchoredNote', 'Anchored Note', 1, { group: 'text', color: '#f0a029', text: 'Note' }),
  signpost: draw('signpost', 'Signpost', 1, { group: 'text', color: '#2962ff', text: 'Signpost' }),
  callout: draw('callout', 'Callout', 1, { group: 'text', color: '#2962ff', text: 'Callout' }),
  comment: draw('comment', 'Comment', 1, { group: 'text', color: '#787b86', text: 'Comment' }),
  priceLabel: draw('priceLabel', 'Price Label', 1, { group: 'text', color: '#2962ff' }),
  priceNote: draw('priceNote', 'Price Note', 1, { group: 'text', color: '#2962ff', text: 'Note' }),
  arrowMarker: draw('arrowMarker', 'Arrow Marker', 1, { group: 'text', color: '#2962ff', marker: 'up' }),
  arrowMarkLeft: draw('arrowMarkLeft', 'Arrow Mark Left', 1, { group: 'text', color: '#2962ff', marker: 'left' }),
  arrowMarkRight: draw('arrowMarkRight', 'Arrow Mark Right', 1, { group: 'text', color: '#2962ff', marker: 'right' }),
  arrowMarkUp: draw('arrowMarkUp', 'Arrow Mark Up', 1, { group: 'text', color: '#2962ff', marker: 'up' }),
  arrowMarkDown: draw('arrowMarkDown', 'Arrow Mark Down', 1, { group: 'text', color: '#2962ff', marker: 'down' }),
  flagMark: draw('flagMark', 'Flag Mark', 1, { group: 'text', color: '#2962ff' }),

  /* Icons / stickers -------------------------------------------------- */
  sticker: draw('sticker', 'Icon / Sticker', 1, { group: 'icons', color: '#d1d4dc', emoji: '😀', fontSize: 26 }),

  /* Measurement / navigation ------------------------------------------ */
  measure: { id: 'measure', label: 'Measure', kind: 'measure', anchors: 2, color: '#2962ff' },
  zoom: { id: 'zoom', label: 'Zoom In', kind: 'zoom', anchors: 2, color: '#2962ff' },
};

export const TOOLS = T;

export const TOOL_GROUPS = [
  {
    id: 'cursor',
    label: 'Cursor',
    tools: ['cursorCross', 'cursorDot', 'cursorArrow', 'eraser'],
  },
  {
    id: 'trend',
    label: 'Trend Line Tools',
    tools: ['trend', 'ray', 'info', 'extended', 'trendAngle', 'hline', 'hray', 'vline', 'crossLine', 'arrow',
      'parallelChannel', 'regression', 'flatTopBottom', 'disjointChannel'],
  },
  {
    id: 'fib',
    label: 'Fibonacci & Gann Tools',
    sections: [
      { label: 'Fibonacci', tools: ['fibRetracement', 'fibExtension', 'fibChannel', 'fibTimeZone', 'fibSpeedFan',
        'fibTime', 'fibCircles', 'fibSpiral', 'fibArcs', 'fibWedge'] },
      { label: 'Pitchfork', tools: ['pitchfork', 'pitchforkSchiff', 'pitchforkModifiedSchiff', 'pitchforkInside'] },
      { label: 'Gann', tools: ['gannBox', 'gannSquareFixed', 'gannSquare', 'gannFan'] },
    ],
  },
  {
    id: 'patterns',
    label: 'Patterns',
    tools: ['xabcd', 'cypher', 'abcd', 'trianglePattern', 'threeDrives', 'headShoulders',
      'elliottImpulse', 'elliottTriangle', 'elliottCorrection', 'elliottDoubleCombo', 'elliottTripleCombo',
      'cyclicLines', 'timeCycles', 'sineLine'],
  },
  {
    id: 'forecast',
    label: 'Forecasting & Measurement Tools',
    tools: ['longPosition', 'shortPosition', 'positionForecast', 'dateRange', 'priceRange', 'datePriceRange',
      'barsPattern', 'ghostFeed', 'sector', 'fixedRangeVolumeProfile', 'anchoredVWAP', 'anchoredVolumeProfile'],
  },
  {
    id: 'shapes',
    label: 'Geometric Shapes',
    tools: ['brush', 'highlighter', 'rectangle', 'rotatedRectangle', 'circle', 'ellipse', 'path', 'polyline',
      'triangleShape', 'arc', 'curve', 'doubleCurve'],
  },
  {
    id: 'text',
    label: 'Text & Annotations',
    tools: ['text', 'note', 'anchoredNote', 'signpost', 'callout', 'comment', 'priceLabel', 'priceNote',
      'arrowMarker', 'arrowMarkLeft', 'arrowMarkRight', 'arrowMarkUp', 'arrowMarkDown', 'flagMark'],
  },
  {
    id: 'icons',
    label: 'Icons & Stickers',
    tools: ['sticker'],
  },
];

export const GROUP_BY_ID = Object.fromEntries(TOOL_GROUPS.map((g) => [g.id, g]));

export const TOOL_LIST = Object.values(T);

export const TOOL_BY_ID = Object.fromEntries(TOOL_LIST.map((t) => [t.id, t]));

export const DRAW_TOOL_IDS = TOOL_LIST.filter((t) => t.kind === 'draw').map((t) => t.id);

export function toolDef(id) {
  return TOOL_BY_ID[id] || null;
}

export function groupOf(id) {
  const def = TOOL_BY_ID[id];
  if (!def) return null;
  return def.group || (TOOLS[id]?.kind === 'cursor' ? 'cursor' : null);
}

export function toolsInGroup(groupId) {
  const g = GROUP_BY_ID[groupId];
  if (!g) return [];
  if (g.tools) return g.tools.map((id) => TOOL_BY_ID[id]).filter(Boolean);
  return (g.sections || []).flatMap((s) => s.tools.map((id) => TOOL_BY_ID[id]).filter(Boolean));
}

/** Fibonacci levels shared by the renderer and the property panel. */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
export const FIB_EXT_LEVELS = [0, 0.618, 1, 1.272, 1.618, 2.618];
