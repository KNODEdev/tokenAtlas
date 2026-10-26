import {translate} from "../lib/i18n";
import {privacyEnabled,privateText,reportImageFileName} from "../lib/privacy";
import { BRAND_MARK } from "./brand-mark";

const CAPTURE_STYLE_PROPS = [
  "box-sizing", "display", "position", "flex", "flex-direction", "flex-wrap",
  "flex-grow", "flex-shrink", "flex-basis",
  "align-items", "justify-content", "gap", "grid-template-columns",
  "grid-template-rows", "grid-column", "grid-row", "align-self", "justify-self",
  "top", "right", "bottom", "left", "transform", "transform-origin", "z-index",
  "width", "height", "min-width", "max-width", "min-height", "max-height",
  "margin", "padding", "border", "border-radius", "border-top", "border-bottom",
  "border-collapse", "border-spacing",
  "background-color", "background-image", "background-size", "background-position", "color", "opacity",
  "border-left", "border-right", "box-shadow",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "line-height", "text-align", "text-transform", "text-overflow", "white-space",
  "overflow", "overflow-wrap", "word-break", "vertical-align", "list-style",
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin",
];
function copyComputedStyles(src: Element, dst: Element): void {
  const computed = window.getComputedStyle(src);
  let css = "";
  for (const prop of CAPTURE_STYLE_PROPS) {
    const value = computed.getPropertyValue(prop);
    if (value) css += `${prop}:${value};`;
  }
  const inline = (src as HTMLElement).style?.cssText;
  // Resolved styles must win over inline var()/currentColor references in the detached SVG.
  dst.setAttribute("style", inline ? `${inline};${css}` : css);
  const from = src.children;
  const to = dst.children;
  for (let i = 0; i < from.length && i < to.length; i++) {
    copyComputedStyles(from[i]!, to[i]!);
  }
}
function inlineThemeVariables(src: Element, dst: HTMLElement): void {
  const computed = window.getComputedStyle(src);
  for (let i = 0; i < computed.length; i++) {
    const prop = computed[i];
    if (prop && prop.startsWith("--")) {
      dst.style.setProperty(prop, computed.getPropertyValue(prop));
    }
  }
}
export type ImageFormat = "image/png" | "image/webp";
export const EXPORT_SITE = "tokenAtlas.dev";

