import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Embeds QWeather daytime outline icons into every style's style.css (between the BEGIN/END markers).
// Source: `package/icons/*.svg` from `npm pack qweather-icons` if present, otherwise the icons already
// vendored in ../weather-qweather/styles/default/style.css.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "package", "icons");
const siblingCss = join(root, "..", "weather-qweather", "styles", "default", "style.css");
const targets = ["default", "list"].map((style) => join(root, "styles", style, "style.css"));

const BEGIN = "/* BEGIN QWEATHER ICONS */";
const END = "/* END QWEATHER ICONS */";

// Keep in sync with KNOWN_WEATHER_ICONS in data.ts. Night variants are omitted: iconDay never uses them.
const codes = [
  100, 101, 102, 103, 104,
  300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 399,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 499,
  500, 501, 502, 503, 504, 507, 508, 509, 510, 511, 512, 513, 514, 515,
  900, 901, 999,
];

const siblingIcons = new Map();
if (!existsSync(iconsDir) && existsSync(siblingCss)) {
  const css = readFileSync(siblingCss, "utf8");
  for (const match of css.matchAll(/\.qi-(\d+)\{background-image:url\("data:image\/svg\+xml,([^"]+)"\)\}/g)) {
    siblingIcons.set(Number(match[1]), decodeURIComponent(match[2]));
  }
}

function readIcon(code) {
  const path = join(iconsDir, `${code}.svg`);
  if (existsSync(path)) return readFileSync(path, "utf8");
  return siblingIcons.get(code);
}

/** Minimal, CSS-safe SVG data URI (much smaller than encodeURIComponent). */
function svgDataUri(svg) {
  const compact = svg
    .trim()
    .replace(/fill="currentColor"/gi, 'fill="#000000"')
    .replace(/stroke="currentColor"/gi, 'stroke="#000000"')
    .replace(/\s+class="[^"]*"/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
  return `data:image/svg+xml,${compact}`;
}

const lines = [
  BEGIN,
  "/* QWeather Icons (MIT) — vendored outline SVGs as data-URI backgrounds for e-ink */",
  ".qw-icon{display:inline-block;flex:0 0 auto;background-color:transparent;background-repeat:no-repeat;background-position:center;background-size:contain}",
];
const missing = [];
for (const code of codes) {
  const svg = readIcon(code);
  if (!svg) {
    missing.push(code);
    continue;
  }
  lines.push(`.qi-${code}{background-image:url("${svgDataUri(svg)}")}`);
}
lines.push(END);
const iconsBlock = `${lines.join("\n")}\n`;

for (const target of targets) {
  const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
  const beginAt = existing.indexOf(BEGIN);
  const layout = (beginAt >= 0 ? existing.slice(0, beginAt) : existing).trimEnd();
  writeFileSync(target, `${layout}\n\n${iconsBlock}`);
}
console.log(JSON.stringify({ targets, count: codes.length - missing.length, missing, bytes: Buffer.byteLength(iconsBlock) }));
if (missing.length) process.exitCode = 1;
