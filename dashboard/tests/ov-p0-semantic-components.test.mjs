import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const semanticPairs = [
  ["--ov-status-monitoring-down", "--ov-status-monitoring-down-surface"],
  ["--ov-status-monitoring-normalized", "--ov-status-monitoring-normalized-surface"],
  ["--ov-status-incident-new", "--ov-status-incident-new-surface"],
  ["--ov-status-incident-progress", "--ov-status-incident-progress-surface"],
  ["--ov-status-incident-waiting", "--ov-status-incident-waiting-surface"],
  ["--ov-status-incident-resolved", "--ov-status-incident-resolved-surface"],
  ["--ov-status-incident-closed", "--ov-status-incident-closed-surface"],
  ["--ov-status-incident-cancelled", "--ov-status-incident-cancelled-surface"],
  ["--ov-status-divergence", "--ov-status-divergence-surface"],
  ["--ov-status-recurrence", "--ov-status-recurrence-surface"],
  ["--ov-status-classification-pending", "--ov-status-classification-pending-surface"],
  ["--ov-severity-information", "--ov-severity-information-surface"],
  ["--ov-severity-warning", "--ov-severity-warning-surface"],
  ["--ov-severity-average", "--ov-severity-average-surface"],
  ["--ov-severity-high", "--ov-severity-high-surface"],
  ["--ov-severity-disaster", "--ov-severity-disaster-surface"],
];

function cssBlock(css, selector) {
  return css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1] || "";
}

function tokenValue(block, token, seen = new Set()) {
  assert.equal(seen.has(token), false, `referência circular: ${token}`);
  seen.add(token);
  const escaped = token.replaceAll("-", "\\-");
  const raw = block.match(new RegExp(`(?:^|\\n)\\s*${escaped}:\\s*([^;]+);`))?.[1]?.trim();
  assert.ok(raw, `token ausente: ${token}`);
  const reference = raw.match(/^var\((--[^)]+)\)$/)?.[1];
  return reference ? tokenValue(block, reference, seen) : raw;
}

function relativeLuminance(hsl) {
  const [h, s, l] = hsl.match(/(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%/)?.slice(1).map(Number) || [];
  assert.ok(Number.isFinite(h) && Number.isFinite(s) && Number.isFinite(l), `HSL inválido: ${hsl}`);
  const saturation = s / 100;
  const lightness = l / 100;
  const channel = (offset) => {
    const k = (offset + h / 30) % 12;
    return lightness - saturation * Math.min(lightness, 1 - lightness) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)]
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(foreground, background) {
  const [a, b] = [relativeLuminance(foreground), relativeLuminance(background)].sort((left, right) => right - left);
  return (a + 0.05) / (b + 0.05);
}

test("OV-SEMANTIC: SemanticBadge é a primitive única com dot opcional e geometria fixa", () => {
  const component = read("src/components/oneview/OneViewDesignSystem.tsx");
  const css = read("src/styles/oneview-design-tokens.css");

  assert.match(component, /export function SemanticBadge/);
  assert.match(component, /showDot = true/);
  assert.match(component, /ov-semantic-badge-dot/);
  assert.match(component, /OneViewSemanticStatusBadge[\s\S]*SemanticBadge/);
  assert.match(component, /OneViewSeverityBadge[\s\S]*SemanticBadge/);
  assert.match(css, /\.ov-semantic-badge,[\s\S]*\.ov-status-badge,[\s\S]*\.ov-severity-badge/);
  assert.match(css, /min-height:\s*1\.5rem/);
  assert.match(css, /border-radius:\s*var\(--ov-radius-pill\)/);
  assert.match(css, /font-size:\s*0\.75rem/);
  assert.match(css, /padding:\s*0\.1875rem 0\.625rem/);
  assert.doesNotMatch(component, /opacity-\d+/, "texto do componente não pode depender de opacity");
});

test("OV-SEMANTIC: foreground versus soft background alcança WCAG AA básico", () => {
  const css = read("src/styles/oneview-design-tokens.css");
  const themes = {
    light: cssBlock(css, ":root"),
    dark: cssBlock(css, "\\.dark"),
  };

  for (const [theme, block] of Object.entries(themes)) {
    assert.ok(block, `bloco ${theme} ausente`);
    for (const [foreground, background] of semanticPairs) {
      const ratio = contrast(tokenValue(block, foreground), tokenValue(block, background));
      assert.ok(ratio >= 4.5, `${theme} ${foreground}: ${ratio.toFixed(2)}:1`);
    }
  }
});

test("OV-SEMANTIC: feedback oficial tem quatro tons, ícone, título, descrição e tokens explícitos", () => {
  const catalog = read("src/lib/oneview-design-system.ts");
  const component = read("src/components/oneview/OneViewDesignSystem.tsx");
  const css = read("src/styles/oneview-design-tokens.css");

  for (const tone of ["success", "warning", "error", "info"]) {
    assert.match(catalog, new RegExp(`${tone}: \\{ label:`));
    assert.match(css, new RegExp(`\\.ov-feedback-${tone}`));
  }
  assert.match(component, /ONEVIEW_ICON_MAP\[definition\.icon\]/);
  assert.match(component, /role=\{tone === "error" \|\| tone === "warning" \? "alert" : "status"\}/);
  assert.match(css, /--ov-feedback-foreground/);
  assert.match(css, /--ov-feedback-background|--ov-feedback-surface/);
  assert.match(css, /--ov-feedback-border/);
});

test("OV-SEMANTIC: Home uses only the imported severity badge", () => {
  const index = read("src/pages/Index.tsx");
  assert.doesNotMatch(index, /<SeverityBadge\b/);
  assert.match(index, /<OneViewSeverityBadge severity=\{item\.severity\} showDot=\{false\} className="h-5 px-1\.5"/);
});
