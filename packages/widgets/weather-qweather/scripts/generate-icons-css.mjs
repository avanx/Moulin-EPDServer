import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(root, "package", "icons");
const styleCssPath = join(root, "styles", "default", "style.css");

const BEGIN = "/* BEGIN QWEATHER ICONS */";
const END = "/* END QWEATHER ICONS */";

const codes = [
  100, 101, 102, 103, 104, 150, 151, 152, 153,
  300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 318, 350, 351, 399,
  400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 456, 457, 499,
  500, 501, 502, 503, 504, 507, 508, 509, 510, 511, 512, 513, 514, 515,
  900, 901, 999,
];

const lines = [
  BEGIN,
  "/* QWeather Icons (MIT) — vendored outline SVGs as data-URI backgrounds for e-ink */",
  ".qw-icon{display:inline-block;flex:0 0 auto;background-color:transparent;background-repeat:no-repeat;background-position:center;background-size:contain}",
  ".qw-icon-lg{width:92px;height:92px}",
  ".qw-icon-sm{width:40px;height:40px}",
];

const missing = [];
for (const code of codes) {
  const path = join(iconsDir, `${code}.svg`);
  if (!existsSync(path)) {
    missing.push(code);
    continue;
  }
  const raw = readFileSync(path, "utf8")
    .trim()
    .replace(/fill="currentColor"/gi, 'fill="#000000"')
    .replace(/stroke="currentColor"/gi, 'stroke="#000000"');
  const uri = `data:image/svg+xml,${encodeURIComponent(raw)}`;
  lines.push(`.qi-${code}{background-image:url("${uri}")}`);
}
lines.push(END);
const iconsBlock = `${lines.join("\n")}\n`;

const existing = existsSync(styleCssPath) ? readFileSync(styleCssPath, "utf8") : "";
const beginAt = existing.indexOf(BEGIN);
const endAt = existing.indexOf(END);
let next;
if (beginAt >= 0 && endAt > beginAt) {
  next = `${existing.slice(0, beginAt).trimEnd()}\n\n${iconsBlock}`;
} else {
  // Legacy: drop previous generated icon section starting at the old comment.
  const legacyAt = existing.indexOf("/* QWeather Icons (MIT)");
  const layout = (legacyAt >= 0 ? existing.slice(0, legacyAt) : existing).trimEnd();
  next = `${layout}\n\n${iconsBlock}`;
}

writeFileSync(styleCssPath, next);
console.log(JSON.stringify({
  styleCssPath,
  count: codes.length - missing.length,
  missing,
  bytes: Buffer.byteLength(iconsBlock),
}));
