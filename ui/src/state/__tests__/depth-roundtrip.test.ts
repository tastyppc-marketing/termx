import { describe, expect, it } from "vitest";
import { parseLayout, serializeLayout, validateInvariants } from "../layout";
import { createLayoutStore } from "../store";

/// A layout the store can legally build (split depth exactly MAX_SPLIT_DEPTH)
/// must survive a serialize → parse round trip, or restart flattens the
/// user's layout via the malformed-blob fallback.
describe("depth-4 split round trip", () => {
  it("parses a layout at exactly the max split depth", () => {
    const store = createLayoutStore();
    store.createTab({ id: "t1", sessionId: 1 });
    store.splitPane("t1", 1, "row", 2);
    store.splitPane("t1", 2, "col", 3);
    store.splitPane("t1", 3, "row", 4);
    const afterFourth = store.splitPane("t1", 4, "col", 5);

    // The store accepted depth 4 (5th split must be the one that's refused).
    expect(validateInvariants(afterFourth)).toEqual([]);
    const refused = store.splitPane("t1", 5, "row", 6);
    expect(refused).toBe(afterFourth);

    const blob = serializeLayout(afterFourth);
    expect(parseLayout(blob)).not.toBeNull();
  });
});
