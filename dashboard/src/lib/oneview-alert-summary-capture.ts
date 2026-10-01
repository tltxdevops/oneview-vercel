/**
 * OV-P0-307 — captura visual do resumo operacional do alerta.
 */
import html2canvas from "html2canvas";

/** 5x o CSS: cartão 720px vira PNG ~3600px (cerca de 300 dpi em A4). */
export const CAPTURE_SCALE = 5;

function canvasBackground(element: HTMLElement): string {
  let node: HTMLElement | null = element;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
    node = node.parentElement;
  }
  return "#ffffff";
}

function waitNextPaint() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

async function rasterizeOnscreen(element: HTMLElement): Promise<HTMLCanvasElement> {
  if (document.fonts?.ready) await document.fonts.ready;

  const staging = document.createElement("div");
  staging.setAttribute("aria-hidden", "true");
  staging.style.cssText = "position:fixed;left:0;top:0;z-index:-1;pointer-events:none;margin:0;padding:0;background:transparent;";
  const clone = element.cloneNode(true) as HTMLElement;
  clone.style.transform = "none";
  clone.style.setProperty("-webkit-font-smoothing", "antialiased");
  clone.style.setProperty("text-rendering", "geometricPrecision");
  staging.appendChild(clone);
  document.body.appendChild(staging);

  try {
    await waitNextPaint();
    const width = Math.max(1, Math.round(clone.scrollWidth || clone.offsetWidth));
    const height = Math.max(1, Math.round(clone.scrollHeight || clone.offsetHeight));
    return await html2canvas(clone, {
      backgroundColor: canvasBackground(clone),
      scale: CAPTURE_SCALE,
      useCORS: true,
      logging: false,
      letterRendering: true,
      scrollX: 0,
      scrollY: 0,
      x: 0,
      y: 0,
      width,
      height,
      windowWidth: width,
      windowHeight: height,
      imageTimeout: 8_000,
      onclone: (_doc, clonedEl) => {
        clonedEl.style.setProperty("-webkit-font-smoothing", "antialiased");
        clonedEl.style.setProperty("text-rendering", "geometricPrecision");
        clonedEl.style.transform = "none";
      },
    });
  } finally {
    staging.remove();
  }
}

export async function captureElementToPng(element: HTMLElement): Promise<Blob> {
  const canvas = await rasterizeOnscreen(element);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/png");
  });
  if (!blob) throw new Error("capture_failed");
  return blob;
}

export function printPngBlob(blob: Blob): boolean {
  if (typeof document === "undefined") return false;
  const url = URL.createObjectURL(blob);
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  if (!win) {
    frame.remove();
    URL.revokeObjectURL(url);
    return false;
  }
  try {
    win.document.open();
    win.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8" /><title>Resumo operacional — OneView</title>
<style>
  @page { margin: 8mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img {
    display: block;
    width: 194mm;
    max-width: 100%;
    height: auto;
    margin: 0 auto;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
</style></head>
<body><img id="shot" src="${url}" alt="Resumo operacional do alerta" /></body></html>`);
    win.document.close();
    const cleanup = () => {
      window.setTimeout(() => {
        frame.remove();
        URL.revokeObjectURL(url);
      }, 1_000);
    };
    const runPrint = () => {
      try {
        win.focus();
        win.print();
      } catch {
        /* ignore */
      }
      win.addEventListener("afterprint", cleanup);
      window.setTimeout(cleanup, 60_000);
    };
    const img = win.document.getElementById("shot");
    if (img instanceof HTMLImageElement) {
      if (img.complete) runPrint();
      else img.onload = runPrint;
    } else {
      runPrint();
    }
    return true;
  } catch {
    frame.remove();
    URL.revokeObjectURL(url);
    return false;
  }
}

export async function copyPngBlob(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return true;
}
