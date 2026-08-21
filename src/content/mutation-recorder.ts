import type { DomAfter, DomMutation } from "../schemas/dom";
import {
  createDomLocators,
  filteredReasonOf,
  isPluginOwned,
  readFormState,
  serializeDomNode,
  SerializeBudget,
} from "./dom-serializer";
import {
  DOM_MUTATION_BATCH_MAX_ROOTS,
  DOM_MUTATION_PENDING_MAX_BYTES,
  DOM_MUTATION_PENDING_MAX_RECORDS,
} from "../core/config";
import { jsonUtf8ByteLength } from "../shared/json-bytes";

export interface DomMutationBatch {
  mutations: DomMutation[];
  domAfter: DomAfter;
}

type MutationKind = DomMutation["mutationKind"];
type MutationCounts = Record<MutationKind, number>;
type TruncationReason = "records" | "bytes" | "roots" | "serialization";

interface MutationTruncationSummary {
  reasons: TruncationReason[];
  seen: MutationCounts;
  retained: MutationCounts;
  dropped: MutationCounts;
}

const emptyMutationCounts = (): MutationCounts => ({ added: 0, updated: 0, removed: 0 });

const targetElementOf = (node: Node): Element | null =>
  node instanceof Element ? node : node.parentElement;

const isIgnoredNode = (node: Node): boolean => {
  if (isPluginOwned(node)) {
    return true;
  }
  const element = targetElementOf(node);
  return element !== null && filteredReasonOf(element) !== null;
};

