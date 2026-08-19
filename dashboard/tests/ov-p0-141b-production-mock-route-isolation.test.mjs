import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("OV-P0-141B: mock-only pages are lazy local-only routes", () => {
  const app = read("src/App.tsx");

  for (const page of ["BancoDados", "Certificados", "Workspaces"]) {
    assert.doesNotMatch(app, new RegExp(`import\\s+${page}Page\\s+from`));
    assert.match(app, new RegExp(`const ${page}Page = import\\.meta\\.env\\.DEV \\? lazy\\(`));
  }

  for (const route of ["/banco-dados", "/certificados", "/workspaces"]) {
    assert.match(app, new RegExp(`&& <Route path="${route}"`));
  }

  assert.doesNotMatch(app, /<LocalOnlyRoute/);
  assert.match(app, /<Suspense fallback=\{null\}><BancoDadosPage \/><\/Suspense>/);
  assert.match(app, /<Suspense fallback=\{null\}><CertificadosPage \/><\/Suspense>/);
  assert.match(app, /<Suspense fallback=\{null\}><WorkspacesPage \/><\/Suspense>/);
});

test("OV-P0-141B: the three local-only pages are the mock-data consumers", () => {
  for (const page of ["BancoDados.tsx", "Certificados.tsx", "Workspaces.tsx"]) {
    assert.match(read(`src/pages/${page}`), /@\/lib\/mock-data/);
  }
});
