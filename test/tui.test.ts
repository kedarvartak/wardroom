import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtElapsed, fmtTokens, SPINNER, STATUS_GLYPH } from "../src/tui/format.ts";

test("elapsed renders mm:ss and clamps negatives", () => {
  assert.equal(fmtElapsed(0), "00:00");
  assert.equal(fmtElapsed(61_000), "01:01");
  assert.equal(fmtElapsed(-5000), "00:00");
  assert.equal(fmtElapsed(3_599_000), "59:59");
});

test("token counts compact above 1k", () => {
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1.0k");
  assert.equal(fmtTokens(12_345), "12.3k");
});

test("every task status has a glyph and the spinner has frames", () => {
  for (const status of ["pending", "claimed", "review", "done", "failed"] as const) {
    assert.ok(STATUS_GLYPH[status].length > 0);
  }
  assert.ok(SPINNER.length > 1);
});
