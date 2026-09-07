import type { JsonValue } from "../host/protocol";
import { parseLayout, serializeLayout, type Layout } from "../state/layout";
import type { LayoutStore } from "../state/store";
import type { LayoutMutation, LayoutSyncMetadata, WindowBus } from "./windowBus";

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const CONFLICT = Symbol("layout conflict");

/** Three-way merge of properties changed since base. Lists and split trees are
 * atomic: guessing how two moves/splits compose can duplicate or revive panes.
 * Missing objects are atomic too, so editing a deleted tab is a conflict. */
export function mergeLayout(base: Layout, proposed: Layout, current: Layout): Layout | null {
  const merge = (before: unknown, after: unknown, now: unknown, key = ""): unknown => {
    if (equal(before, after)) return now;
    if (equal(before, now) || equal(after, now)) return after;
    if (key === "split" || !record(before) || !record(after) || !record(now)) {
      return CONFLICT;
    }
    const result: Record<string, unknown> = {};
    for (const child of new Set([...Object.keys(before), ...Object.keys(after), ...Object.keys(now)])) {
      const value = merge(before[child], after[child], now[child], child);
      if (value === CONFLICT) return CONFLICT;
      if (value !== undefined) Object.defineProperty(result, child, {
        value, enumerable: true, configurable: true, writable: true,
      });
    }
    return result;
  };
  const merged = merge(base, proposed, current);
  return merged === CONFLICT ? null : parseLayout(merged);
}

/** Main is the only authority. Receipts acknowledge adoption, not disk durability.
 * They are independent of coalesced writes, and travel with every broadcast. */
export function mainLayoutSync(store: LayoutStore, bus: WindowBus, save: (layout: Layout) => void) {
  const authority = crypto.randomUUID();
  let revision = 0;
  const receipts: LayoutSyncMetadata["receipts"] = {};
  const broadcast = () => bus.broadcastLayout(serializeLayout(store.getState()), {
    authority,
    revision: ++revision,
    receipts: structuredClone(receipts),
  });
  const receive = (mutation: LayoutMutation): void => {
    const { origin, sequence } = mutation;
    if (typeof origin !== "string" || !origin || !Number.isSafeInteger(sequence) || sequence! < 1) return;
    const previous = receipts[origin];
    if (previous && sequence! <= previous.sequence) {
      void broadcast();
      return;
    }
    const base = parseLayout(mutation.base);
    const proposed = parseLayout(mutation.layout);
    const merged = base && proposed && mergeLayout(base, proposed, store.getState());
    const rejected = !merged || (previous !== undefined && sequence !== previous.sequence + 1);
    Object.defineProperty(receipts, origin, {
      value: { sequence: sequence!, rejected }, enumerable: true, configurable: true, writable: true,
    });
    if (!rejected && merged) {
      store.replaceState(merged);
      save(merged);
    }
    void broadcast();
  };
  return { broadcast, receive };
}

export const LAYOUT_RECEIPT_TIMEOUT_MS = 2_000;

/** One proposal in flight per aux. LayoutPersistence coalesces subsequent
 * changes while that proposal waits for its specific receipt. Reads at send
 * time avoid replaying a stale debounced snapshot after a broadcast rebase. */
export function auxiliaryLayoutSync(store: LayoutStore, bus: WindowBus, conflict: () => void) {
  const origin = crypto.randomUUID();
  let sequence = 0;
  let revision = -1;
  let authority: string | null = null;
  const retiredAuthorities = new Set<string>();
  let truth = store.getState();
  let disposed = false;
  let pending: { mutation: LayoutMutation; optimistic: Layout } | null = null;
  let settle: (() => void) | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const finish = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    settle?.();
    settle = null;
  };
  const receive = (layout: JsonValue, sync?: LayoutSyncMetadata): void => {
    const incoming = parseLayout(layout);
    if (!incoming || (!sync && authority !== null)) return;
    if (sync && sync.authority !== authority) {
      if (retiredAuthorities.has(sync.authority)) return;
      if (authority !== null) retiredAuthorities.add(authority);
      authority = sync.authority;
      revision = -1;
    }
    if (sync && sync.revision <= revision) return;
    if (sync) revision = sync.revision;
    const receipt = sync?.receipts[origin];
    const acknowledged = pending && receipt?.sequence === pending.mutation.sequence;
    const before = acknowledged ? pending!.optimistic : truth;
    const rebased = receipt?.rejected && acknowledged
      ? null : mergeLayout(before, store.getState(), incoming);
    if (!rebased) conflict();
    // Keep the sent proposal's optimistic view aligned with unrelated updates
    // received before its own receipt, without altering the retry wire payload.
    if (pending && !acknowledged) {
      pending.optimistic = mergeLayout(truth, pending.optimistic, incoming) ?? incoming;
    }
    truth = incoming;
    store.replaceState(rebased ?? incoming);
    if (acknowledged) {
      pending = null;
      finish();
    }
  };
  const setLayout = async (_layout: JsonValue): Promise<void> => {
    // A persistence retry may consume the queue entry for a newer edit while
    // re-sending an older proposal. Drain the remaining delta before reporting
    // that entry saved, even if no further record() call will arrive.
    while (!disposed) {
      if (!pending) {
        const current = store.getState();
        if (equal(current, truth)) return;
        pending = {
          mutation: { kind: "setLayout", origin, sequence: ++sequence,
            base: serializeLayout(truth), layout: serializeLayout(current) },
          optimistic: current,
        };
      }
      const mutation = pending.mutation;
      // Register before emission: loopback may reply synchronously.
      const receipt = new Promise<void>((resolve, reject) => {
        settle = resolve;
        timer = setTimeout(() => {
          timer = null;
          settle = null;
          reject(new Error("The main window did not acknowledge the layout."));
        }, LAYOUT_RECEIPT_TIMEOUT_MS);
      });
      try {
        // A receipt proves delivery even if the native emit promise hangs.
        // Delivery failure can reject early, but success waits for adoption.
        const deliveryFailure = new Promise<never>((_resolve, reject) => {
          bus.forwardMutation(mutation).catch(reject);
        });
        await Promise.race([deliveryFailure, receipt]);
      } catch (error) {
        finish();
        throw error;
      }
    }
  };
  return { receive, setLayout, dispose: () => { disposed = true; finish(); } };
}
