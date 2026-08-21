import { actionRecordSchema, type ActionRecord, type ModifierKeys } from "../schemas/action";
import type { DomCapture, DomLocators } from "../schemas/dom";
import {
  newCandidateToken,
  type CandidateToken,
} from "../shared/ids";
import {
  captureDomTarget,
  createDomLocators,
  isPluginOwned,
  readFormState,
} from "./dom-serializer";

export type CandidateResult = "dom_change" | "network_request";

export interface CapturedActionObservation {
  action: ActionRecord;
  domBefore: DomCapture;
  /** True only for hover/scroll observations that were promoted by a result. */
  candidate: boolean;
}

export type CandidateLifecycleObservation =
  | {
      kind: "started";
      token: CandidateToken;
      type: "input" | "hover" | "scroll";
      startedAt: number;
      domBefore: DomCapture;
    }
  | {
      kind: "completed";
      token: CandidateToken;
      observation: CapturedActionObservation;
    }
  | {
      kind: "cancelled";
      token: CandidateToken;
      type: "input" | "hover" | "scroll";
      reason:
        | "pointer_leave"
        | "quiet_window"
        | "replaced_by_candidate"
        | "replaced_by_action"
        | "stopped";
    };

export interface ActionRecorderOptions {
  inputQuietWindowMs: number;
  hoverDwellThresholdMs: number;
  scrollQuietWindowMs: number;
  now: () => number;
  newCandidateToken: () => CandidateToken;
  onCandidateLifecycle?: (observation: CandidateLifecycleObservation) => void;
}

const DEFAULT_OPTIONS: ActionRecorderOptions = {
  inputQuietWindowMs: 800,
  hoverDwellThresholdMs: 500,
  scrollQuietWindowMs: 800,
  now: () => Date.now(),
  newCandidateToken,
};

type InputEndedBy = NonNullable<ActionRecord["inputBatch"]>["endedBy"];
type DragEventKind = NonNullable<ActionRecord["dragDrop"]>["events"][number];

interface InputBeforeSnapshot {
  value: string;
  domBefore: DomCapture;
  inputType: string;
}

interface InputBatchState {
  token: CandidateToken;
  target: Element;
  domBefore: DomCapture;
  valueBefore: string;
  valueAfter: string;
  inputType: string;
  batchStartedAt: number;
  batchEndedAt: number;
  files?: { name: string; type: string; sizeBytes: number }[];
}

interface HoverCandidate {
  token: CandidateToken;
  target: Element;
  domBefore: DomCapture;
  startedAt: number;
  modifiers: ModifierKeys;
  thresholdTimer: ReturnType<typeof setTimeout>;
}

interface ScrollCandidate {
  token: CandidateToken;
  target: Element;
  domBefore: DomCapture;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  quietTimer: ReturnType<typeof setTimeout>;
}

interface DragState {
  source: Element;
  domBefore: DomCapture;
  events: DragEventKind[];
  targetLocators?: DomLocators;
}

const EMPTY_MODIFIERS: ModifierKeys = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

const NON_BATCH_INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);

const modifiersOf = (event: Event): ModifierKeys => {
  if (event instanceof MouseEvent || event instanceof KeyboardEvent) {
    return {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    };
  }
  return { ...EMPTY_MODIFIERS };
};

const eventTargetElement = (event: Event): Element | null => {
  const firstPathNode = event.composedPath().find((node) => node instanceof Element);
  if (firstPathNode instanceof Element) {
    return firstPathNode;
  }
  return event.target instanceof Element ? event.target : null;
};

const actionFormState = (element: Element): ActionRecord["formStateAtEvent"] => {
  const state = readFormState(element);
  if (state === undefined) {
    return undefined;
  }
  return {
    ...(state.value === undefined ? {} : { value: state.value }),
    ...(state.checked === undefined ? {} : { checked: state.checked }),
    ...(state.selectedOptions === undefined ? {} : { selectedOptions: state.selectedOptions }),
  };
};

const formValue = (element: Element): string => {
  const state = readFormState(element);
  return state?.value ?? "";
};

