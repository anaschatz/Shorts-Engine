const MORPH_POINT_COUNT = 128;

function point(value, index) {
  if (!value || typeof value !== "object" || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError(`Invalid morph point at ${index}.`);
  return { x: Number(value.x), y: Number(value.y) };
}

export function resamplePolyline(input, count = MORPH_POINT_COUNT) {
  if (!Array.isArray(input) || input.length < 2 || !Number.isInteger(count) || count < 2 || count > 512) throw new TypeError("Morph polyline is invalid.");
  const points = input.map(point);
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1] + Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y));
  const total = cumulative[cumulative.length - 1];
  if (!Number.isFinite(total) || total <= 0) throw new TypeError("Morph polyline has zero length.");
  const output = [];
  for (let sample = 0; sample < count; sample += 1) {
    const distance = total * sample / (count - 1);
    let segment = 1;
    while (segment < cumulative.length - 1 && cumulative[segment] < distance) segment += 1;
    const startDistance = cumulative[segment - 1], segmentLength = cumulative[segment] - startDistance;
    const progress = segmentLength > 0 ? (distance - startDistance) / segmentLength : 0;
    output.push({ x: points[segment - 1].x + (points[segment].x - points[segment - 1].x) * progress, y: points[segment - 1].y + (points[segment].y - points[segment - 1].y) * progress });
  }
  return output;
}

export function waveformMorphPoints(count = MORPH_POINT_COUNT) {
  const source = [];
  for (let x = 70; x <= 650; x += 4) {
    const envelope = Math.exp(-Math.pow((x - 360) / 175, 2));
    source.push({ x, y: 515 + Math.sin(x * 0.12) * 112 * envelope + Math.sin(x * 0.031) * 17 });
  }
  return resamplePolyline(source, count);
}

export function nodeMorphPoints(count = MORPH_POINT_COUNT) {
  const target = [];
  for (let index = 0; index < count; index += 1) {
    const angle = Math.PI + Math.PI * 2 * index / (count - 1);
    target.push({ x: 360 + Math.cos(angle) * 110, y: 515 + Math.sin(angle) * 110 });
  }
  return target;
}

export function interpolatePoints(fromInput, toInput, progress) {
  if (!Array.isArray(fromInput) || !Array.isArray(toInput) || fromInput.length !== toInput.length || fromInput.length < 2 || !Number.isFinite(progress) || progress < 0 || progress > 1) throw new TypeError("Morph interpolation is invalid.");
  const from = fromInput.map(point), to = toInput.map(point);
  return from.map((value, index) => ({ x: value.x + (to[index].x - value.x) * progress, y: value.y + (to[index].y - value.y) * progress }));
}

export function pointsToPath(input) {
  if (!Array.isArray(input) || input.length < 2) throw new TypeError("Morph path is invalid.");
  return input.map((value, index) => { const checked = point(value, index); return `${index ? "L" : "M"}${checked.x.toFixed(3)} ${checked.y.toFixed(3)}`; }).join(" ");
}

export function createPathMorph(pointCount = MORPH_POINT_COUNT) {
  const source = waveformMorphPoints(pointCount), target = nodeMorphPoints(pointCount);
  return Object.freeze({ pointCount, source, target, pathAt(progress) { return pointsToPath(interpolatePoints(source, target, progress)); } });
}

export { MORPH_POINT_COUNT };
