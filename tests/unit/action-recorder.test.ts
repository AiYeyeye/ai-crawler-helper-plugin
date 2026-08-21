// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionRecorder,
  type CapturedActionObservation,
  type CandidateLifecycleObservation,
} from "../../src/content/action-recorder";
import { candidateTokenSchema } from "../../src/shared/ids";

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

describe("ActionRecorder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    document.body.innerHTML = `
      <form id="search-form">
        <input id="query" value="">
        <input id="password" type="password" value="">
        <input id="hidden" type="hidden" value="hidden-secret">
        <input id="file" type="file">
        <input id="remember" type="checkbox">
        <button id="submit" type="submit">Search</button>
      </form>
      <div id="scrollbox" tabindex="0"></div>
      <div id="hover-menu">Menu</div>
      <div id="drag-source" draggable="true">Source</div>
      <div id="drop-target">Target</div>
    `;
  });

  const startRecorder = (): {
    recorder: ActionRecorder;
    observations: CapturedActionObservation[];
  } => {
    const observations: CapturedActionObservation[] = [];
    const recorder = new ActionRecorder(
      document,
      (observation) => {
        observations.push(observation);
      },
      {
        onCandidateLifecycle: (observation) => {
          if (observation.kind === "completed") {
            observations.push(observation.observation);
          }
        },
      },
    );
    recorder.start();
    return { recorder, observations };
  };

  it("captures click pointer data, modifiers and explicit checkbox state", () => {
    const { recorder, observations } = startRecorder();
    const checkbox = requireElement("#remember", HTMLInputElement);
    checkbox.checked = true;

    checkbox.dispatchEvent(
      new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 12,
        clientY: 34,
        ctrlKey: true,
      }),
    );

    checkbox.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        button: 0,
        clientX: 12,
        clientY: 34,
        ctrlKey: true,
      }),
    );

    expect(observations.map((item) => item.action.type)).toEqual(["click", "change"]);
    const click = observations.find((item) => item.action.type === "click");
    expect(click?.action).toMatchObject({
      type: "click",
      modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      pointer: { button: 0, clientX: 12, clientY: 34 },
      formStateAtEvent: { value: "on", checked: false },
    });
    expect(click?.domBefore.locators.id).toBe("remember");
    if (click?.domBefore.target.kind !== "node") {
      throw new Error("expected checkbox node capture");
    }
    expect(click.domBefore.target.node.formState?.checked).toBe(true);
    recorder.stop();
  });

  it("merges consecutive input into one batch and keeps password values verbatim", () => {
    const { recorder, observations } = startRecorder();
    const password = requireElement("#password", HTMLInputElement);

    password.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: "s" }),
    );
    password.value = "s";
    password.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: "s" }),
    );
    password.value = "secret";
    password.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: "ecret" }),
    );

    expect(observations).toHaveLength(0);
    vi.advanceTimersByTime(800);

    expect(observations).toHaveLength(1);
    expect(observations[0]?.action.inputBatch).toMatchObject({
      valueBefore: "",
      valueAfter: "secret",
      inputType: "insertText",
      endedBy: "quiet_window",
    });
    expect(observations[0]?.action.formStateAtEvent?.value).toBe("secret");
    recorder.stop();
  });

  it("ends an input batch on change before emitting the change action", () => {
    const { recorder, observations } = startRecorder();
    const query = requireElement("#query", HTMLInputElement);
    query.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    query.value = "Qingdao";
    query.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    query.dispatchEvent(new Event("change", { bubbles: true }));

    expect(observations.map((item) => item.action.type)).toEqual(["input", "change"]);
    expect(observations[0]?.action.inputBatch?.endedBy).toBe("change");
    recorder.stop();
  });

  it("records file input metadata without reading file contents", () => {
    const { recorder, observations } = startRecorder();
    const input = requireElement("#file", HTMLInputElement);
    const file = new File(["sensitive-content"], "rates.csv", { type: "text/csv" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });

    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertFromPaste" }));
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertFromPaste" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const inputObservation = observations.find((item) => item.action.type === "input");
    expect(inputObservation?.action.inputBatch?.files).toEqual([
      { name: "rates.csv", type: "text/csv", sizeBytes: 17 },
    ]);
    expect(JSON.stringify(inputObservation)).not.toContain("sensitive-content");
    recorder.stop();
  });

  it("filters ordinary key presses but keeps navigation keys and shortcuts", () => {
    const { recorder, observations } = startRecorder();
    const query = requireElement("#query", HTMLInputElement);

    query.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a", code: "KeyA" }));
    query.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
    query.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "k", code: "KeyK", ctrlKey: true }),
    );

    expect(observations.map((item) => item.action.keydown?.key)).toEqual(["Enter", "k"]);
    recorder.stop();
  });

  it("does not emit quiet hover or scroll candidates and promotes them only after a result", () => {
    const { recorder, observations } = startRecorder();
    const menu = requireElement("#hover-menu", HTMLDivElement);
    menu.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    vi.advanceTimersByTime(500);
    menu.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    expect(observations).toHaveLength(0);

    menu.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    recorder.notifyCandidateResult("dom_change");
    expect(observations.map((item) => item.action.type)).toEqual(["hover"]);

    const scrollbox = requireElement("#scrollbox", HTMLDivElement);
    scrollbox.scrollTop = 10;
    scrollbox.dispatchEvent(new Event("scroll", { bubbles: true }));
    vi.advanceTimersByTime(800);
    expect(observations.map((item) => item.action.type)).toEqual(["hover"]);

    scrollbox.scrollTop = 40;
    scrollbox.dispatchEvent(new Event("scroll", { bubbles: true }));
    recorder.notifyCandidateResult("network_request");
    expect(observations.map((item) => item.action.type)).toEqual(["hover", "scroll"]);
    recorder.stop();
  });

  it("keeps only the latest passive candidate when hover is followed by scroll", () => {
    const { recorder, observations } = startRecorder();
    const menu = requireElement("#hover-menu", HTMLDivElement);
    const scrollbox = requireElement("#scrollbox", HTMLDivElement);

    menu.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    scrollbox.scrollTop = 25;
    scrollbox.dispatchEvent(new Event("scroll", { bubbles: true }));
    recorder.notifyCandidateResult("dom_change");

    expect(observations.map((item) => item.action.type)).toEqual(["scroll"]);
    recorder.stop();
  });

  it("reports candidate start/cancel boundaries before a candidate is promoted", () => {
    const lifecycle: CandidateLifecycleObservation[] = [];
    const observations: CapturedActionObservation[] = [];
    const recorder = new ActionRecorder(
      document,
      (observation) => observations.push(observation),
      { onCandidateLifecycle: (observation) => lifecycle.push(observation) },
    );
    recorder.start();
    const menu = requireElement("#hover-menu", HTMLDivElement);
    const scrollbox = requireElement("#scrollbox", HTMLDivElement);

    menu.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    scrollbox.scrollTop = 25;
    scrollbox.dispatchEvent(new Event("scroll", { bubbles: true }));

    expect(
      lifecycle.map((item) => [
        item.kind,
        item.kind === "completed" ? item.observation.action.type : item.type,
        item.kind === "cancelled" ? item.reason : undefined,
      ]),
    ).toEqual([
      ["started", "hover", undefined],
      ["cancelled", "hover", "replaced_by_candidate"],
      ["started", "scroll", undefined],
    ]);
    expect(observations).toHaveLength(0);

    vi.advanceTimersByTime(800);
    expect(lifecycle.at(-1)).toMatchObject({
      kind: "cancelled",
      type: "scroll",
      reason: "quiet_window",
    });
    recorder.stop();
  });

  it("completes a promoted candidate with the same token and never cancels it", () => {
    const lifecycle: CandidateLifecycleObservation[] = [];
    const token = candidateTokenSchema.parse("can_hover");
    const recorder = new ActionRecorder(document, () => undefined, {
      newCandidateToken: () => token,
      onCandidateLifecycle: (observation) => lifecycle.push(observation),
    });
    recorder.start();
    const menu = requireElement("#hover-menu", HTMLDivElement);

    menu.dispatchEvent(new Event("pointerenter", { bubbles: true }));
    recorder.notifyCandidateResult("dom_change");
    menu.dispatchEvent(new Event("pointerleave", { bubbles: true }));
    recorder.stop();

    expect(lifecycle.map((item) => item.kind)).toEqual(["started", "completed"]);
    expect(lifecycle.every((item) => item.token === token)).toBe(true);
    expect(lifecycle[1]).toMatchObject({
      kind: "completed",
      observation: { action: { type: "hover" }, candidate: true },
    });
  });

  it("starts an input candidate before the quiet-window action is emitted", () => {
    const lifecycle: CandidateLifecycleObservation[] = [];
    const observations: CapturedActionObservation[] = [];
    const recorder = new ActionRecorder(
      document,
      (observation) => observations.push(observation),
      { onCandidateLifecycle: (observation) => lifecycle.push(observation) },
    );
    recorder.start();
    const query = requireElement("#query", HTMLInputElement);

    query.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" }));
    query.value = "cargo";
    query.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));

    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]).toMatchObject({ kind: "started", type: "input" });
    expect(observations).toHaveLength(0);
    vi.advanceTimersByTime(800);
    expect(lifecycle.map((item) => item.kind)).toEqual(["started", "completed"]);
    expect(
      lifecycle.find((item) => item.kind === "completed")?.observation.action.type,
    ).toBe("input");
    recorder.stop();
  });

  it("captures the drag event sequence with source and drop target locators", () => {
    const { recorder, observations } = startRecorder();
    const source = requireElement("#drag-source", HTMLDivElement);
    const target = requireElement("#drop-target", HTMLDivElement);
    source.dispatchEvent(new Event("dragstart", { bubbles: true }));
    source.dispatchEvent(new Event("drag", { bubbles: true }));
    target.dispatchEvent(new Event("dragenter", { bubbles: true }));
    target.dispatchEvent(new Event("dragover", { bubbles: true }));
    target.dispatchEvent(new Event("drop", { bubbles: true }));
    source.dispatchEvent(new Event("dragend", { bubbles: true }));

    expect(observations).toHaveLength(1);
    expect(observations[0]?.action.dragDrop).toMatchObject({
      sourceLocators: { id: "drag-source" },
      targetLocators: { id: "drop-target" },
      events: ["dragstart", "drag", "dragenter", "dragover", "drop"],
    });
    recorder.stop();
  });
});
