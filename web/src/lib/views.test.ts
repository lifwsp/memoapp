/// <reference types="node" />
import test from "node:test";
import assert from "node:assert/strict";
import type { Note } from "./supabase.ts";
import { filterNotes } from "./views.ts";

const note = (id: string, fields: Partial<Note> = {}): Note => ({
  id, user_id: "user", title: null, body: id, pinned: false, archived: false,
  deleted_at: null, source: "web", input_kind: null, tags: [], is_task: true,
  done_at: null, due_date: null, due_time: null, scheduled_date: null, priority: 0,
  repeat_rule: null, repeat_from: "due", last_done_at: null, done_count: 0,
  parent_id: null, sort_order: 0, created_at: "2026-01-01", updated_at: "2026-01-01",
  ...fields,
});
const ids = (notes: Note[]) => notes.map((n) => n.id).sort();

test("undated includes scheduled tasks and standalone matching subtasks, but excludes non-live/done/dated notes", () => {
  const notes = [
    note("plain"), note("shopping", { tags: ["買い物"] }),
    note("scheduled", { tags: ["買い物"], scheduled_date: "2026-12-01" }),
    note("child", { parent_id: "other-parent", tags: ["買い物"] }),
    note("done", { done_at: "2026-01-02" }), note("dated", { due_date: "2026-12-01" }),
    note("archived", { archived: true }), note("deleted", { deleted_at: "2026-01-02" }),
    note("memo", { is_task: false }),
  ];
  assert.deepEqual(ids(filterNotes(notes, { kind: "undated" }, false)), ["child", "plain", "scheduled", "shopping"]);
  assert.deepEqual(ids(filterNotes(notes, { kind: "undated", tag: "買い物" }, true)), ["child", "scheduled", "shopping"]);
});

test("existing inbox and tag views preserve top-level behavior", () => {
  const notes = [note("untagged"), note("memo", { is_task: false }), note("tagged", { tags: ["買い物"] }), note("child", { parent_id: "untagged", tags: ["買い物"] })];
  assert.deepEqual(ids(filterNotes(notes, { kind: "inbox" }, false)), ["memo", "untagged"]);
  assert.deepEqual(ids(filterNotes(notes, { kind: "tag", tag: "買い物" }, false)), ["tagged"]);
});
