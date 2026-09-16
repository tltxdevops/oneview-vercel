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

  assert.match(sidebar, /before:bg-sidebar-foreground/);
  assert.match(sidebar, /before:opacity-100/);
  assert.match(sidebar, /bg-sidebar-accent/);
  assert.match(sidebar, /hover:bg-sidebar-accent/);
  assert.match(sidebar, /hover:w-60/);
  assert.match(sidebar, /focus-within:w-60/);
  assert.match(sidebar, /group-hover\/sidebar:opacity-100/);
  assert.match(sidebar, /title=\{name\}/);
  assert.match(sidebar, /aria-label=/);
  assert.match(sidebar, /focus-visible:ring-2/);
});

test("OV-SIDEBAR: logout fica somente no menu do usuário", () => {
  const sidebar = read("src/components/layout/Sidebar.tsx");

  assert.match(sidebar, /DropdownMenuContent side="right"/);
  assert.match(sidebar, /Abrir menu de/);
  assert.match(sidebar, /Conta — em breve/);
  assert.match(sidebar, /DropdownMenuItem onSelect=\{\(\) => void logout\(\)\}/);
  assert.doesNotMatch(sidebar, /onClick=\{logout\}/);
});
