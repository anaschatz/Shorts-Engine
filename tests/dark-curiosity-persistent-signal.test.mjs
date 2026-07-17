import test from "node:test";
import assert from "node:assert/strict";

import {
  PERSISTENT_SIGNAL_GEOMETRY_TOKENS,
  PERSISTENT_SIGNAL_POINT_COUNT,
  interpolatePersistentSignal,
  persistentSignalGeometry,
  persistentSignalPath,
  persistentSignalPoint,
} from "../renderer/hyperframes/primitives/persistent-signal.mjs";

test("persistent signal uses five deterministic compatible geometries", () => {
  const geometries = PERSISTENT_SIGNAL_GEOMETRY_TOKENS.map((token) => persistentSignalGeometry(token));
  assert.equal(geometries.length, 5);
  assert.equal(new Set(geometries.map(persistentSignalPath)).size, 5);
  for (const geometry of geometries) {
    assert.equal(geometry.length, PERSISTENT_SIGNAL_POINT_COUNT);
    assert.equal(Object.isFrozen(geometry), true);
    assert.ok(geometry.every((point) => Object.isFrozen(point) && Number.isFinite(point.x) && Number.isFinite(point.y)));
    assert.equal((persistentSignalPath(geometry).match(/[ML]/g) || []).length, PERSISTENT_SIGNAL_POINT_COUNT);
  }
});

test("matched interpolation preserves endpoints, identity, and backward-seek determinism", () => {
  const from = persistentSignalGeometry("observation_spike_v1");
  const to = persistentSignalGeometry("frequency_cursor_v1");
  assert.deepEqual(interpolatePersistentSignal(from, to, 0), from);
  assert.deepEqual(interpolatePersistentSignal(from, to, 1), to);
  const midpoint = interpolatePersistentSignal(from, to, 0.5);
  assert.notDeepEqual(midpoint, from);
  assert.notDeepEqual(midpoint, to);
  assert.deepEqual(midpoint, interpolatePersistentSignal(from, to, 0.5));
  const firstBackwardProbe = interpolatePersistentSignal(from, to, 0.23);
  interpolatePersistentSignal(from, to, 0.91);
  const secondBackwardProbe = interpolatePersistentSignal(from, to, 0.23);
  assert.deepEqual(firstBackwardProbe, secondBackwardProbe);
  const marker = persistentSignalPoint(midpoint, 0.37);
  const scaled = 0.37 * (midpoint.length - 1);
  const index = Math.floor(scaled);
  const local = scaled - index;
  assert.equal(marker.x, Number((midpoint[index].x + (midpoint[index + 1].x - midpoint[index].x) * local).toFixed(3)));
  assert.equal(marker.y, Number((midpoint[index].y + (midpoint[index + 1].y - midpoint[index].y) * local).toFixed(3)));
});

test("persistent signal primitives reject incompatible or non-finite geometry", () => {
  const points = persistentSignalGeometry("beam_response_v1");
  assert.throws(() => persistentSignalGeometry("remote_shape_v1"), TypeError);
  assert.throws(() => persistentSignalGeometry("beam_response_v1", 127), TypeError);
  assert.throws(() => interpolatePersistentSignal(points.slice(1), points, 0.5), TypeError);
  assert.throws(() => interpolatePersistentSignal(points, points, Number.NaN), TypeError);
  assert.throws(() => interpolatePersistentSignal([{ x: Number.NaN, y: 1 }, ...points.slice(1)], points, 0.5), TypeError);
  assert.throws(() => persistentSignalPath(points.slice(1)), TypeError);
  assert.throws(() => persistentSignalPoint([{ x: 1, y: undefined }, ...points.slice(1)], 0.5), TypeError);
  assert.throws(() => persistentSignalPoint(points, Number.POSITIVE_INFINITY), TypeError);
});
