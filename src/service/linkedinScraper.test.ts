import assert from "node:assert/strict";
import test from "node:test";

import { isLinkedInRepost } from "./linkedinScraper";

test("identifies LinkedIn reshares from nested API markers", () => {
  assert.equal(
    isLinkedInRepost({
      value: {
        "com.linkedin.voyager.feed.render.UpdateV2": {
          resharedUpdate: { id: "urn:li:activity:123" },
        },
      },
    }),
    true,
  );
});

test("identifies explicit repost metadata", () => {
  assert.equal(isLinkedInRepost({ updateType: "RESHARE" }), true);
  assert.equal(isLinkedInRepost({ isRepost: true }), true);
  assert.equal(
    isLinkedInRepost({
      content: {
        "com.linkedin.voyager.feed.render.Reshare": { originalUpdate: {} },
      },
    }),
    true,
  );
});

test("keeps original company posts", () => {
  assert.equal(
    isLinkedInRepost({
      commentary: { text: "Nyala Labs original announcement" },
      shareContent: { text: "Original post content" },
      updateType: "ORIGINAL",
    }),
    false,
  );
});
