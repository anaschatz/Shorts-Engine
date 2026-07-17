export const PERSISTENT_SIGNAL_POINT_COUNT = 128;
export const PERSISTENT_SIGNAL_GEOMETRY_TOKENS = Object.freeze([
  "observation_spike_v1",
  "frequency_cursor_v1",
  "beam_response_v1",
  "timeline_spike_v1",
  "candidate_boundary_v1",
]);

const rounded = (value) => Number(value.toFixed(3));
const gaussian = (value, center, spread) => Math.exp(-(((value - center) / spread) ** 2));
const validPoints = (points) => Array.isArray(points) && points.length === PERSISTENT_SIGNAL_POINT_COUNT && points.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y));

function pointFor(token, progress) {
  if (token === "observation_spike_v1") return { x: 112 + 496 * progress, y: 625 - 265 * gaussian(progress, 0.5, 0.045) };
  if (token === "frequency_cursor_v1") return { x: 100 + 520 * progress, y: 455 - 165 * gaussian(progress, 0.5, 0.034) };
  if (token === "beam_response_v1") return { x: 120 + 490 * progress, y: 720 - 160 * Math.sin(Math.PI * progress) ** 2 };
  if (token === "timeline_spike_v1") return { x: 104 + 512 * progress, y: 545 - 160 * gaussian(progress, 0.07, 0.027) };
  if (token === "candidate_boundary_v1") {
    const angle = (140 + 260 * progress) * Math.PI / 180;
    return { x: 360 + 154 * Math.cos(angle), y: 610 + 154 * Math.sin(angle) };
  }
  throw new TypeError("Persistent signal geometry token is unsupported.");
}

export function persistentSignalGeometry(token, pointCount = PERSISTENT_SIGNAL_POINT_COUNT) {
  if (!PERSISTENT_SIGNAL_GEOMETRY_TOKENS.includes(token) || pointCount !== PERSISTENT_SIGNAL_POINT_COUNT) throw new TypeError("Persistent signal geometry request is invalid.");
  return Object.freeze(Array.from({ length: pointCount }, (_, index) => {
    const point = pointFor(token, index / (pointCount - 1));
    return Object.freeze({ x: rounded(point.x), y: rounded(point.y) });
  }));
}

export function interpolatePersistentSignal(from, to, progress) {
  if (!validPoints(from) || !validPoints(to) || !Number.isFinite(progress)) throw new TypeError("Persistent signal interpolation is invalid.");
  const bounded = Math.max(0, Math.min(1, progress));
  return Object.freeze(from.map((point, index) => Object.freeze({
    x: rounded(point.x + (to[index].x - point.x) * bounded),
    y: rounded(point.y + (to[index].y - point.y) * bounded),
  })));
}

export function persistentSignalPath(points) {
  if (!Array.isArray(points) || points.length !== PERSISTENT_SIGNAL_POINT_COUNT || points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) throw new TypeError("Persistent signal path is invalid.");
  return points.map((point, index) => `${index ? "L" : "M"}${rounded(point.x)} ${rounded(point.y)}`).join(" ");
}

export function persistentSignalPoint(points, progress) {
  if (!validPoints(points) || !Number.isFinite(progress)) throw new TypeError("Persistent signal marker progress is invalid.");
  const bounded = Math.max(0, Math.min(1, progress)) * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(bounded));
  const local = bounded - index;
  return Object.freeze({
    x: rounded(points[index].x + (points[index + 1].x - points[index].x) * local),
    y: rounded(points[index].y + (points[index + 1].y - points[index].y) * local),
  });
}
