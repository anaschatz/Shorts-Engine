const { createHash } = require("node:crypto");
const { AppError, SAFE_MESSAGES } = require("../../../errors.cjs");

const BASE_WIDTH = 1080;
const BASE_HEIGHT = 1920;

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function operationRange(operation, scene) {
  const duration = Math.max(1, Number(scene.durationFrames || scene.endFrame || 1) - Number(scene.startFrame || 0));
  const start = Number.isInteger(operation.startFrame) ? operation.startFrame : 0;
  const end = Number.isInteger(operation.endFrame) ? operation.endFrame : duration;
  return { start, end: Math.max(start + 1, end) };
}

function operationState(operation, frame, scene) {
  const { start, end } = operationRange(operation, scene);
  const visible = frame >= start && frame <= end;
  return { visible, progress: clamp((frame - start) / Math.max(1, end - start)) };
}

function hashPoint(value, bounds) {
  const digest = createHash("sha256").update(String(value || "node")).digest();
  return [
    bounds.x + (digest[0] / 255) * bounds.width,
    bounds.y + (digest[1] / 255) * bounds.height,
  ];
}

function wrapLines(value, maxChars = 26, maxLines = 4) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  if (lines.length <= maxLines) return lines;
  const limited = lines.slice(0, maxLines);
  limited[maxLines - 1] = `${limited[maxLines - 1].slice(0, Math.max(1, maxChars - 1))}…`;
  return limited;
}

function multilineText(value, x, y, options = {}) {
  const lines = wrapLines(value, options.maxChars || 26, options.maxLines || 4);
  const fontSize = Number(options.fontSize || 64);
  const lineHeight = Number(options.lineHeight || fontSize * 1.12);
  const anchor = options.anchor || "middle";
  const weight = options.weight || 800;
  const fill = options.fill || "#f8fafc";
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;
}

function visibleOperations(scene, frame) {
  return (scene.operations || []).map((operation, index) => ({ operation, index, state: operationState(operation, frame, scene) }))
    .filter((entry) => entry.state.visible);
}

function cameraScale(entries) {
  const camera = entries.find((entry) => entry.operation.op === "camera_push");
  if (!camera) return 1;
  return 1 + (Number(camera.operation.scale || 1) - 1) * camera.state.progress;
}

function renderHeadingOperations(entries, fallback, y = 360) {
  const heading = entries.find((entry) => entry.operation.op === "set_heading");
  return multilineText(heading ? heading.operation.text : fallback, 540, y, { fontSize: 82, maxChars: 22, maxLines: 3, weight: 900 });
}

function renderEvidenceOperations(entries, context) {
  const evidence = entries.filter((entry) => entry.operation.op === "show_evidence");
  const badges = entries.filter((entry) => entry.operation.op === "show_source_badge");
  const claimById = new Map(((context.claimLedger && context.claimLedger.claims) || []).map((claim) => [claim.id, claim]));
  const sourceById = new Map(((context.claimLedger && context.claimLedger.sources) || []).map((source) => [source.id, source]));
  const cards = evidence.map((entry, index) => {
    const claim = claimById.get(entry.operation.claimId);
    const copy = entry.operation.text || (claim && claim.text) || "Approved evidence";
    const y = 490 + index * 300;
    const opacity = (0.55 + entry.state.progress * 0.45).toFixed(3);
    return `<g data-op="show_evidence" opacity="${opacity}"><rect x="110" y="${y}" width="860" height="240" rx="34" fill="#111b35" stroke="#60a5fa" stroke-width="4"/><circle cx="165" cy="${y + 62}" r="22" fill="#60a5fa"/><text x="215" y="${y + 72}" font-family="Arial, sans-serif" font-size="28" font-weight="800" fill="#93c5fd">EVIDENCE ${index + 1}</text>${multilineText(copy, 540, y + 130, { fontSize: 42, maxChars: 34, maxLines: 2 })}</g>`;
  }).join("");
  const badgeNodes = badges.map((entry, index) => {
    const source = sourceById.get(entry.operation.sourceId);
    const label = entry.operation.text || (source && source.sourceClass) || "verified source";
    return `<g data-op="show_source_badge"><rect x="${120 + index * 330}" y="1370" width="300" height="72" rx="36" fill="#172554" stroke="#a5b4fc" stroke-width="3"/><text x="${270 + index * 330}" y="1417" text-anchor="middle" font-family="Arial, sans-serif" font-size="24" font-weight="700" fill="#e0e7ff">${escapeXml(label.toUpperCase())}</text></g>`;
  }).join("");
  return cards + badgeNodes;
}

