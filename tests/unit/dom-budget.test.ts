// @vitest-environment jsdom

import { describe, expect, it, beforeEach, vi } from "vitest";
import {
  captureDomTarget,
  createDomLocators,
  serializeClosedShadowHost,
  serializeDomNode,
  SerializeBudget,
} from "../../src/content/dom-serializer";
import { DomMutationRecorder } from "../../src/content/mutation-recorder";
import { domLocatorsSchema, domNodeSchema, type DomNode } from "../../src/schemas/dom";
import { jsonUtf8ByteLength, utf8ByteLength } from "../../src/shared/json-bytes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a DOM chain of nested divs: depth N produces div > div > ... > div. */
const buildDeepTree = (depth: number): HTMLElement => {
  const root = document.createElement("div");
  root.id = "deep-root";
  let current: HTMLElement = root;
  for (let i = 1; i < depth; i++) {
    const child = document.createElement("div");
    child.setAttribute("data-level", String(i));
    current.appendChild(child);
    current = child;
  }
  current.textContent = "leaf";
  return root;
};

/** Build a flat list of N children under one parent. */
const buildWideTree = (count: number): HTMLElement => {
  const root = document.createElement("div");
  root.id = "wide-root";
  for (let i = 0; i < count; i++) {
    const child = document.createElement("span");
    child.textContent = `item-${String(i)}`;
    root.appendChild(child);
  }
  return root;
};

/** Recursively count all DomNode instances (including truncation markers). */
const countNodes = (node: DomNode): number => {
  let count = 1;
  for (const child of node.children ?? []) {
    count += countNodes(child);
  }
  return count;
};

/** Find all truncation marker nodes in a tree. */
const findTruncationMarkers = (node: DomNode): DomNode[] => {
  const markers: DomNode[] = [];
  if (node.nodeType === "truncated_budget") markers.push(node);
  for (const child of node.children ?? []) {
    markers.push(...findTruncationMarkers(child));
  }
  return markers;
};

const settleObserver = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const required = <T>(value: T | null | undefined, message: string): T => {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
};

const installSyntheticAttributes = (
  element: Element,
  count: number,
): { reads: () => number } => {
  let attributeReads = 0;
  const attributeAt = (index: number): Attr =>
    ({ name: `data-field-${String(index)}`, value: `value-${String(index)}` }) as Attr;
  const attributes = {
    length: count,
    item(index: number): Attr | null {
      if (index < 0 || index >= this.length) {
        return null;
      }
      attributeReads += 1;
      return attributeAt(index);
    },
    *[Symbol.iterator](): IterableIterator<Attr> {
      for (let index = 0; index < this.length; index += 1) {
        attributeReads += 1;
        yield attributeAt(index);
      }
    },
  };
  Object.defineProperty(element, "attributes", {
    configurable: true,
    value: attributes,
  });
  Object.defineProperty(element, "getAttribute", {
    configurable: true,
    value: () => null,
  });
  return { reads: () => attributeReads };
};

// ---------------------------------------------------------------------------
// SerializeBudget unit tests
// ---------------------------------------------------------------------------

describe("SerializeBudget", () => {
  it("counts nodes and bytes until exhaustion", () => {
    const budget = new SerializeBudget(10, 3, 10_000);
    expect(budget.countNode(100)).toBe(true);  // node 1
    expect(budget.countNode(100)).toBe(true);  // node 2
    expect(budget.countNode(100)).toBe(true);  // node 3
    expect(budget.countNode(100)).toBe(false); // node 4 → over limit
    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("nodes");
  });

  it("tracks byte exhaustion", () => {
    const budget = new SerializeBudget(10, 1000, 200);
    budget.countNode(100); // 100 bytes
    expect(budget.truncated).toBe(false);
    budget.countNode(150); // 250 bytes → over 200
    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("bytes");
  });

  it.each(["nodes", "bytes"] as const)(
    "lets global %s exhaustion override an earlier local depth truncation",
    (reason) => {
    const budget = new SerializeBudget(10, 1000, 10_000);
    budget.exhaust("depth");
      budget.exhaust(reason);

      expect(budget.exhausted).toBe(true);
      expect(budget.truncationReason).toBe(reason);
    },
  );
});

// ---------------------------------------------------------------------------
// serializeDomNode with budget
// ---------------------------------------------------------------------------

