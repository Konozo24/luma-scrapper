import assert from "node:assert/strict";
import test from "node:test";

import { buildContentDedupKey } from "./linkedinScraper";

test("builds the same content key for whitespace and case variants", () => {
  assert.equal(
    buildContentDedupKey("  Hello   LinkedIn!\n"),
    buildContentDedupKey("hello linkedin!"),
  );
});

test("does not build a content key for empty text", () => {
  assert.equal(buildContentDedupKey(null), null);
  assert.equal(buildContentDedupKey("   "), null);
});
