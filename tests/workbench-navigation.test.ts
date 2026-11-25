import { test } from "node:test";
import assert from "node:assert/strict";
import { ReviewNavigation } from "../src/workbench/navigation.js";

test("review navigation waits for target render and owns cancellation after session selection", () => {
  let signal = new AbortController(),
    rendered: string | undefined,
    opens = 0;
  const navigation = new ReviewNavigation({
    selectSession() {
      signal.abort();
      rendered = undefined;
    },
    beginNavigation() {
      signal.abort();
      signal = new AbortController();
      return signal.signal;
    },
    openReview() {
      assert.equal(rendered, "target", "The target store exists after render");
      opens++;
    },
  });
  navigation.open("target");
  assert.equal(navigation.snapshot().request?.signal.aborted, false);
  assert.equal(opens, 0);
  navigation.commit("other");
  navigation.commit(undefined);
  assert.equal(opens, 0);
  rendered = "target";
  navigation.commit(rendered);
  assert.equal(opens, 1);
  assert.equal(navigation.snapshot().request, null);
  navigation.commit(rendered);
  assert.equal(opens, 1);
  navigation.open("target");
  signal.abort();
  rendered = "target";
  navigation.commit(rendered);
  assert.equal(opens, 1, "Superseding navigation cannot open a stale panel");
});

test("review navigation exposes a failed host operation and can retry", () => {
  let fail = true;
  const navigation = new ReviewNavigation({
    selectSession() {},
    beginNavigation: () => new AbortController().signal,
    openReview() {
      if (fail) throw new Error("Host unavailable");
    },
  });
  navigation.open("target");
  navigation.commit("target");
  assert.equal(navigation.snapshot().error, "Host unavailable");
  fail = false;
  navigation.open("target");
  navigation.commit("target");
  assert.equal(navigation.snapshot().error, "");
});
