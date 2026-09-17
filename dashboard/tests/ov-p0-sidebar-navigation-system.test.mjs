import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("OV-SIDEBAR: usa exclusivamente o mapa Lucide central", () => {
  const sidebar = read("src/components/layout/Sidebar.tsx");
  const icons = read("src/lib/oneview-icons.ts");

  assert.match(icons, /from "lucide-react"/);
  assert.match(icons, /ONEVIEW_ICON_MAP/);
  for (const icon of ["home", "alerts", "links", "incidents", "monitoring", "history", "settings", "logout", "notifications"]) {
    assert.match(icons, new RegExp(`\\b${icon}:`), `ícone ausente: ${icon}`);
  }
  assert.match(sidebar, /ONEVIEW_ICON_MAP/);
  assert.doesNotMatch(sidebar, /from "lucide-react"/);
  assert.doesNotMatch(sidebar, /<svg|emoji/i);
});

test("OV-SIDEBAR: ativo, hover e expansão são distinguíveis e acessíveis", () => {
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(sidebar, /before:bg-sidebar-foreground\/80/);
  assert.match(sidebar, /before:opacity-100/);
  assert.match(sidebar, /bg-sidebar-accent text-sidebar-accent-foreground/);
  assert.match(sidebar, /icon: "text-sidebar-accent-foreground"/);
  assert.match(sidebar, /hover:bg-sidebar-accent/);
  assert.match(sidebar, /hover:w-64/);
  assert.match(sidebar, /focus-within:w-64/);
  assert.match(sidebar, /group-hover\/sidebar:opacity-100/);
  assert.match(sidebar, /title=\{name\}/);
  assert.match(sidebar, /aria-label=/);
  assert.match(sidebar, /SIDEBAR_FOCUS_RING/);
  assert.doesNotMatch(sidebar, /ov-color-accent-blue/);
});

test("OV-SIDEBAR: logout aparece abaixo do nome ao expandir", () => {
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(sidebar, /aria-label="Sair"/);
  assert.match(sidebar, />\s*Sair\s*</);
  assert.match(sidebar, /onClick=\{\(\) => void logout\(\)\}/);
  assert.doesNotMatch(sidebar, /DropdownMenuContent/);
  assert.doesNotMatch(sidebar, /Abrir menu de/);
});