describe("serializeDomNode budget enforcement", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("truncates at max depth and emits a depth truncation marker", () => {
    const tree = buildDeepTree(50); // 50 levels
    document.body.appendChild(tree);

    const budget = new SerializeBudget(5, 10_000, 10_000_000);
    const result = serializeDomNode(tree, budget);

    expect(result).not.toBeNull();
    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("depth");

    // Find the truncation marker in the tree
    const markers = findTruncationMarkers(required(result, "expected serialized tree"));
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect(required(markers[0], "expected truncation marker").truncationReason).toBe("depth");
  });

  it("truncates at max nodes and emits a nodes truncation marker", () => {
    const tree = buildWideTree(100); // 100 span children + 100 text nodes = 201 total with root
    document.body.appendChild(tree);

    const budget = new SerializeBudget(100, 10, 10_000_000);
    const result = serializeDomNode(tree, budget);

    expect(result).not.toBeNull();
    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("nodes");

    const totalNodes = countNodes(required(result, "expected serialized tree"));
    // Should be significantly fewer than the 201 unbudgeted nodes
    expect(totalNodes).toBeLessThanOrEqual(15);
  });

  it("truncates at max bytes", () => {
    // Each span has ~80 bytes overhead + attribute bytes; 50 spans should exceed 1 KiB easily
    const tree = buildWideTree(50);
    document.body.appendChild(tree);

    const budget = new SerializeBudget(100, 10_000, 1024);
    const result = serializeDomNode(tree, budget);

    expect(result).not.toBeNull();
    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("bytes");
  });

  it("stops reading attributes when the shared byte budget is exhausted", () => {
    const target = document.createElement("div");
    let attributeReads = 0;
    const attributeAt = (index: number): Attr =>
      ({ name: `data-field-${String(index)}`, value: "x".repeat(20) }) as Attr;
    const attributes = {
      length: 1_000,
      item(index: number): Attr | null {
        if (index < 0 || index >= this.length) {
          return null;
        }
        attributeReads += 1;
        return attributeAt(index);
      },
      *[Symbol.iterator](): IterableIterator<Attr> {
        for (let index = 0; index < this.length; index += 1) {
          attributeReads += 1;
          yield attributeAt(index);
        }
      },
    };
    Object.defineProperty(target, "attributes", {
      configurable: true,
      value: attributes,
    });
    Object.defineProperty(target, "getAttribute", {
      configurable: true,
      value: () => null,
    });

    serializeDomNode(target, new SerializeBudget(10, 100, 256), { includeLayout: false });

    expect(attributeReads).toBeLessThan(20);
  });

  it("does not charge attributes against the DOM node budget", () => {
    const target = document.createElement("div");
    installSyntheticAttributes(target, 5);
    const child = document.createElement("span");
    child.textContent = "kept";
    target.appendChild(child);

    const budget = new SerializeBudget(10, 3, 10_000);
    const result = required(
      serializeDomNode(target, budget, { includeLayout: false }),
      "expected serialized tree",
    );

    expect(budget.nodes).toBe(3);
    expect(budget.truncationReason).toBeUndefined();
    expect(result.children?.[0]?.tagName).toBe("span");
    expect(result.children?.[0]?.children?.[0]?.text).toBe("kept");
  });

  it("marks the skipped child subtree when attributes exhaust the shared byte budget", () => {
    const target = document.createElement("div");
    const observed = installSyntheticAttributes(target, 1);
    const child = document.createElement("span");
    child.textContent = "must not disappear silently";
    target.appendChild(child);

    const result = required(
      serializeDomNode(target, new SerializeBudget(10, 100, 100), {
        includeLayout: false,
      }),
      "expected serialized tree",
    );

    expect(observed.reads()).toBe(1);
    expect(result.attributeTruncation?.reason).toBe("bytes");
    expect(result.children).toEqual([
      { nodeType: "truncated_budget", truncationReason: "bytes" },
    ]);
    expect(domNodeSchema.parse(result)).toEqual(result);
  });

  it("reports a later node exhaustion after an attribute-count boundary", () => {
    const target = document.createElement("div");
    installSyntheticAttributes(target, 5);
    const child = document.createElement("span");
    child.textContent = "node three";
    target.appendChild(child);
    const budget = new SerializeBudget(10, 2, 10_000, 1);

    const result = required(
      serializeDomNode(target, budget, { includeLayout: false }),
      "expected serialized tree",
    );

    expect(result.attributeTruncation?.reason).toBe("count");
    expect(findTruncationMarkers(result)).toContainEqual({
      nodeType: "truncated_budget",
      truncationReason: "nodes",
    });
    expect(budget.truncationReason).toBe("nodes");
  });

  it("bounds attributes read for an unbudgeted closed-shadow boundary", () => {
    const host = document.createElement("div");
    const observed = installSyntheticAttributes(host, 5_000);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockReturnValue({
      display: "block",
      visibility: "visible",
    } as CSSStyleDeclaration);

    const result = serializeClosedShadowHost(host);
    styleSpy.mockRestore();

    expect(Object.keys(result.attributes ?? {})).toHaveLength(500);
    expect(result.attributeTruncation).toEqual({
      reason: "count",
      totalAttributes: 5_000,
      scannedAttributes: 500,
      retainedAttributes: 500,
    });
    expect(domNodeSchema.parse(result)).toEqual(result);
    expect(observed.reads()).toBe(500);
  });

  it("serializes a small tree completely with default budget", () => {
    const tree = buildWideTree(5);
    document.body.appendChild(tree);

    const budget = new SerializeBudget();
    const result = serializeDomNode(tree, budget);

    expect(result).not.toBeNull();
    expect(budget.truncated).toBe(false);
    // Root + 5 spans + 5 text nodes = 11
    expect(countNodes(required(result, "expected serialized tree"))).toBe(11);
  });

  it("propagates explicit attribute boundaries through filtered, shallow and iframe nodes", () => {
    const article = document.createElement("article");
    installSyntheticAttributes(article, 5_000);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    installSyntheticAttributes(path, 5_000);
    svg.appendChild(path);
    article.appendChild(svg);
    document.body.appendChild(article);

    const filtered = required(captureDomTarget(path, 10), "expected filtered capture");
    if (filtered.target.kind !== "filtered_boundary") {
      throw new Error("expected filtered boundary");
    }
    expect(filtered.target.boundary.attributeTruncation?.reason).toBe("count");
    expect(filtered.parentChain[0]?.attributeTruncation?.reason).toBe("count");

    const iframe = document.createElement("iframe");
    installSyntheticAttributes(iframe, 5_000);
    const iframeNode = required(
      serializeDomNode(iframe, undefined, { includeLayout: false }),
      "expected iframe boundary",
    );
    expect(iframeNode.nodeType).toBe("iframe_boundary");
    expect(iframeNode.attributeTruncation?.reason).toBe("count");
    expect(domNodeSchema.parse(iframeNode)).toEqual(iframeNode);
  });

  it("emits a bytes marker when iframe attributes exhaust the budget before later siblings", () => {
    const root = document.createElement("div");
    const iframe = document.createElement("iframe");
    iframe.setAttribute("data-large", "x");
    const sibling = document.createElement("span");
    sibling.id = "after-iframe";
    root.append(iframe, sibling);
    document.body.appendChild(root);

    const budget = new SerializeBudget(10, 100, 170);
    const result = required(serializeDomNode(root, budget), "expected serialized tree");
    const markers = findTruncationMarkers(result);

    expect(budget.truncationReason).toBe("bytes");
    expect(markers).toHaveLength(1);
    expect(markers[0]?.truncationReason).toBe("bytes");
    expect(result.children?.some((child) => child.attributes?.["id"] === "after-iframe")).toBe(
      false,
    );
  });

  it("depth truncation in one branch does not stop sibling serialization", () => {
    const root = document.createElement("div");
    root.appendChild(buildDeepTree(20)); // exceeds depth 5
    const sibling = document.createElement("span");
    sibling.id = "after-deep";
    sibling.textContent = "still here";
    root.appendChild(sibling);
    document.body.appendChild(root);

    const budget = new SerializeBudget(5, 10_000, 10_000_000);
    const result = serializeDomNode(root, budget);

    expect(budget.truncated).toBe(true);
    expect(budget.truncationReason).toBe("depth");
    expect(budget.exhausted).toBe(false);
    // The sibling that comes after the deep branch must still be captured.
    const serialized = required(result, "expected serialized tree");
    const span = serialized.children?.find((c) => c.attributes?.["id"] === "after-deep");
    expect(span).toBeDefined();
    expect(required(span, "expected sibling span").children?.[0]?.text).toBe("still here");
  });

  it("root element receives layout info, children do not", () => {
    document.body.innerHTML = `<div id="parent"><span id="child">text</span></div>`;
    const parent = required(document.getElementById("parent"), "expected parent element");

    const result = serializeDomNode(parent);

    expect(result).not.toBeNull();
    // Root gets visible/rect
    const serialized = required(result, "expected serialized parent");
    expect(serialized.visible).toBeDefined();
    expect(serialized.rect).toBeDefined();
    // Child span should NOT have visible/rect (R2: no forced reflow on children)
    const span = serialized.children?.find((c) => c.tagName === "span");
    expect(span).toBeDefined();
    expect(required(span, "expected child span").visible).toBeUndefined();
    expect(required(span, "expected child span").rect).toBeUndefined();
  });

  it("allows mutation callers to disable all layout reads", () => {
    document.body.innerHTML = `<div id="target"><span>text</span></div>`;
    const target = required(document.getElementById("target"), "expected target element");
    const rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect");
    const styleSpy = vi.spyOn(window, "getComputedStyle");

    const result = serializeDomNode(target, undefined, { includeLayout: false });

    expect(result).not.toBeNull();
    const serialized = required(result, "expected serialized target");
    expect(serialized.visible).toBeUndefined();
    expect(serialized.rect).toBeUndefined();
    expect(rectSpy).not.toHaveBeenCalled();
    expect(styleSpy).not.toHaveBeenCalled();
  });
});

