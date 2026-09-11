// Starter parcels. Coordinates in feet, origin at the parcel's lower-left.

export const PRESETS = [
  {
    key: 'rect',
    name: 'Rectangular infill · 5.0 ac',
    frontageEdge: 0,
    polygon: [
      { x: 0, y: 0 }, { x: 440, y: 0 }, { x: 440, y: 495 }, { x: 0, y: 495 },
    ],
  },
  {
    key: 'corner',
    name: 'Corner lot · 3.3 ac',
    frontageEdge: 0,
    polygon: [
      { x: 0, y: 0 }, { x: 420, y: 0 }, { x: 420, y: 250 },
      { x: 250, y: 250 }, { x: 250, y: 400 }, { x: 0, y: 400 },
    ],
  },
  {
    key: 'deep',
    name: 'Deep frontage lot · 8.4 ac',
    frontageEdge: 0,
    polygon: [
      { x: 0, y: 0 }, { x: 520, y: 0 }, { x: 560, y: 300 },
      { x: 500, y: 730 }, { x: 40, y: 700 },
    ],
  },
  {
    key: 'flag',
    name: 'Irregular / flag lot · 7.0 ac',
    frontageEdge: 0,
    polygon: [
      { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 180 },
      { x: 640, y: 180 }, { x: 660, y: 640 }, { x: 120, y: 600 }, { x: 0, y: 320 },
    ],
  },
  {
    key: 'industrial',
    name: 'Industrial pad · 21.0 ac',
    frontageEdge: 0,
    polygon: [
      { x: 0, y: 0 }, { x: 1100, y: 0 }, { x: 1100, y: 830 }, { x: 0, y: 830 },
    ],
  },
];

export function rectangleParcel(widthFt, depthFt) {
  return [
    { x: 0, y: 0 },
    { x: widthFt, y: 0 },
    { x: widthFt, y: depthFt },
    { x: 0, y: depthFt },
  ];
}

// Rectangle of a target acreage at a given frontage-to-depth ratio.
export function parcelFromAcres(acres, ratio = 0.85) {
  const sqft = acres * 43560;
  const w = Math.sqrt(sqft * ratio);
  return rectangleParcel(Math.round(w), Math.round(sqft / w));
}
