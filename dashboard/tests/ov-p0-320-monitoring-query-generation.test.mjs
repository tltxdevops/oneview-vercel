import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOneViewQueryGeneration } from "../src/lib/oneview-query-generation.js";

test("P0 Monitoring ignores A/B and schedules only C after fast filter changes", () => {
  const coordinator = createOneViewQueryGeneration();
  const generationA = coordinator.advance();
  assert.equal(coordinator.begin(), generationA);

  coordinator.advance(); // Cliente B while A remains in flight.
  coordinator.deferCurrentIfDifferent();
  const generationC = coordinator.advance(); // Cliente C supersedes B.
  coordinator.deferCurrentIfDifferent();

  assert.equal(coordinator.isCurrent(generationA), false);
  assert.equal(coordinator.complete(generationA), true);
  assert.equal(coordinator.begin(), generationC);
  assert.equal(coordinator.isCurrent(generationC), true);
  assert.equal(coordinator.complete(generationC), false);
});

test("P0 Monitoring keeps normal polling as one request and preserves 10s/facets cache", async () => {
  const [monitoring, facets] = await Promise.all([
    readFile(new URL("../src/pages/Monitoring.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/oneview-facets-store.ts", import.meta.url), "utf8"),
  ]);

  assert.match(monitoring, /REFRESH_MS = 10_000/);
  assert.match(monitoring, /queryGenerationRef\.current\.deferCurrentIfDifferent\(\)/);
  assert.match(monitoring, /!queryGenerationRef\.current\.isCurrent\(queryGeneration\)/);
  assert.match(monitoring, /queueMicrotask\(\(\) => \{\s*void refreshAllRef\.current\(\);/);
  assert.match(facets, /60_000/);
});