const fileMetadata = (
  element: Element,
): { name: string; type: string; sizeBytes: number }[] | undefined => {
  if (!(element instanceof HTMLInputElement) || element.type !== "file" || element.files === null) {
    return undefined;
  }
  return [...element.files].map((file) => ({
    name: file.name,
    type: file.type,
    sizeBytes: file.size,
  }));
};

const isRecordedKey = (event: KeyboardEvent): boolean =>
  event.key === "Enter" ||
  event.key === "Escape" ||
  event.key === "Tab" ||
  event.ctrlKey ||
  event.altKey ||
  event.metaKey;

const contentEditableValue = (element: HTMLElement): unknown => element.isContentEditable;

const isContentEditableElement = (element: Element): boolean =>
  element instanceof HTMLElement && contentEditableValue(element) === true;

const isBatchInputTarget = (element: Element): boolean => {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (isContentEditableElement(element)) {
    return true;
  }
  if (!(element instanceof HTMLInputElement)) {
    return false;
  }
  return !NON_BATCH_INPUT_TYPES.has(element.type);
};

const isDocumentScroller = (documentValue: Document, element: Element): boolean =>
  element === documentValue.scrollingElement || element === documentValue.documentElement;

export class ActionRecorder {
  private readonly options: ActionRecorderOptions;
  private readonly beforeInput = new WeakMap<Element, InputBeforeSnapshot>();
  private readonly beforePointerAction = new WeakMap<Element, DomCapture>();
  private readonly scrollPositions = new WeakMap<Element, { x: number; y: number }>();
  private readonly listeners: { type: string; listener: EventListener }[] = [];
  private inputBatch: InputBatchState | null = null;
  private inputTimer: ReturnType<typeof setTimeout> | null = null;
  private hoverCandidate: HoverCandidate | null = null;
  private scrollCandidate: ScrollCandidate | null = null;
  private dragState: DragState | null = null;
  private started = false;

  constructor(
    private readonly documentValue: Document,
    private readonly onCapture: (observation: CapturedActionObservation) => void,
    options: Partial<ActionRecorderOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.listen("pointerdown", this.onPointerDown);
    this.listen("click", this.onPointerAction);
    this.listen("dblclick", this.onPointerAction);
    this.listen("contextmenu", this.onPointerAction);
    this.listen("change", this.onChange);
    this.listen("submit", this.onSubmit);
    this.listen("beforeinput", this.onBeforeInput);
    this.listen("input", this.onInput);
    this.listen("blur", this.onBlur);
    this.listen("keydown", this.onKeydown);
    this.listen("pointerenter", this.onPointerEnter);
    this.listen("pointerleave", this.onPointerLeave);
    this.listen("scroll", this.onScroll);
    this.listen("dragstart", this.onDragEvent);
    this.listen("drag", this.onDragEvent);
    this.listen("dragenter", this.onDragEvent);
    this.listen("dragover", this.onDragEvent);
    this.listen("drop", this.onDragEvent);
    this.listen("dragend", this.onDragEvent);
  }

  stop(): void {
    if (!this.started) {
      return;
    }
    this.flushInput("stop");
    this.clearHoverCandidate("stopped");
    this.clearScrollCandidate("stopped");
    if (this.dragState !== null) {
      this.emitDrag();
    }
    for (const { type, listener } of this.listeners) {
      this.documentValue.removeEventListener(type, listener, true);
    }
    this.listeners.length = 0;
    this.started = false;
  }

  notifyCandidateResult(result: CandidateResult): void {
    if (this.hoverCandidate !== null) {
      const candidate = this.hoverCandidate;
      this.clearHoverCandidate();
      this.emit(
        {
          type: "hover",
          occurredAt: this.options.now(),
          modifiers: candidate.modifiers,
          hover: {
            dwellMs: Math.max(0, this.options.now() - candidate.startedAt),
            thresholdMs: this.options.hoverDwellThresholdMs,
            promotedBy: result,
          },
        },
        candidate.domBefore,
        true,
        candidate.token,
      );
    }
    if (this.scrollCandidate !== null) {
      const candidate = this.scrollCandidate;
      this.clearScrollCandidate();
      this.emit(
        {
          type: "scroll",
          occurredAt: this.options.now(),
          modifiers: { ...EMPTY_MODIFIERS },
          scroll: {
            fromX: candidate.fromX,
            fromY: candidate.fromY,
            toX: candidate.toX,
            toY: candidate.toY,
            ...(isDocumentScroller(this.documentValue, candidate.target)
              ? {}
              : { containerLocators: createDomLocators(candidate.target) }),
          },
        },
        candidate.domBefore,
        true,
        candidate.token,
      );
    }
  }

