import assert from "node:assert/strict";
import test from "node:test";
import { selectOperationalColumns } from "../src/lib/oneview-operational-table-layout.ts";

const columns = [
  { id: "number", label: "Número", minWidth: 110, responsivePriority: "essential" },
  { id: "description", label: "Descrição", minWidth: 280, required: true, responsivePriority: "essential" },
  { id: "owner", label: "Responsável", minWidth: 130, responsivePriority: "intermediate" },
  { id: "updated", label: "Atualização", minWidth: 130, responsivePriority: "secondary" },
];

test("operational table keeps essential columns and removes secondary columns first", () => {
  assert.deepEqual(
    selectOperationalColumns(columns, 520).map((column) => column.id),
    ["number", "description", "owner"],
  );
});

test("operational table keeps the user selection intact on wide screens or explicit overflow", () => {
  assert.equal(selectOperationalColumns(columns, 1440).length, columns.length);
  assert.equal(selectOperationalColumns(columns, 520, true).length, columns.length);
});

test("required columns are never hidden by the adaptive selection", () => {
  assert.deepEqual(
    selectOperationalColumns(columns, 200).map((column) => column.id),
    ["number", "description"],
  );
});
