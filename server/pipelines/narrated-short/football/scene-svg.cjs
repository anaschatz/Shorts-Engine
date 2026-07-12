const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function visibleAt(operation, frame) {
  const start = Number.isInteger(operation.startFrame) ? operation.startFrame : 0;
  const end = Number.isInteger(operation.endFrame) ? operation.endFrame : Number.POSITIVE_INFINITY;
  return frame >= start && frame <= end;
}

function arrow(from, to, color, dashed = false) {
  return `<line x1="${from[0]}" y1="${from[1]}" x2="${to[0]}" y2="${to[1]}" stroke="${color}" stroke-width="10" ${dashed ? 'stroke-dasharray="20 14"' : ""} marker-end="url(#arrow)" stroke-linecap="round"/>`;
}

function renderPitchOperations(scene, frame, pitch) {
  const nodes = [];
  const point = ([x, y]) => [pitch.x + x * pitch.width, pitch.y + y * pitch.height];
  for (const operation of scene.operations || []) {
    if (!visibleAt(operation, frame)) continue;
    if (operation.op === "place_player" || operation.op === "place_ball") {
      const [x, y] = point([operation.x, operation.y]);
      if (operation.op === "place_ball") {
        nodes.push(`<circle cx="${x}" cy="${y}" r="12" fill="#f8fafc" stroke="#111827" stroke-width="4"/>`);
      } else {
        const color = operation.team === "defend" ? "#fb7185" : operation.team === "neutral" ? "#facc15" : "#38bdf8";
        nodes.push(`<circle cx="${x}" cy="${y}" r="30" fill="${color}" stroke="#f8fafc" stroke-width="5"/>`);
        nodes.push(`<text x="${x}" y="${y + 8}" text-anchor="middle" font-size="24" font-weight="800" fill="#07120e">${escapeXml(operation.id || "")}</text>`);
      }
    } else if (["draw_run", "draw_press", "pass", "carry", "move_player"].includes(operation.op) && operation.from && operation.to) {
      const colors = { draw_press: "#fb7185", pass: "#f8fafc", carry: "#facc15", move_player: "#38bdf8" };
      nodes.push(arrow(point(operation.from), point(operation.to), colors[operation.op] || "#38bdf8", operation.op === "draw_run"));
    } else if (operation.op === "highlight_zone") {
      const left = operation.side !== "right";
      const x = pitch.x + pitch.width * (left ? 0.15 : 0.55);
      nodes.push(`<rect x="${x}" y="${pitch.y + pitch.height * 0.12}" width="${pitch.width * 0.3}" height="${pitch.height * 0.76}" rx="28" fill="#facc15" opacity="0.18" stroke="#facc15" stroke-width="4"/>`);
    } else if (operation.op === "label" && operation.text) {
      nodes.push(`<text x="${pitch.x + pitch.width / 2}" y="${pitch.y + 80}" text-anchor="middle" font-size="42" font-weight="800" fill="#f8fafc">${escapeXml(operation.text)}</text>`);
    }
  }
  return nodes.join("");
}

function renderSceneSvg(scene = {}, options = {}) {
  const width = Number(options.width || 1080);
  const height = Number(options.height || 1920);
  const frame = Math.max(0, Number(options.frame || 0));
  const title = escapeXml(options.title || "FOOTBALL EXPLAINED");
  const text = escapeXml(options.text || "");
  if (![720, 1080].includes(width) || ![1280, 1920].includes(height)) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "dimensions" });
  }
  const scale = width / 1080;
  const pitch = { x: 90 * scale, y: 400 * scale, width: 900 * scale, height: 1120 * scale };
  const common = `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="context-stroke"/></marker></defs>`;
  const background = `<rect width="100%" height="100%" fill="#07120e"/><circle cx="${width * 0.82}" cy="${height * 0.12}" r="${width * 0.36}" fill="#123c2c" opacity="0.55"/>`;
  const header = `<text x="${width / 2}" y="${120 * scale}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${34 * scale}" font-weight="800" letter-spacing="${5 * scale}" fill="#38bdf8">${title}</text>`;
  let body = "";
  if (["pitch_tactical_sequence", "formation_compare"].includes(scene.template)) {
    body = `<g><rect x="${pitch.x}" y="${pitch.y}" width="${pitch.width}" height="${pitch.height}" rx="${40 * scale}" fill="#0f5132" stroke="#d1fae5" stroke-width="${8 * scale}"/><line x1="${pitch.x}" y1="${pitch.y + pitch.height / 2}" x2="${pitch.x + pitch.width}" y2="${pitch.y + pitch.height / 2}" stroke="#d1fae5" stroke-width="${6 * scale}"/><circle cx="${pitch.x + pitch.width / 2}" cy="${pitch.y + pitch.height / 2}" r="${110 * scale}" fill="none" stroke="#d1fae5" stroke-width="${6 * scale}"/>${renderPitchOperations(scene, frame, pitch)}</g>`;
  } else {
    body = `<rect x="${80 * scale}" y="${430 * scale}" width="${920 * scale}" height="${720 * scale}" rx="${54 * scale}" fill="#0d2a20" stroke="#38bdf8" stroke-width="${5 * scale}"/><text x="${width / 2}" y="${700 * scale}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${70 * scale}" font-weight="900" fill="#f8fafc"><tspan x="${width / 2}" dy="0">${text}</tspan></text>`;
  }
  const footer = scene.reconstructionMode === "illustrative" ? `<text x="${width / 2}" y="${height - 85 * scale}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${26 * scale}" fill="#a7f3d0">ILLUSTRATIVE TACTICAL DIAGRAM</text>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${common}${background}${header}${body}${footer}</svg>`;
}

function planSceneKeyframes(scene = {}) {
  const duration = Math.max(1, Number(scene.endFrame || 1) - Number(scene.startFrame || 0));
  const candidates = [0, duration - 1];
  for (const operation of scene.operations || []) {
    if (Number.isInteger(operation.startFrame)) candidates.push(operation.startFrame);
    if (Number.isInteger(operation.endFrame)) candidates.push(Math.max(0, operation.endFrame - 1));
  }
  const sorted = [...new Set(candidates.map((frame) => Math.max(0, Math.min(duration - 1, frame))))].sort((a, b) => a - b);
  if (sorted.length <= 3) return sorted;
  return [sorted[0], sorted[Math.floor((sorted.length - 1) / 2)], sorted[sorted.length - 1]];
}

module.exports = {
  escapeXml,
  planSceneKeyframes,
  renderSceneSvg,
};
