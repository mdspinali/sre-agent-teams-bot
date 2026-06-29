import assert from "node:assert/strict";
import test from "node:test";
import { toTableKey } from "../src/keys.js";

test("toTableKey creates an Azure Table-safe key", () => {
  const key = toTableKey("19:abc/def?ghi#jkl\\mno");

  assert.match(key, /^[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(key, "base64url").toString("utf8"), "19:abc/def?ghi#jkl\\mno");
});

test("toTableKey rejects empty input", () => {
  assert.throws(() => toTableKey(" "), /cannot be empty/);
});
