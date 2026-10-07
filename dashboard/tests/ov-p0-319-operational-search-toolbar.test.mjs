import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS,
  ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS,
  createOneViewLatestRequestGate,
  createOneViewSearchCommitter,
} from "../src/lib/oneview-search-commit.js";

test("P0 search committer keeps only final rapid draft, clears pending work, and Enter commits immediately", () => {
  const timers = new Map();
  let id = 0;
  const commits = [];
  const committer = createOneViewSearchCommitter({
    onCommit: (value) => commits.push(value),
    schedule: (callback, wait) => {
      assert.equal(wait, 250);
      const timer = ++id;
      timers.set(timer, () => {
        timers.delete(timer);
        callback();
      });
      return timer;
    },
    clear: (timer) => timers.delete(timer),
  });

  committer.schedule("i");
  committer.schedule("in");
  committer.schedule("inc");
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(commits, ["inc"]);

  committer.schedule("cancelar");
  committer.cancel();
  assert.equal(timers.size, 0);
  committer.commitNow(" INC0084362 ");
  assert.deepEqual(commits, ["inc", "INC0084362"]);
});

test("P0 request gate rejects stale responses", () => {
  const gate = createOneViewLatestRequestGate();
  const first = gate.next();
  const second = gate.next();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test("P0 shared search field uses 250ms result commit and 150ms suggestions", () => {
  const field = readFileSync(new URL("../src/components/oneview/OneViewTableSearchField.tsx", import.meta.url), "utf8");
  assert.equal(ONEVIEW_SEARCH_COMMIT_DEBOUNCE_MS, 250);
  assert.equal(ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS, 150);
  assert.match(field, /createOneViewSearchCommitter/);
  assert.match(field, /ONEVIEW_SEARCH_SUGGEST_DEBOUNCE_MS/);
});

test("P0 operational pages use shared commit; Links enables scoped autocomplete", () => {
  const pages = ["Alerts.tsx", "Historico.tsx", "Chamados.tsx", "Operadoras.tsx"]
    .map((name) => readFileSync(new URL(`../src/pages/${name}`, import.meta.url), "utf8"));
  for (const page of pages) assert.match(page, /useOneViewCommittedSearch/);
  const links = pages[3];
  assert.match(links, /searchDraft/);
  assert.match(links, /onSearchSubmit=\{\(value\) => commitLinkSearchNow\(value\)\}/);
  assert.match(links, /fetchLinkSearchSuggestions/);
  assert.match(links, /fetchSearchSuggestions=\{fetchLinkTableSuggestions\}/);
  assert.match(links, /localSearchSuggestions=\{localCustomerSearchSuggestions\}/);
});
