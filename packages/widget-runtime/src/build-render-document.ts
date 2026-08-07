import { FIXED_WIDGET_CSS } from "./fixed-css";
import type { RenderDocumentInput } from "./types";

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => HTML_ENTITIES[character]);

const safeJson = (value: unknown): string =>
  (JSON.stringify(value ?? null) as string)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const cleanStyle = (style: string): string =>
  style.replace(/<\/style/gi, "<\\/style");

export function buildRenderDocument(input: RenderDocumentInput): string {
  const width = Math.max(1, Math.round(input.size.width));
  const height = Math.max(1, Math.round(input.size.height));
  const state = {
    data: input.data ?? {},
    config: input.config ?? {},
    size: { width, height },
    locale: input.locale ?? "zh-CN",
  };
  const title = escapeHtml(input.title ?? "EPD Widget");

  return `<!doctype html>
<html lang="${escapeHtml(state.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=${width},initial-scale=1">
<title>${title}</title>
<style>${FIXED_WIDGET_CSS}
:root{--widget-width:${width}px;--widget-height:${height}px}
${cleanStyle(input.style)}</style>
</head>
<body><main id="widget-root">${input.template}</main>
<script id="widget-state" type="application/json">${safeJson(state)}</script>
<script>
"use strict";
const state=JSON.parse(document.getElementById("widget-state").textContent);
Object.defineProperty(window,"__EPD_WIDGET__",{value:Object.freeze(state),writable:false});
const root=document.getElementById("widget-root");
for(const [scope,values] of [["config",state.config],["data",state.data]]){
 for(const [key,value] of Object.entries(values||{})){
  const name="--"+scope+"-"+key.replace(/_/g,"-");
  if(typeof value==="number"||typeof value==="boolean"||(typeof value==="string"&&/^[\\w .%#-]{0,80}$/.test(value)))root.style.setProperty(name,String(value));
  if(scope==="config"&&value===true&&/^[\\w-]+$/.test(key))root.classList.add("config-"+key.replace(/_/g,"-"));
 }
}
if(state.config&&state.config.inverted){root.style.setProperty("--note-bg","#000");root.style.setProperty("--note-fg","#fff")}
for(const node of document.querySelectorAll("[data-text]")){
 const path=node.getAttribute("data-text").split(".");
 let value=state;
 for(const key of path)value=value==null?undefined:value[key];
 node.textContent=value==null?"":String(value);
}
for(const node of document.querySelectorAll("[data-class]")){
 const path=node.getAttribute("data-class").split(".");
 let value=state;
 for(const key of path)value=value==null?undefined:value[key];
 if(typeof value==="string")for(const token of value.split(/\\s+/))if(/^[a-z0-9_-]+$/i.test(token))node.classList.add(token);
}
for(const node of document.querySelectorAll("[data-percent]")){
 const path=node.getAttribute("data-percent").split(".");
 let value=state;
 for(const key of path)value=value==null?undefined:value[key];
 node.style.setProperty("--percent",Math.min(100,Math.max(0,Number(value)||0))+"%");
}
document.documentElement.dataset.ready="true";
</script></body></html>`;
}