function renderMapTimelineOperations(entries) {
  const area = { x: 130, y: 470, width: 820, height: 900 };
  const nodes = [];
  nodes.push(`<line x1="180" y1="920" x2="900" y2="920" stroke="#334155" stroke-width="16" stroke-linecap="round"/>`);
  for (const entry of entries) {
    const operation = entry.operation;
    if (operation.op === "place_marker") {
      const x = area.x + operation.x * area.width;
      const y = area.y + operation.y * area.height;
      nodes.push(`<g data-op="place_marker" opacity="${entry.state.progress.toFixed(3)}"><circle cx="${x}" cy="${y}" r="30" fill="#fbbf24"/><circle cx="${x}" cy="${y}" r="56" fill="none" stroke="#fbbf24" stroke-width="5" opacity="0.35"/>${multilineText(operation.label || operation.id, x, y + 92, { fontSize: 28, maxChars: 18, maxLines: 2 })}</g>`);
    } else if (operation.op === "draw_route") {
      const points = operation.points.map(([x, y]) => `${area.x + x * area.width},${area.y + y * area.height}`);
      nodes.push(`<polyline data-op="draw_route" points="${points.join(" ")}" fill="none" stroke="#22d3ee" stroke-width="12" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="${entry.state.progress} 1"/>`);
    } else if (operation.op === "advance_timeline") {
      const x = 180 + 720 * entry.state.progress;
      nodes.push(`<g data-op="advance_timeline"><line x1="180" y1="920" x2="${x}" y2="920" stroke="#22d3ee" stroke-width="16" stroke-linecap="round"/><circle cx="${x}" cy="920" r="28" fill="#f8fafc"/><text x="540" y="790" text-anchor="middle" font-family="Arial, sans-serif" font-size="46" font-weight="900" fill="#67e8f9">${escapeXml(operation.date)}</text>${multilineText(operation.label, 540, 1015, { fontSize: 46, maxChars: 30, maxLines: 2 })}</g>`);
    } else if (operation.op === "reveal_layer") {
      const y = 520 + (operation.layer - 1) * 90;
      nodes.push(`<g data-op="reveal_layer" opacity="${entry.state.progress.toFixed(3)}"><path d="M150 ${y} L930 ${y} L850 ${y + 72} L230 ${y + 72} Z" fill="#1e293b" stroke="#a78bfa" stroke-width="3"/>${multilineText(operation.text, 540, y + 48, { fontSize: 30, maxChars: 36, maxLines: 1 })}</g>`);
    }
  }
  return nodes.join("");
}

function renderSystemScaleOperations(entries) {
  const bounds = { x: 180, y: 520, width: 720, height: 720 };
  const nodes = [];
  for (const entry of entries) {
    const operation = entry.operation;
    if (operation.op === "connect_nodes") {
      const from = hashPoint(operation.fromId, bounds);
      const to = hashPoint(operation.toId, bounds);
      const endX = from[0] + (to[0] - from[0]) * entry.state.progress;
      const endY = from[1] + (to[1] - from[1]) * entry.state.progress;
      nodes.push(`<g data-op="connect_nodes"><line x1="${from[0]}" y1="${from[1]}" x2="${endX}" y2="${endY}" stroke="#c084fc" stroke-width="10" marker-end="url(#dc-arrow)"/><circle cx="${from[0]}" cy="${from[1]}" r="48" fill="#312e81" stroke="#c4b5fd" stroke-width="4"/><circle cx="${to[0]}" cy="${to[1]}" r="48" fill="#164e63" stroke="#67e8f9" stroke-width="4"/>${multilineText(operation.label || "connection", 540, 1320, { fontSize: 38, maxChars: 32, maxLines: 2 })}</g>`);
    } else if (operation.op === "compare_scale") {
      const max = Math.max(Math.abs(operation.leftValue), Math.abs(operation.rightValue), 1);
      const leftHeight = 520 * Math.abs(operation.leftValue) / max * entry.state.progress;
      const rightHeight = 520 * Math.abs(operation.rightValue) / max * entry.state.progress;
      nodes.push(`<g data-op="compare_scale"><rect x="220" y="${1200 - leftHeight}" width="240" height="${leftHeight}" rx="24" fill="#38bdf8"/><rect x="620" y="${1200 - rightHeight}" width="240" height="${rightHeight}" rx="24" fill="#a78bfa"/>${multilineText(operation.leftLabel, 340, 1280, { fontSize: 30, maxChars: 16, maxLines: 2 })}${multilineText(operation.rightLabel, 740, 1280, { fontSize: 30, maxChars: 16, maxLines: 2 })}</g>`);
    } else if (operation.op === "highlight_region") {
      nodes.push(`<rect data-op="highlight_region" x="${operation.x * BASE_WIDTH}" y="${operation.y * BASE_HEIGHT}" width="${operation.width * BASE_WIDTH}" height="${operation.height * BASE_HEIGHT}" rx="30" fill="#f43f5e" opacity="${(0.08 + entry.state.progress * 0.18).toFixed(3)}" stroke="#fb7185" stroke-width="6"/>`);
    }
  }
  return nodes.join("");
}

