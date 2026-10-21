import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Proportional UI faces only. DejaVu Sans Mono and other monospace faces stay
// on the system defaults so the dot-matrix clock keeps gaps between cells.
const PROPORTIONAL_FAMILIES = [
  "DejaVu Sans",
  "Liberation Sans",
  "WenQuanYi Micro Hei",
  "Noto Sans CJK SC",
  "Noto Sans",
  "Microsoft YaHei",
];

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Writes a fontconfig file that rasterizes UI text as hinted monochrome. */
export function epdFontconfigPath(): string {
  const systemConfig = process.env.FONTCONFIG_FILE ?? "/etc/fonts/fonts.conf";
  const families = PROPORTIONAL_FAMILIES
    .map((family) => `      <string>${xmlEscape(family)}</string>`)
    .join("\n");
  const xml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <include ignore_missing="yes">${xmlEscape(systemConfig)}</include>
  <match target="font">
    <test qual="any" name="family" compare="eq">
${families}
    </test>
    <edit name="antialias" mode="assign" binding="strong"><bool>false</bool></edit>
    <edit name="hinting" mode="assign" binding="strong"><bool>true</bool></edit>
    <edit name="autohint" mode="assign" binding="strong"><bool>false</bool></edit>
    <edit name="hintstyle" mode="assign" binding="strong"><const>hintfull</const></edit>
    <edit name="rgba" mode="assign" binding="strong"><const>none</const></edit>
  </match>
</fontconfig>
`;
  const path = join(tmpdir(), "epd-render-fonts.conf");
  writeFileSync(path, xml, "utf8");
  return path;
}
