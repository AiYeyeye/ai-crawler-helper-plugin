// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { DomMutationRecorder } from "../../src/content/mutation-recorder";

interface ElementConstructor<T extends Element> {
  new (): T;
}

const requireElement = <T extends Element>(
  selector: string,
  Constructor: ElementConstructor<T>,
): T => {
  const element = document.querySelector(selector);
  if (!(element instanceof Constructor)) {
    throw new Error(`missing fixture element: ${selector}`);
  }
  return element;
};

const settleObserver = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("DomMutationRecorder", () => {
  beforeEach(() => {
    document.body.innerHTML = `<main><ul id="rates"></ul><input id="query" value="old"></main>`;
  });

  it("notifies the controller when a local mutation batch becomes available", async () => {
    const observedTargets: Element[] = [];
    const list = requireElement("#rates", HTMLUListElement);
    const recorder = new DomMutationRecorder(
      document,
      () => 20,
      (target) => observedTargets.push(target),
    );
    recorder.start();

    list.append(document.createElement("li"));
    await settleObserver();

    expect(observedTargets).toEqual([list]);
    recorder.stop();
  });

  it("merges nested additions into a minimal root and captures the final target state", async () => {
    const list = requireElement("#rates", HTMLUListElement);
    const recorder = new DomMutationRecorder(document, () => 20);
    recorder.start();

    const item = document.createElement("li");
    item.id = "rate-1";
    item.innerHTML = `<strong>USD 1200</strong>`;
    list.append(item);
    const strong = item.querySelector("strong");
    if (strong === null) {
      throw new Error("missing strong fixture");
    }
    strong.setAttribute("data-ready", "true");
    await settleObserver();

    const result = recorder.drain(list);

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]?.mutationKind).toBe("added");
    expect(JSON.stringify(result.mutations[0])).toContain("USD 1200");
    expect(result.domAfter).toMatchObject({
      captured: true,
      mutationSummary: { added: 1, updated: 0, removed: 0 },
    });
    if (!result.domAfter.captured) {
      throw new Error("expected captured domAfter");
    }
    expect(result.domAfter.targetAfter?.tagName).toBe("ul");
    recorder.stop();
  });

  it("records attribute/text updates and live form properties without relying on attributes", async () => {
    const input = requireElement("#query", HTMLInputElement);
    const recorder = new DomMutationRecorder(document, () => 30);
    recorder.start();

    input.setAttribute("aria-expanded", "true");
    input.value = "runtime-value";
    await settleObserver();

    const result = recorder.drain(input);

    expect(result.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mutationKind: "updated",
          attribute: "aria-expanded",
          after: "true",
        }),
      ]),
    );
    if (!result.domAfter.captured) {
      throw new Error("expected captured domAfter");
    }
    expect(result.domAfter.targetAfter?.formState?.value).toBe("runtime-value");
    recorder.stop();
  });

  it("records character data before and after values", async () => {
    const list = requireElement("#rates", HTMLUListElement);
    list.innerHTML = `<li><span id="price">USD 1000</span></li>`;
    const price = requireElement("#price", HTMLSpanElement);
    const text = price.firstChild;
    if (!(text instanceof Text)) {
      throw new Error("missing price text fixture");
    }
    const recorder = new DomMutationRecorder(document, () => 35);
    recorder.start();

    text.data = "USD 1200";
    await settleObserver();

    const result = recorder.drain(price);
    expect(result.mutations).toEqual([
      expect.objectContaining({
        mutationKind: "updated",
        before: "USD 1000",
        after: "USD 1200",
      }),
    ]);
    recorder.stop();
  });

  it("serializes removed nodes before they become unreachable", async () => {
    const list = requireElement("#rates", HTMLUListElement);
    list.innerHTML = `<li id="removed"><span>old rate</span></li>`;
    const recorder = new DomMutationRecorder(document, () => 40);
    recorder.start();

    requireElement("#removed", HTMLLIElement).remove();
    await settleObserver();

    const result = recorder.drain(list);

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]).toMatchObject({ mutationKind: "removed" });
    expect(JSON.stringify(result.mutations[0])).toContain("old rate");
    recorder.stop();
  });

  it("returns no_local_result for a quiet candidate and document_replaced after navigation", () => {
    const list = requireElement("#rates", HTMLUListElement);
    const recorder = new DomMutationRecorder(document, () => 50);
    recorder.start();

    expect(recorder.drain(list).domAfter).toEqual({
      captured: false,
      reason: "no_local_result",
    });

    recorder.markDocumentReplaced();
    expect(recorder.drain(list).domAfter).toEqual({
      captured: false,
      reason: "document_replaced",
    });
  });

  it("ignores plugin-owned and filtered mutations", async () => {
    const list = requireElement("#rates", HTMLUListElement);
    const recorder = new DomMutationRecorder(document, () => 60);
    recorder.start();

    const owned = document.createElement("div");
    owned.setAttribute("data-ai-crawler-helper-owned", "true");
    owned.textContent = "extension UI";
    list.append(owned);
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = "{}";
    list.append(script);
    await settleObserver();

    const result = recorder.drain(list);
    expect(result.mutations).toEqual([]);
    expect(result.domAfter).toEqual({ captured: false, reason: "no_local_result" });
    recorder.stop();
  });
});