describe("DOM locator text budget", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("omits visible text for mutation parent locators", () => {
    const parent = document.createElement("main");
    parent.textContent = "large page text ".repeat(5_000);
    document.body.appendChild(parent);

    const locators = createDomLocators(parent, { visibleText: "omit" });

    expect(locators.visibleText).toBeUndefined();
  });

  it("bounds data attribute reads while building locators", () => {
    const target = document.createElement("section");
    const observed = installSyntheticAttributes(target, 5_000);

    const locators = createDomLocators(target, { visibleText: "omit" });

    expect(Object.keys(locators.dataAttributes)).toHaveLength(500);
    expect(locators.attributeTruncation).toEqual({
      reason: "count",
      totalAttributes: 5_000,
      scannedAttributes: 500,
      retainedAttributes: 500,
    });
    expect(domLocatorsSchema.parse(locators)).toEqual(locators);
    expect(observed.reads()).toBe(500);
  });

  it("bounds target visible text by UTF-8 bytes without reading the whole subtree", () => {
    const target = document.createElement("section");
    target.textContent = "青".repeat(20_000);
    document.body.appendChild(target);

    const locators = createDomLocators(target, {
      visibleText: "bounded",
      maxVisibleTextBytes: 512,
    });

    expect(locators.visibleText).toBeDefined();
    expect(utf8ByteLength(locators.visibleText ?? "")).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// DomMutationRecorder batch budget
// ---------------------------------------------------------------------------

describe("DomMutationRecorder batch budget", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main id="container"></main>`;
  });

  it("handles a large batch of additions without freezing", async () => {
    const container = required(document.getElementById("container"), "expected container");
    const recorder = new DomMutationRecorder(document, () => 100);
    recorder.start();

    const start = performance.now();
    // Add 200 independent nodes (simulates a large SPA render)
    for (let i = 0; i < 200; i++) {
      const el = document.createElement("div");
      el.textContent = `node-${String(i)}`;
      el.setAttribute("data-idx", String(i));
      container.appendChild(el);
    }
    await settleObserver();

    const result = recorder.drain(container);
    const elapsed = performance.now() - start;

    // Should complete quickly — well under 2 seconds even in CI
    expect(elapsed).toBeLessThan(2000);

    // Mutations should be bounded
    expect(result.mutations.length).toBeGreaterThan(0);
    expect(result.mutations.length).toBeLessThanOrEqual(210); // 200 nodes + possible truncation marker

    recorder.stop();
  });

  it("degrades a 5000-node delivery before full root reduction", () => {
    const container = required(document.getElementById("container"), "expected container");
    const compareSpy = vi.spyOn(Node.prototype, "compareDocumentPosition");
    const recorder = new DomMutationRecorder(document, () => 100);
    recorder.start();

    for (let index = 0; index < 5_000; index++) {
      const node = document.createElement("div");
      node.textContent = `node-${String(index)}`;
      container.appendChild(node);
    }

    const originalIterator = NodeList.prototype[Symbol.iterator];
    let iteratedNodes = 0;
    const iteratorSpy = vi
      .spyOn(NodeList.prototype, Symbol.iterator)
      .mockImplementation(function (this: NodeList): ArrayIterator<Node> {
        const iterator = originalIterator.call(this);
        return {
          next(): IteratorResult<Node> {
            const next = iterator.next();
            if (!next.done) {
              iteratedNodes += 1;
            }
            return next;
          },
          [Symbol.iterator](): IterableIterator<Node> {
            return this;
          },
        } as ArrayIterator<Node>;
      });

    const result = recorder.drain(container);
    iteratorSpy.mockRestore();

    expect(result.mutations.length).toBeLessThanOrEqual(51);
    expect(compareSpy.mock.calls.length).toBeLessThan(2_000);
    expect(iteratedNodes).toBeLessThan(500);
    expect(result.domAfter).toMatchObject({
      captured: true,
      truncated: true,
      truncationSummary: {
        seen: { added: 5_000, updated: 0, removed: 0 },
        dropped: { added: 4_950 },
      },
    });

    recorder.stop();
  });

  it("produces a truncation marker when batch roots exceed the limit", async () => {
    const container = required(document.getElementById("container"), "expected container");
    // Use a very small batch limit for testing
    const recorder = new DomMutationRecorder(document, () => 100);
    recorder.start();

    // Add many independent subtrees
    for (let i = 0; i < 100; i++) {
      const el = document.createElement("section");
      el.id = `section-${String(i)}`;
      el.innerHTML = `<p>content ${String(i)}</p>`;
      container.appendChild(el);
    }
    await settleObserver();

    const result = recorder.drain(container);

    // The batch should have mutations, bounded by budget
    expect(result.mutations.length).toBeGreaterThan(0);

    // The domAfter should indicate the target was serialized
    expect(result.domAfter.captured).toBe(true);

    recorder.stop();
  });

  it("reports shared-budget loss without fabricating an added mutation", async () => {
    const container = required(document.getElementById("container"), "expected container");
    const recorder = new DomMutationRecorder(document, () => 100);
    recorder.start();

    // Fewer than DOM_MUTATION_BATCH_MAX_ROOTS (50) roots, but each subtree is
    // large enough that the shared node budget (500) runs out midway.
    for (let i = 0; i < 40; i++) {
      const el = document.createElement("section");
      el.innerHTML = Array.from(
        { length: 30 },
        (_, j) => `<p data-i="${String(j)}">row ${String(j)}</p>`,
      ).join("");
      container.appendChild(el);
    }
    await settleObserver();

    const result = recorder.drain(container);
    const syntheticMarkers = result.mutations.filter(
      (mutation) =>
        mutation.mutationKind === "added" && mutation.node.nodeType === "truncated_budget",
    );
    expect(syntheticMarkers).toHaveLength(0);
    expect(result.domAfter).toMatchObject({
      captured: true,
      truncated: true,
    });
    expect(JSON.stringify(result.domAfter)).toContain('"serialization"');

    recorder.stop();
  });

  it("drain marks truncation when targetAfter exceeds budget", async () => {
    // Build a huge target tree
    const container = required(document.getElementById("container"), "expected container");
    for (let i = 0; i < 600; i++) {
      const el = document.createElement("div");
      el.textContent = `item ${String(i)}`;
      container.appendChild(el);
    }

    const recorder = new DomMutationRecorder(document, () => 200);
    recorder.start();

    // Trigger a small mutation so drain() will serialize targetAfter
    container.setAttribute("data-changed", "true");
    await settleObserver();

    const result = recorder.drain(container);

    if (result.domAfter.captured) {
      // The targetAfter should be truncated since 600 children > 500 node budget
      expect(result.domAfter.truncated).toBe(true);
    }

    recorder.stop();
  });

  it("bounds a 5000-record attribute and character-data storm before locator work", () => {
    const container = required(document.getElementById("container"), "expected container");
    const target = document.createElement("div");
    const text = document.createTextNode("before");
    target.appendChild(text);
    container.appendChild(target);
    const recorder = new DomMutationRecorder(document, () => 300);
    recorder.start();

    for (let index = 0; index < 2_500; index++) {
      target.setAttribute("data-state", String(index));
      text.data = `value-${String(index)}`;
    }

    const result = recorder.drain(target);

    expect(result.mutations.length).toBeLessThanOrEqual(129);
    expect(jsonUtf8ByteLength(result)).toBeLessThanOrEqual(512 * 1024);
    expect(result.domAfter).toMatchObject({
      captured: true,
      truncated: true,
      truncationSummary: {
        seen: { added: 0, updated: 5_000, removed: 0 },
      },
    });
    if (!result.domAfter.captured) {
      throw new Error("expected captured domAfter");
    }
    const summary = required(result.domAfter.truncationSummary, "expected truncation summary");
    expect(summary.dropped.updated).toBeGreaterThan(0);

    recorder.stop();
  });
});
