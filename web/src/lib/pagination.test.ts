/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import { loadAllPages } from "./pagination.ts";

test("loads beyond the server row cap with no missing rows", async () => {
  const source = Array.from({ length: 2501 }, (_, i) => i);
  const ranges: number[][] = [];
  const result = await loadAllPages<number>(async (from, to) => {
    ranges.push([from, to]);
    return { data: source.slice(from, Math.min(to + 1, from + 500)), error: null };
  });
  assert.deepEqual(result, source);
  assert.deepEqual(ranges.at(-1), [2501, 3500]);
});

test("page failure rejects instead of returning a truncated collection", async () => {
  await assert.rejects(loadAllPages<number>(async (from) => from === 0
    ? { data: [1, 2], error: null }
    : { data: null, error: { message: "page failed" } }), /page failed/);
});

test("empty collection terminates immediately", async () => {
  assert.deepEqual(await loadAllPages(async () => ({ data: [], error: null })), []);
});
