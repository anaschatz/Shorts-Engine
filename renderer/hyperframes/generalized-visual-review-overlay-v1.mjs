function finite(value) {
  if (!Number.isFinite(value)) throw new TypeError("Review overlay coordinate is invalid.");
  return Number(value.toFixed(3));
}

function bounds(value) {
  if (!value || [value.x, value.y, value.width, value.height].some((entry) => !Number.isFinite(entry))) {
    throw new TypeError("Review overlay bounds are invalid.");
  }
  return Object.freeze({
    x: finite(value.x),
    y: finite(value.y),
    width: finite(value.width),
    height: finite(value.height),
  });
}

export function createGeneralizedVisualReviewOverlay(scene) {
  const primary = bounds(scene.layout.primary.bounds);
  const helper = scene.layout.helper ? bounds(scene.layout.helper.bounds) : null;
  const captionLane = bounds(scene.layout.regions.captionLane);
  return Object.freeze({
    primary,
    helper,
    captionLane,
    focalCenter: Object.freeze({
      x: finite(primary.x + primary.width / 2),
      y: finite(primary.y + primary.height / 2),
    }),
  });
}