const minimalRoots = (nodes: readonly Node[]): Node[] => {
  const unique = [...new Set(nodes)];
  if (unique.length <= 1) return unique;

  // For connected nodes (additions): sort by document position so ancestors
  // precede descendants, then a single forward scan suffices — O(n log n + n·r).
  // For disconnected nodes (removals): skip sort, check both directions.
  const connected = unique[0]?.isConnected ?? false;
  if (connected) {
    unique.sort((a, b) => {
      if (a === b) return 0;
      const pos = a.compareDocumentPosition(b);
      if (pos & Node.DOCUMENT_POSITION_CONTAINED_BY) return -1;
      if (pos & Node.DOCUMENT_POSITION_CONTAINS) return 1;
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  const roots: Node[] = [];
  outer: for (const node of unique) {
    for (const root of roots) {
      if (root.contains(node)) continue outer;
    }
    if (!connected) {
      for (let i = roots.length - 1; i >= 0; i--) {
        const root = roots[i];
        if (root !== undefined && node.contains(root)) roots.splice(i, 1);
      }
    }
    roots.push(node);
  }
  return roots;
};

const isWithinAny = (node: Node, roots: readonly Node[]): boolean =>
  roots.some((root) => root === node || root.contains(node));

interface RootCandidate {
  readonly node: Node;
  readonly parent: Element;
}

interface RootCandidateBatch {
  readonly candidates: RootCandidate[];
  readonly overflow: number;
}

const collectRootCandidates = (
  records: readonly MutationRecord[],
  direction: "added" | "removed",
): RootCandidateBatch => {
  const candidates: RootCandidate[] = [];
  let inspected = 0;
  let overflow = 0;
  for (const record of records) {
    if (record.type !== "childList") {
      continue;
    }
    const parent = targetElementOf(record.target);
    const nodes = direction === "added" ? record.addedNodes : record.removedNodes;
    const available = Math.max(0, DOM_MUTATION_BATCH_MAX_ROOTS - inspected);
    const inspectCount = Math.min(nodes.length, available);
    overflow += nodes.length - inspectCount;
    inspected += inspectCount;
    if (parent === null || isIgnoredNode(parent)) {
      overflow += inspectCount;
      continue;
    }
    for (let index = 0; index < inspectCount; index += 1) {
      const node = nodes.item(index);
      if (node !== null && !isIgnoredNode(node)) {
        candidates.push({ node, parent });
      }
    }
  }
  return { candidates, overflow };
};

export class DomMutationRecorder {
  private readonly observer: MutationObserver;
  private readonly pending: DomMutation[] = [];
  private pendingBytes = 0;
  private pendingRevision = 0;
  private seen = emptyMutationCounts();
  private retained = emptyMutationCounts();
  private dropped = emptyMutationCounts();
  private readonly truncationReasons = new Set<TruncationReason>();
  private started = false;
  private documentReplaced = false;

  constructor(
    private readonly documentValue: Document,
    private readonly now: () => number = () => Date.now(),
    private readonly onMutationObserved?: (target: Element) => void,
  ) {
    const Observer = documentValue.defaultView?.MutationObserver ?? MutationObserver;
    this.observer = new Observer((records) => {
      const revisionBefore = this.pendingRevision;
      this.consume(records);
      if (this.pendingRevision > revisionBefore) {
        const target = records
          .map((record) => targetElementOf(record.target))
          .find((element): element is Element => element !== null);
        if (target !== undefined) {
          this.onMutationObserved?.(target);
        }
      }
    });
  }

  start(): void {
    if (this.started) {
      return;
    }
    const root = this.documentValue.documentElement;
    this.started = true;
    this.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    });
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.consume(this.observer.takeRecords());
    this.observer.disconnect();
    this.started = false;
  }

  markDocumentReplaced(): void {
    this.documentReplaced = true;
    this.stop();
  }

  drain(target: Element): DomMutationBatch {
    this.consume(this.observer.takeRecords());
    const mutations = this.pending.splice(0, this.pending.length);
    const truncationSummary = this.takeTruncationSummary();
    this.pendingBytes = 0;
    if (this.documentReplaced) {
      return {
        mutations,
        domAfter: { captured: false, reason: "document_replaced" },
      };
    }
    if (mutations.length === 0 && truncationSummary === undefined) {
      return {
        mutations,
        domAfter: { captured: false, reason: "no_local_result" },
      };
    }

    const { added, updated, removed } =
      truncationSummary?.retained ?? this.countRetainedMutations(mutations);
    const budget = new SerializeBudget();
    const targetAfter = target.isConnected
      ? serializeDomNode(target, budget, { includeLayout: false })
      : null;
    return {
      mutations,
      domAfter: {
        captured: true,
        ...(targetAfter === null ? {} : { targetAfter }),
        mutationSummary: { added, updated, removed },
        capturedAt: this.now(),
        ...(budget.truncated || truncationSummary !== undefined ? { truncated: true } : {}),
        ...(truncationSummary === undefined ? {} : { truncationSummary }),
      },
    };
  }

  private countRetainedMutations(mutations: readonly DomMutation[]): MutationCounts {
    const counts = emptyMutationCounts();
    for (const mutation of mutations) {
      counts[mutation.mutationKind]++;
    }
    return counts;
  }

  private takeTruncationSummary(): MutationTruncationSummary | undefined {
    const summary =
      this.truncationReasons.size === 0
        ? undefined
        : {
            reasons: [...this.truncationReasons],
            seen: this.seen,
            retained: this.retained,
            dropped: this.dropped,
          };
    this.seen = emptyMutationCounts();
    this.retained = emptyMutationCounts();
    this.dropped = emptyMutationCounts();
    this.truncationReasons.clear();
    return summary;
  }

  private noteDropped(kind: MutationKind, count: number, reason: TruncationReason): void {
    if (count <= 0) {
      return;
    }
    this.seen[kind] += count;
    this.dropped[kind] += count;
    this.truncationReasons.add(reason);
    this.pendingRevision++;
  }

  private tryAppend(kind: MutationKind, build: () => DomMutation | null): void {
    this.seen[kind]++;
    this.pendingRevision++;
    if (this.pending.length >= DOM_MUTATION_PENDING_MAX_RECORDS) {
      this.dropped[kind]++;
      this.truncationReasons.add("records");
      return;
    }
    const mutation = build();
    if (mutation === null) {
      this.dropped[kind]++;
      this.truncationReasons.add("serialization");
      return;
    }
    const bytes = jsonUtf8ByteLength(mutation);
    if (this.pendingBytes + bytes > DOM_MUTATION_PENDING_MAX_BYTES) {
      this.dropped[kind]++;
      this.truncationReasons.add("bytes");
      return;
    }
    this.pending.push(mutation);
    this.pendingBytes += bytes;
    this.retained[kind]++;
  }

  private consume(records: readonly MutationRecord[]): void {
    if (records.length === 0) {
      return;
    }

    const addedBatch = collectRootCandidates(records, "added");
    const removedBatch = collectRootCandidates(records, "removed");
    const addedRoots = minimalRoots(addedBatch.candidates.map(({ node }) => node));
    const removedRoots = minimalRoots(removedBatch.candidates.map(({ node }) => node));
    this.noteDropped("added", addedBatch.overflow, "roots");
    this.noteDropped("removed", removedBatch.overflow, "roots");

    // Shared budget across all serializations in this batch.
    const budget = new SerializeBudget();
    for (const root of addedRoots) {
      const parent = addedBatch.candidates.find(({ node }) => node === root)?.parent;
      if (parent === undefined) {
        continue;
      }
      this.tryAppend("added", () => {
        const serialized = serializeDomNode(root, budget, { includeLayout: false });
        return serialized === null
          ? null
          : {
              mutationKind: "added" as const,
              node: serialized,
              parentLocators: createDomLocators(parent, { visibleText: "omit" }),
              observedAt: this.now(),
            };
      });
    }
    for (const root of removedRoots) {
      const parent = removedBatch.candidates.find(({ node }) => node === root)?.parent;
      if (parent === undefined) {
        continue;
      }
      this.tryAppend("removed", () => {
        const serialized = serializeDomNode(root, budget, { includeLayout: false });
        return serialized === null
          ? null
          : {
              mutationKind: "removed" as const,
              node: serialized,
              parentLocators: createDomLocators(parent, { visibleText: "omit" }),
              observedAt: this.now(),
            };
      });
    }
    for (const record of records) {
      if (record.type === "childList") {
        continue;
      }

      if (
        isIgnoredNode(record.target) ||
        isWithinAny(record.target, addedRoots) ||
        isWithinAny(record.target, removedRoots)
      ) {
        continue;
      }
      const target = targetElementOf(record.target);
      if (target === null) {
        continue;
      }
      if (record.type === "attributes") {
        this.tryAppend("updated", () => {
          const attribute = record.attributeName ?? undefined;
          const after =
            attribute === undefined ? undefined : target.getAttribute(attribute) ?? undefined;
          const formStateAfter = readFormState(target);
          return {
            mutationKind: "updated" as const,
            targetLocators: createDomLocators(target, { visibleText: "bounded" }),
            ...(attribute === undefined ? {} : { attribute }),
            ...(record.oldValue === null ? {} : { before: record.oldValue }),
            ...(after === undefined ? {} : { after }),
            ...(formStateAfter === undefined ? {} : { formStateAfter }),
            observedAt: this.now(),
          };
        });
        continue;
      }
      this.tryAppend("updated", () => {
        const after = record.target.textContent ?? undefined;
        const formStateAfter = readFormState(target);
        return {
          mutationKind: "updated" as const,
          targetLocators: createDomLocators(target, { visibleText: "bounded" }),
          ...(record.oldValue === null ? {} : { before: record.oldValue }),
          ...(after === undefined ? {} : { after }),
          ...(formStateAfter === undefined ? {} : { formStateAfter }),
          observedAt: this.now(),
        };
      });
    }
  }
}
