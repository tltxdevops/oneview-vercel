/**
 * OV-P0-307 — captura visual do bloco de resumo operacional no drawer.
 */
import html2canvas from "html2canvas";

function canvasBackground(element: HTMLElement): string {
  const bg = getComputedStyle(element).backgroundColor;
  if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  const bodyBg = getComputedStyle(document.body).backgroundColor;
  if (bodyBg && bodyBg !== "rgba(0, 0, 0, 0)" && bodyBg !== "transparent") return bodyBg;
  return "#09090b";
}

export async function captureElementToPng(element: HTMLElement): Promise<Blob> {
  const canvas = await html2canvas(element, {
    backgroundColor: canvasBackground(element),
    scale: Math.min(2, window.devicePixelRatio || 1.5),
    useCORS: true,
    logging: false,
    scrollX: 0,
    scrollY: -window.scrollY,
    windowWidth: document.documentElement.clientWidth,
  });
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((value) => resolve(value), "image/png");
  });
  if (!blob) throw new Error("capture_failed");
  return blob;
}

export function printPngBlob(blob: Blob, target?: Window | null): boolean {
  if (typeof window === "undefined") return false;
  const url = URL.createObjectURL(blob);
  const popup = target && !target.closed ? target : window.open("", "_blank");
  if (!popup) {
    URL.revokeObjectURL(url);
    return false;
  }
  try {
    popup.document.open();
    popup.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8" /><title>Print resumo OneView</title>
<style>
  @page { margin: 8mm; }
  html, body { margin: 0; padding: 0; background: #fff; }
  img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
</style></head>
<body><img id="shot" src="${url}" alt="Resumo operacional" /></body></html>`);
    popup.document.close();
    const img = popup.document.getElementById("shot");
    const runPrint = () => {
      try {
        popup.focus();
        popup.print();
      } catch {
        /* ignore */
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    };
    if (img instanceof HTMLImageElement) {
      if (img.complete) runPrint();
      else img.onload = runPrint;
    } else {
      runPrint();
    }
    return true;
  } catch {
    popup.close();
    URL.revokeObjectURL(url);
    return false;
  }
}

export async function copyPngBlob(blob: Blob): Promise<boolean> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") return false;
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  return true;
}