function renderPayoffOperations(entries, fallback) {
  const heading = entries.find((entry) => entry.operation.op === "set_heading");
  const uncertainty = entries.find((entry) => entry.operation.op === "show_uncertainty");
  const copy = heading ? heading.operation.text : fallback;
  return `<path d="M110 560 Q540 350 970 560 V1280 Q540 1510 110 1280 Z" fill="#0f172a" stroke="#fbbf24" stroke-width="6"/>${multilineText(copy, 540, 760, { fontSize: 78, maxChars: 22, maxLines: 3, fill: "#fef3c7", weight: 900 })}${uncertainty ? `<g data-op="show_uncertainty" opacity="${uncertainty.state.progress.toFixed(3)}"><rect x="250" y="1210" width="580" height="100" rx="50" fill="#422006" stroke="#fbbf24" stroke-width="4"/><text x="540" y="1274" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="800" fill="#fde68a">${escapeXml(uncertainty.operation.text)}</text></g>` : ""}`;
}

function sceneBody(scene, entries, options) {
  const fallback = options.text || options.title || "DARK CURIOSITY";
  if (scene.template === "hook_scene") {
    return `<g data-family="hook"><circle cx="540" cy="850" r="310" fill="none" stroke="#22d3ee" stroke-width="8" opacity="0.3"/><path d="M180 850 C300 620 420 1080 540 850 C660 620 780 1080 900 850" fill="none" stroke="#67e8f9" stroke-width="18" stroke-linecap="round"/>${renderHeadingOperations(entries, fallback, 340)}</g>`;
  }
  if (scene.template === "evidence_scene") return `<g data-family="evidence">${renderHeadingOperations([], "WHAT THE EVIDENCE SAYS", 300)}${renderEvidenceOperations(entries, options)}</g>`;
  if (scene.template === "map_timeline_scene") return `<g data-family="map-timeline">${renderHeadingOperations([], "TRACE THE CLUE", 300)}${renderMapTimelineOperations(entries)}</g>`;
  if (scene.template === "system_scale_scene") return `<g data-family="system-scale">${renderHeadingOperations([], "HOW IT CONNECTS", 300)}${renderSystemScaleOperations(entries)}</g>`;
  if (scene.template === "payoff_scene") return `<g data-family="payoff">${renderPayoffOperations(entries, fallback)}</g>`;
  throw new AppError("SCENE_TEMPLATE_MISMATCH", "Dark Curiosity scene template is unsupported.", 400, { template: scene.template });
}

function renderDarkCuriositySceneSvg(scene = {}, options = {}) {
  const width = Number(options.width || BASE_WIDTH);
  const height = Number(options.height || BASE_HEIGHT);
  if (![720, 1080].includes(width) || ![1280, 1920].includes(height) || height / width !== 16 / 9) {
    throw new AppError("VALIDATION_ERROR", SAFE_MESSAGES.VALIDATION_ERROR, 400, { field: "dimensions" });
  }
  const frame = Math.max(0, Math.floor(Number(options.frame || 0)));
  const entries = visibleOperations(scene, frame);
  const zoom = cameraScale(entries);
  const fade = entries.find((entry) => entry.operation.op === "fade_or_blackout");
  const fadeOpacity = fade ? (fade.operation.mode === "blackout" ? fade.state.progress : 1 - fade.state.progress) : 0;
  const disclosure = scene.visualMode === "illustrative_reconstruction" && scene.disclosure
    ? `<text x="540" y="1810" text-anchor="middle" font-family="Arial, sans-serif" font-size="25" font-weight="700" letter-spacing="2" fill="#94a3b8">${escapeXml(scene.disclosure.toUpperCase())}</text>`
    : "";
  const body = sceneBody(scene, entries, {
    ...options,
    claimLedger: options.draftBundle && options.draftBundle.claimLedger,
  });
  const scale = width / BASE_WIDTH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-vertical="dark_curiosity" data-template="${escapeXml(scene.template)}"><defs><linearGradient id="dc-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#020617"/><stop offset="1" stop-color="#172554"/></linearGradient><marker id="dc-arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#c084fc"/></marker></defs><g transform="scale(${scale})"><rect width="${BASE_WIDTH}" height="${BASE_HEIGHT}" fill="url(#dc-bg)"/><circle cx="940" cy="180" r="330" fill="#312e81" opacity="0.22"/><text x="540" y="120" text-anchor="middle" font-family="Arial, sans-serif" font-size="27" font-weight="800" letter-spacing="7" fill="#67e8f9">DARK CURIOSITY</text><g transform="translate(${540 * (1 - zoom)} ${960 * (1 - zoom)}) scale(${zoom})">${body}</g>${disclosure}${fade ? `<rect data-op="fade_or_blackout" width="${BASE_WIDTH}" height="${BASE_HEIGHT}" fill="#000" opacity="${clamp(fadeOpacity).toFixed(3)}"/>` : ""}</g></svg>`;
}

function planDarkCuriosityKeyframes(scene = {}) {
  const duration = Math.max(1, Number(scene.endFrame || scene.durationFrames || 1) - Number(scene.startFrame || 0));
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
  planDarkCuriosityKeyframes,
  renderDarkCuriositySceneSvg,
};
