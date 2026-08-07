import type { HtmlWidget, ScreenHtmlOptions } from "./types.js";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function assertFiniteInteger(name: string, value: number, allowNegative = false): void {
  if (!Number.isInteger(value) || (!allowNegative && value < 0)) {
    throw new RangeError(`${name} must be ${allowNegative ? "an" : "a non-negative"} integer`);
  }
}

function widgetMarkup(widget: HtmlWidget, sourceIndex: number): string {
  assertFiniteInteger("widget.x", widget.x, true);
  assertFiniteInteger("widget.y", widget.y, true);
  assertFiniteInteger("widget.width", widget.width);
  assertFiniteInteger("widget.height", widget.height);
  const zIndex = widget.zIndex ?? 0;
  assertFiniteInteger("widget.zIndex", zIndex, true);
  const id = widget.id === undefined ? "" : ` data-widget-id="${escapeAttribute(widget.id)}"`;
  return `<div class="epd-widget"${id} data-source-index="${sourceIndex}" style="left:${widget.x}px;top:${widget.y}px;width:${widget.width}px;height:${widget.height}px;z-index:${zIndex}">${widget.html}</div>`;
}

/** Builds an opaque, fixed-size document with absolutely positioned widgets. */
export function composeScreenHtml(options: ScreenHtmlOptions): string {
  assertFiniteInteger("screen.width", options.width);
  assertFiniteInteger("screen.height", options.height);
  if (options.width === 0 || options.height === 0) {
    throw new RangeError("Screen dimensions must be greater than zero");
  }

  const widgets = options.widgets
    .map((widget, sourceIndex) => ({ widget, sourceIndex }))
    .sort(
      (left, right) =>
        (left.widget.zIndex ?? 0) - (right.widget.zIndex ?? 0) ||
        left.sourceIndex - right.sourceIndex,
    )
    .map(({ widget, sourceIndex }) => widgetMarkup(widget, sourceIndex))
    .join("");

  const title = escapeAttribute(options.title ?? "EPD screen");
  const background = escapeAttribute(options.background ?? "#fff");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${options.width},initial-scale=1">
<title>${title}</title>
<style>
html,body{margin:0;width:${options.width}px;height:${options.height}px;overflow:hidden;background:${background}}
*,*::before,*::after{box-sizing:border-box}
body{position:relative}
.epd-widget{position:absolute;overflow:hidden}
</style>
${options.extraHeadHtml ?? ""}
</head>
<body>${widgets}<script>window.__EPD_RENDER_READY__=true</script></body>
</html>`;
}