  private listen(type: string, listener: EventListener): void {
    this.documentValue.addEventListener(type, listener, true);
    this.listeners.push({ type, listener });
  }

  private readonly onPointerDown: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    const capture = captureDomTarget(target, this.options.now());
    if (capture !== null) {
      this.beforePointerAction.set(target, capture);
    }
  };

  private readonly onPointerAction: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    this.clearPassiveCandidates();
    this.flushInput("next_action");
    const domBefore =
      this.beforePointerAction.get(target) ?? captureDomTarget(target, this.options.now());
    this.beforePointerAction.delete(target);
    if (domBefore === null) {
      return;
    }
    const type = event.type as "click" | "dblclick" | "contextmenu";
    const pointer =
      event instanceof MouseEvent
        ? {
            button: event.button,
            clientX: event.clientX,
            clientY: event.clientY,
            pageX: event.pageX,
            pageY: event.pageY,
          }
        : undefined;
    const formStateAtEvent = actionFormState(target);
    this.emit(
      {
        type,
        occurredAt: this.options.now(),
        modifiers: modifiersOf(event),
        ...(pointer === undefined ? {} : { pointer }),
        ...(formStateAtEvent === undefined ? {} : { formStateAtEvent }),
      },
      domBefore,
      false,
    );
  };

  private readonly onChange: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    this.clearPassiveCandidates();
    this.flushInput("change");
    this.emitImmediate("change", target, event);
  };

  private readonly onSubmit: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    this.clearPassiveCandidates();
    this.flushInput("submit");
    this.emitImmediate("submit", target, event);
  };

  private emitImmediate(
    type: "change" | "submit",
    target: Element,
    event: Event,
  ): void {
    const domBefore = captureDomTarget(target, this.options.now());
    if (domBefore === null) {
      return;
    }
    const formStateAtEvent = actionFormState(target);
    this.emit(
      {
        type,
        occurredAt: this.options.now(),
        modifiers: modifiersOf(event),
        ...(formStateAtEvent === undefined ? {} : { formStateAtEvent }),
      },
      domBefore,
      false,
    );
  }

  private readonly onBeforeInput: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target) || !isBatchInputTarget(target)) {
      return;
    }
    if (this.inputBatch !== null && this.inputBatch.target === target) {
      return;
    }
    const domBefore = captureDomTarget(target, this.options.now());
    if (domBefore === null) {
      return;
    }
    this.beforeInput.set(target, {
      value: formValue(target),
      domBefore,
      inputType: event instanceof InputEvent ? event.inputType : "",
    });
  };

  private readonly onInput: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target) || !isBatchInputTarget(target)) {
      return;
    }
    if (this.inputBatch !== null && this.inputBatch.target !== target) {
      this.flushInput("next_action");
    }
    const now = this.options.now();
    if (this.inputBatch === null) {
      this.clearPassiveCandidates("replaced_by_action");
      const before = this.beforeInput.get(target);
      const domBefore = before?.domBefore ?? captureDomTarget(target, now);
      if (domBefore === null) {
        return;
      }
      const inputType =
        event instanceof InputEvent && event.inputType.length > 0
          ? event.inputType
          : before?.inputType ?? "unknown";
      const files = fileMetadata(target);
      this.inputBatch = {
        token: this.options.newCandidateToken(),
        target,
        domBefore,
        valueBefore: before?.value ?? "",
        valueAfter: formValue(target),
        inputType,
        batchStartedAt: now,
        batchEndedAt: now,
        ...(files === undefined ? {} : { files }),
      };
      this.emitCandidateLifecycle({
        kind: "started",
        token: this.inputBatch.token,
        type: "input",
        startedAt: now,
        domBefore,
      });
      this.beforeInput.delete(target);
    } else {
      this.inputBatch.valueAfter = formValue(target);
      this.inputBatch.batchEndedAt = now;
      if (event instanceof InputEvent && event.inputType.length > 0) {
        this.inputBatch.inputType = event.inputType;
      }
      const files = fileMetadata(target);
      if (files !== undefined) {
        this.inputBatch.files = files;
      }
    }
    this.armInputTimer();
  };

  private readonly onBlur: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target !== null && this.inputBatch?.target === target) {
      this.flushInput("blur");
    }
  };

  private armInputTimer(): void {
    if (this.inputTimer !== null) {
      clearTimeout(this.inputTimer);
    }
    this.inputTimer = setTimeout(() => {
      this.flushInput("quiet_window");
    }, this.options.inputQuietWindowMs);
  }

  private flushInput(endedBy: InputEndedBy): void {
    if (this.inputTimer !== null) {
      clearTimeout(this.inputTimer);
      this.inputTimer = null;
    }
    const batch = this.inputBatch;
    this.inputBatch = null;
    if (batch === null) {
      return;
    }
    const formStateAtEvent = actionFormState(batch.target);
    this.emit(
      {
        type: "input",
        occurredAt: batch.batchStartedAt,
        modifiers: { ...EMPTY_MODIFIERS },
        inputBatch: {
          valueBefore: batch.valueBefore,
          valueAfter: batch.valueAfter,
          inputType: batch.inputType,
          isContentEditable: isContentEditableElement(batch.target),
          batchStartedAt: batch.batchStartedAt,
          batchEndedAt: this.options.now(),
          endedBy,
          ...(batch.files === undefined ? {} : { files: batch.files }),
        },
        ...(formStateAtEvent === undefined ? {} : { formStateAtEvent }),
      },
      batch.domBefore,
      false,
      batch.token,
    );
  }

  private readonly onKeydown: EventListener = (event) => {
    if (!(event instanceof KeyboardEvent) || !isRecordedKey(event)) {
      return;
    }
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    this.clearPassiveCandidates();
    this.flushInput("next_action");
    const domBefore = captureDomTarget(target, this.options.now());
    if (domBefore === null) {
      return;
    }
    this.emit(
      {
        type: "keydown",
        occurredAt: this.options.now(),
        modifiers: modifiersOf(event),
        keydown: {
          key: event.key,
          code: event.code,
          modifiers: modifiersOf(event),
        },
      },
      domBefore,
      false,
    );
  };

  private readonly onPointerEnter: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    this.clearScrollCandidate("replaced_by_candidate");
    this.clearHoverCandidate("replaced_by_candidate");
    const startedAt = this.options.now();
    const domBefore = captureDomTarget(target, startedAt);
    if (domBefore === null) {
      return;
    }
    const thresholdTimer = setTimeout(() => {
      // Dwell alone is not a promotion condition. The timer only keeps the
      // candidate alive until a DOM/network result arrives or pointerleave.
    }, this.options.hoverDwellThresholdMs);
    this.hoverCandidate = {
      token: this.options.newCandidateToken(),
      target,
      domBefore,
      startedAt,
      modifiers: modifiersOf(event),
      thresholdTimer,
    };
    this.emitCandidateLifecycle({
      kind: "started",
      token: this.hoverCandidate.token,
      type: "hover",
      startedAt,
      domBefore,
    });
  };

  private readonly onPointerLeave: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target !== null && this.hoverCandidate?.target === target) {
      this.clearHoverCandidate("pointer_leave");
    }
  };

  private clearHoverCandidate(
    reason?: Extract<CandidateLifecycleObservation, { kind: "cancelled" }>[
      "reason"
    ],
  ): void {
    if (this.hoverCandidate !== null) {
      const token = this.hoverCandidate.token;
      clearTimeout(this.hoverCandidate.thresholdTimer);
      this.hoverCandidate = null;
      if (reason !== undefined) {
        this.emitCandidateLifecycle({ kind: "cancelled", token, type: "hover", reason });
      }
    }
  }

  private readonly onScroll: EventListener = (event) => {
    const eventTarget = event.target;
    const target =
      eventTarget instanceof Element
        ? eventTarget
        : this.documentValue.scrollingElement ?? this.documentValue.documentElement;
    if (isPluginOwned(target)) {
      return;
    }
    this.clearHoverCandidate("replaced_by_candidate");
    const current = {
      x: target.scrollLeft,
      y: target.scrollTop,
    };
    if (this.scrollCandidate === null || this.scrollCandidate.target !== target) {
      this.clearScrollCandidate("replaced_by_candidate");
      const previous = this.scrollPositions.get(target) ?? { x: 0, y: 0 };
      const domBefore = captureDomTarget(target, this.options.now());
      if (domBefore === null) {
        return;
      }
      const quietTimer = setTimeout(() => {
        this.clearScrollCandidate("quiet_window");
      }, this.options.scrollQuietWindowMs);
      this.scrollCandidate = {
        token: this.options.newCandidateToken(),
        target,
        domBefore,
        fromX: previous.x,
        fromY: previous.y,
        toX: current.x,
        toY: current.y,
        quietTimer,
      };
      this.emitCandidateLifecycle({
        kind: "started",
        token: this.scrollCandidate.token,
        type: "scroll",
        startedAt: this.options.now(),
        domBefore,
      });
    } else {
      this.scrollCandidate.toX = current.x;
      this.scrollCandidate.toY = current.y;
      clearTimeout(this.scrollCandidate.quietTimer);
      this.scrollCandidate.quietTimer = setTimeout(() => {
        this.clearScrollCandidate("quiet_window");
      }, this.options.scrollQuietWindowMs);
    }
    this.scrollPositions.set(target, current);
  };

  private clearScrollCandidate(
    reason?: Extract<CandidateLifecycleObservation, { kind: "cancelled" }>[
      "reason"
    ],
  ): void {
    if (this.scrollCandidate !== null) {
      const token = this.scrollCandidate.token;
      clearTimeout(this.scrollCandidate.quietTimer);
      this.scrollCandidate = null;
      if (reason !== undefined) {
        this.emitCandidateLifecycle({ kind: "cancelled", token, type: "scroll", reason });
      }
    }
  }

  private readonly onDragEvent: EventListener = (event) => {
    const target = eventTargetElement(event);
    if (target === null || isPluginOwned(target)) {
      return;
    }
    const kind = event.type as DragEventKind;
    if (kind === "dragstart") {
      this.clearPassiveCandidates();
      this.flushInput("next_action");
      const domBefore = captureDomTarget(target, this.options.now());
      if (domBefore === null) {
        return;
      }
      this.dragState = { source: target, domBefore, events: ["dragstart"] };
      return;
    }
    if (this.dragState === null) {
      return;
    }
    this.dragState.events.push(kind);
    if (kind === "drop") {
      this.dragState.targetLocators = createDomLocators(target);
      this.emitDrag();
    } else if (kind === "dragend") {
      this.emitDrag();
    }
  };

  private emitDrag(): void {
    const state = this.dragState;
    this.dragState = null;
    if (state === null) {
      return;
    }
    this.emit(
      {
        type: "drag_drop",
        occurredAt: this.options.now(),
        modifiers: { ...EMPTY_MODIFIERS },
        dragDrop: {
          sourceLocators: createDomLocators(state.source),
          ...(state.targetLocators === undefined ? {} : { targetLocators: state.targetLocators }),
          events: state.events,
        },
      },
      state.domBefore,
      false,
    );
  }

  private clearPassiveCandidates(
    reason: Extract<CandidateLifecycleObservation, { kind: "cancelled" }>[
      "reason"
    ] = "replaced_by_action",
  ): void {
    this.clearHoverCandidate(reason);
    this.clearScrollCandidate(reason);
  }

  private emitCandidateLifecycle(observation: CandidateLifecycleObservation): void {
    this.options.onCandidateLifecycle?.(observation);
  }

  private emit(
    action: ActionRecord,
    domBefore: DomCapture,
    candidate: boolean,
    candidateToken?: CandidateToken,
  ): void {
    const observation = {
      action: actionRecordSchema.parse(action),
      domBefore,
      candidate,
    };
    if (candidateToken !== undefined) {
      this.emitCandidateLifecycle({ kind: "completed", token: candidateToken, observation });
      return;
    }
    this.onCapture(observation);
  }
}