export async function renderCardImage(node: HTMLElement, format: ImageFormat, title?: string): Promise<Blob> {
  const privateCapture = privacyEnabled();
  const rect = node.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(rect.width));
  const height = Math.max(1, Math.ceil(rect.height));
  const theme = window.getComputedStyle(node);
  const surface = theme.backgroundColor;
  const paper = window.getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  const ink = theme.getPropertyValue("--muted").trim();
  const brandInk = theme.getPropertyValue("--text").trim();
  const accent = theme.getPropertyValue("--accent").trim();
  const grid = theme.getPropertyValue("--accent-soft").trim();
  const font = theme.getPropertyValue("--font-sans").trim();
  const spacing = parseFloat(theme.getPropertyValue("--s-7")) || 16;
  const fontSize = parseFloat(theme.getPropertyValue("--fs-3")) || 12;
  const brandSize = parseFloat(theme.getPropertyValue("--fs-4")) || fontSize;
  const brandWeight = theme.getPropertyValue("--fw-medium").trim();
  const brandGap = parseFloat(theme.getPropertyValue("--s-3")) || 6;
  const footer = Math.ceil(fontSize + spacing * 2);
  const header = title ? footer : 0;
  const clone = node.cloneNode(true) as HTMLElement;
  copyComputedStyles(node, clone);
  for (const control of Array.from(clone.querySelectorAll("[data-capture-exclude]"))) {
    control.remove();
  }
  inlineThemeVariables(node, clone);
  clone.style.margin = "0";
  clone.style.boxSizing = "border-box";
  clone.style.width = `${width}px`;
  clone.style.height = `${height}px`;
  const SVG_NS = "http://www.w3.org/2000/svg";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const fo = document.createElementNS(SVG_NS, "foreignObject");
  fo.setAttribute("x", "0");
  fo.setAttribute("y", "0");
  fo.setAttribute("width", String(width));
  fo.setAttribute("height", String(height));
  const holder = document.createElementNS(XHTML_NS, "div");
  holder.appendChild(clone);
  fo.appendChild(holder);
  svg.appendChild(fo);
  const markup = new XMLSerializer().serializeToString(svg);
  const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await document.fonts.ready;
  const image = new Image();
  image.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(translate("Could not rasterize the card", "nie udało się zrasteryzować karty")));
    image.src = src;
  });
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil((height + header + footer) * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error(translate("2D context unavailable", "brak kontekstu 2D"));
  ctx.scale(scale, scale);
  // A transparent node falls back to the paper token; canvas cannot read CSS variables itself.
  const transparent = !surface || /^rgba\(.*,\s*0\)$/.test(surface) || surface === "transparent";
  ctx.fillStyle = transparent ? paper || "white" : surface;
  ctx.fillRect(0, 0, width, height + header + footer);
  ctx.drawImage(image, 0, header, width, height);
  ctx.fillStyle = ink;
  ctx.font = `${fontSize}px ${font}`;
  ctx.textBaseline = "middle";
  if (title) ctx.fillText(privateText(title), spacing, header / 2, Math.max(1, width - spacing * 2));
  ctx.textAlign = "right";
  ctx.fillStyle = brandInk;
  ctx.font = `${brandWeight} ${brandSize}px ${font}`;
  const markSize = brandSize * 1.5;
  const markX = width - spacing - ctx.measureText(EXPORT_SITE).width - brandGap - markSize;
  const brandY = height + header + footer / 2;
  if (markX >= spacing) {
    ctx.save();
    ctx.translate(markX + markSize / 2, brandY);
    ctx.scale(markSize / 48, markSize / 48);
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1.6;
    ctx.stroke(new Path2D(BRAND_MARK.grid));
    ctx.strokeStyle = brandInk;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    const sheet = BRAND_MARK.sheet;
    ctx.roundRect(sheet.x, sheet.y, sheet.width, sheet.height, sheet.rx);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke(new Path2D(BRAND_MARK.route));
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(BRAND_MARK.end.cx, BRAND_MARK.end.cy, BRAND_MARK.end.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillText(EXPORT_SITE, width - spacing, height + header + footer / 2, Math.max(1, width - spacing * 2));
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format, 0.95));
  if (!blob) throw new Error(translate("Canvas did not produce an image", "canvas nie oddał obrazu"));
  if (blob.type !== format) throw new Error(translate("Image format unsupported", "Nieobsługiwany format obrazu"));
  if (privateCapture !== privacyEnabled()) throw new Error(translate("Privacy changed during capture; retry", "Zmieniono prywatność podczas eksportu; ponów"));
  return blob;
}
export function renderCardPng(node: HTMLElement): Promise<Blob> {
  return renderCardImage(node, "image/png");
}
export function renderCardWebp(node: HTMLElement, title?: string): Promise<Blob> {
  return renderCardImage(node, "image/webp", title);
}
export function clipboardImageFormat(): ImageFormat {
  return typeof ClipboardItem !== "undefined" && ClipboardItem.supports?.("image/webp") ? "image/webp" : "image/png";
}
export async function copyCardImage(node: HTMLElement, title?: string): Promise<ImageFormat> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error(translate("Clipboard images unavailable; save the WebP instead", "Schowek obrazów niedostępny; zapisz WebP"));
  }
  const format = clipboardImageFormat();
  // Start the write during the click; promise data preserves activation in strict browsers.
  await navigator.clipboard.write([new ClipboardItem({ [format]: renderCardImage(node, format, title) })]);
  return format;
}
export function downloadPng(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = reportImageFileName(fileName);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadImage = downloadPng;
