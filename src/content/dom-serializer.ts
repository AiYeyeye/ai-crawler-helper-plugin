import type {
  DomCapture,
  DomFormState,
  DomLocators,
  DomNode,
  DomRect,
  FilteredTargetBoundary,
} from "../schemas/dom";
import {
  DOM_LOCATOR_VISIBLE_TEXT_MAX_BYTES,
  DOM_SERIALIZE_MAX_ATTRIBUTES,
  DOM_SERIALIZE_MAX_DEPTH,
  DOM_SERIALIZE_MAX_NODES,
  DOM_SERIALIZE_MAX_BYTES,
} from "../core/config";
import { utf8ByteLength } from "../shared/json-bytes";

export const PLUGIN_OWNED_ATTRIBUTE = "data-ai-crawler-helper-owned";

// ---------------------------------------------------------------------------
// Serialization budget (task 08: dom-capture-budget)
// ---------------------------------------------------------------------------

/**
 * Tracks depth / node-count / byte consumption during recursive DOM
 * serialization.  A single instance is shared across the entire call tree
 * rooted at one `serializeDomNode()` invocation.
 */
export class SerializeBudget {
  nodes = 0;
  attributes = 0;
  bytes = 0;
  truncated = false;
  truncationReason: "depth" | "nodes" | "bytes" | undefined;
  /**
   * True only when the shared node/byte pool is spent. Depth truncation is a
   * local condition of one branch and must NOT stop sibling serialization,
   * so it sets `truncated` (for reporting) but never `exhausted`.
   */
  exhausted = false;

  constructor(
    readonly maxDepth: number = DOM_SERIALIZE_MAX_DEPTH,
    readonly maxNodes: number = DOM_SERIALIZE_MAX_NODES,
    readonly maxBytes: number = DOM_SERIALIZE_MAX_BYTES,
    readonly maxAttributes: number = DOM_SERIALIZE_MAX_ATTRIBUTES,
  ) {}

  /** Mark truncation; the first global node/byte exhaustion wins its reason. */
  exhaust(reason: "depth" | "nodes" | "bytes"): void {
    this.truncated = true;
    if (reason === "depth") {
      if (this.truncationReason === undefined) {
        this.truncationReason = reason;
      }
      return;
    }
    if (!this.exhausted) {
      this.truncationReason = reason;
    }
    this.exhausted = true;
  }

  /** Account for one node; returns false when budget is now exhausted. */
  countNode(estimatedBytes: number): boolean {
    this.nodes++;
    if (this.nodes > this.maxNodes) {
      this.exhaust("nodes");
      return false;
    }
    return this.consumeBytes(estimatedBytes);
  }

  /** Admit one attribute read without consuming the independent DOM node quota. */
  countAttribute(): boolean {
    if (this.attributes >= this.maxAttributes) {
      this.truncated = true;
      return false;
    }
    this.attributes += 1;
    return true;
  }

  /** Admit bytes before materializing the corresponding DOM data. */
  consumeBytes(estimatedBytes: number): boolean {
    if (this.bytes + estimatedBytes > this.maxBytes) {
      this.exhaust("bytes");
      return false;
    }
    this.bytes += estimatedBytes;
    return true;
  }
}

type FilteredReason = FilteredTargetBoundary["filteredReason"];
type AttributeTruncation = NonNullable<DomNode["attributeTruncation"]>;

interface AttributeCollection {
  readonly attributes: Record<string, string>;
  readonly attributeTruncation?: AttributeTruncation;
}

const lowerTagName = (element: Element): string => element.tagName.toLowerCase();

const escapeCssIdentifier = (value: string): string =>
  value.replace(/(^-?\d)|[^a-zA-Z0-9_-]/g, (match, leadingDigit: string | undefined) =>
    leadingDigit === undefined
      ? `\\${match.codePointAt(0)?.toString(16) ?? ""} `
      : `\\3${leadingDigit} `,
  );

const normalizeText = (value: string | null): string | undefined => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
};

const collectAttributes = (
  element: Element,
  budget: SerializeBudget,
  include: (attribute: Attr) => boolean = () => true,
): AttributeCollection => {
  const attributes: Record<string, string> = {};
  const totalAttributes = element.attributes.length;
  let scannedAttributes = 0;
  let retainedAttributes = 0;
  let reason: AttributeTruncation["reason"] | undefined;
  for (let index = 0; index < totalAttributes; index += 1) {
    if (!budget.countAttribute()) {
      reason = "count";
      break;
    }
    const attribute = element.attributes.item(index);
    if (attribute === null) {
      continue;
    }
    scannedAttributes += 1;
    const estimatedBytes = utf8ByteLength(attribute.name) + utf8ByteLength(attribute.value) + 10;
    if (!budget.consumeBytes(estimatedBytes)) {
      reason = "bytes";
      break;
    }
    if (include(attribute)) {
      attributes[attribute.name] = attribute.value;
      retainedAttributes += 1;
    }
  }
  return {
    attributes,
    ...(reason === undefined
      ? {}
      : {
          attributeTruncation: {
            reason,
            totalAttributes,
            scannedAttributes,
            retainedAttributes,
          },
        }),
  };
};

const attributesOf = (element: Element): Record<string, string> =>
  collectAttributes(element, new SerializeBudget()).attributes;

const budgetedAttributesOf = (
  element: Element,
  budget: SerializeBudget,
): AttributeCollection => collectAttributes(element, budget);

const rectOf = (element: Element): DomRect => {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
};

const isVisible = (element: Element): boolean => {
  if (element instanceof HTMLElement && element.hidden) {
    return false;
  }
  const view = element.ownerDocument.defaultView;
  if (view === null) {
    return true;
  }
  const style = view.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
};

export const readFormState = (element: Element): DomFormState | undefined => {
  if (element instanceof HTMLInputElement) {
    const state: DomFormState = {
      value: element.value,
      disabled: element.disabled,
    };
    if (element.type === "checkbox" || element.type === "radio") {
      state.checked = element.checked;
    }
    return state;
  }
  if (element instanceof HTMLTextAreaElement) {
    return { value: element.value, disabled: element.disabled };
  }
  if (element instanceof HTMLSelectElement) {
    return {
      value: element.value,
      selectedOptions: [...element.selectedOptions].map((option) => option.value),
      disabled: element.disabled,
    };
  }
  if (element instanceof HTMLOptionElement) {
    return { value: element.value, selectedOptions: element.selected ? [element.value] : [] };
  }
  if (element instanceof HTMLButtonElement) {
    return { value: element.value, disabled: element.disabled };
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return { value: element.textContent ?? "" };
  }
  return undefined;
};

const dataAttributesOf = (element: Element): AttributeCollection =>
  collectAttributes(
    element,
    new SerializeBudget(),
    (attribute) => attribute.name.startsWith("data-"),
  );

const ariaNameOf = (element: Element): string | undefined => {
  const direct = normalizeText(element.getAttribute("aria-label"));
  if (direct !== undefined) {
    return direct;
  }
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const value = labelledBy
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
      .join(" ");
    const normalized = normalizeText(value);
    if (normalized !== undefined) {
      return normalized;
    }
  }
  return normalizeText(element.getAttribute("title"));
};

const cssSelectorOf = (element: Element): string => {
  if (element.id.length > 0) {
    return `#${escapeCssIdentifier(element.id)}`;
  }
  const segments: string[] = [];
  let current: Element = element;
  for (;;) {
    const tagName = lowerTagName(current);
    const parent = current.parentElement;
    if (!(parent instanceof Element)) {
      segments.unshift(tagName);
      break;
    }
    const sameTagSiblings = [...parent.children].filter(
      (sibling) => lowerTagName(sibling) === tagName,
    );
    const suffix =
      sameTagSiblings.length <= 1
        ? ""
        : `:nth-of-type(${String(sameTagSiblings.indexOf(current) + 1)})`;
    segments.unshift(`${tagName}${suffix}`);
    current = parent;
    if (tagName === "body") {
      break;
    }
  }
  return segments.join(" > ");
};

const xpathOf = (element: Element): string => {
  const segments: string[] = [];
  let current: Element | null = element;
  while (current !== null) {
    const tagName = lowerTagName(current);
    const parent: Element | null = current.parentElement;
    const sameTagSiblings =
      parent === null
        ? [current]
        : [...parent.children].filter((sibling) => lowerTagName(sibling) === tagName);
    const index = sameTagSiblings.indexOf(current) + 1;
    segments.unshift(`${tagName}[${String(index)}]`);
    if (tagName === "html") {
      break;
    }
    current = parent;
  }
  return `/${segments.join("/")}`;
};

export interface DomLocatorOptions {
  readonly visibleText?: "bounded" | "omit";
  readonly maxVisibleTextBytes?: number;
}

const boundedVisibleText = (element: Element, maxBytes: number): string | undefined => {
  const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let output = "";
  let bytes = 0;
  let pendingSpace = false;
  for (let current = walker.nextNode(); current !== null; current = walker.nextNode()) {
    for (const character of current.nodeValue ?? "") {
      if (/\s/u.test(character)) {
        pendingSpace = output.length > 0;
        continue;
      }
      const addition = `${pendingSpace ? " " : ""}${character}`;
      const additionBytes = utf8ByteLength(addition);
      if (bytes + additionBytes > maxBytes) {
        return output.length === 0 ? undefined : output;
      }
      output += addition;
      bytes += additionBytes;
      pendingSpace = false;
    }
  }
  return output.length === 0 ? undefined : output;
};

export const createDomLocators = (
  element: Element,
  options: DomLocatorOptions = {},
): DomLocators => {
  const dataAttributes = dataAttributesOf(element);
  const id = normalizeText(element.getAttribute("id"));
  const name = normalizeText(element.getAttribute("name"));
  const ariaRole = normalizeText(element.getAttribute("role"));
  const ariaName = ariaNameOf(element);
  const visibleText =
    options.visibleText === "omit"
      ? undefined
      : boundedVisibleText(
          element,
          options.maxVisibleTextBytes ?? DOM_LOCATOR_VISIBLE_TEXT_MAX_BYTES,
        );
  return {
    cssSelector: cssSelectorOf(element),
    xpath: xpathOf(element),
    dataAttributes: dataAttributes.attributes,
    ...(dataAttributes.attributeTruncation === undefined
      ? {}
      : { attributeTruncation: dataAttributes.attributeTruncation }),
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(ariaRole === undefined ? {} : { ariaRole }),
    ...(ariaName === undefined ? {} : { ariaName }),
    ...(visibleText === undefined ? {} : { visibleText }),
  };
};

export const isPluginOwned = (node: Node): boolean => {
  let element = node instanceof Element ? node : node.parentElement;
  while (element !== null) {
    if (element.getAttribute(PLUGIN_OWNED_ATTRIBUTE) === "true") {
      return true;
    }
    element = element.parentElement;
  }
  return false;
};

export const filteredReasonOf = (element: Element): FilteredReason | null => {
  if (isPluginOwned(element)) {
    return "plugin_owned";
  }
  if (element.namespaceURI === "http://www.w3.org/2000/svg") {
    return "svg";
  }
  const tagName = lowerTagName(element);
  if (tagName === "svg") {
    return "svg";
  }
  if (tagName === "canvas") {
    return "canvas";
  }
  if (tagName === "script") {
    return "script";
  }
  if (tagName === "noscript") {
    return "noscript";
  }
  return null;
};

const serializeShadowRootBudgeted = (
  root: ShadowRoot,
  budget: SerializeBudget,
  depth: number,
): DomNode => {
  if (depth >= budget.maxDepth) {
    budget.exhaust("depth");
    return { nodeType: "truncated_budget", truncationReason: "depth" };
  }
  if (!budget.countNode(40)) {
    return { nodeType: "truncated_budget", truncationReason: budget.truncationReason };
  }
  const children: DomNode[] = [];
  for (let index = 0; index < root.childNodes.length && !budget.exhausted; index += 1) {
    const child = root.childNodes.item(index);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- childNodes.item can return null per DOM spec
    if (child === null) {
      continue;
    }
    const serialized = serializeNodeBudgeted(child, budget, depth + 1);
    if (serialized !== null) {
      children.push(serialized);
    }
  }
  return {
    nodeType: "shadow_root",
    shadowRootMode: "open",
    ...(children.length === 0 ? {} : { children }),
  };
};

const iframeBoundary = (
  element: HTMLIFrameElement,
  includeLayout: boolean,
  attributes = attributesOf(element),
): DomNode => {
  let accessible = false;
  let reason: string | undefined;
  try {
    accessible = element.contentDocument !== null;
    if (!accessible) {
      reason = "permission_or_origin_boundary";
    }
  } catch {
    reason = "permission_or_origin_boundary";
  }
  const frameUrl = element.getAttribute("src") ?? undefined;
  return {
    nodeType: "iframe_boundary",
    tagName: "iframe",
    attributes,
    ...(includeLayout ? { visible: isVisible(element), rect: rectOf(element) } : {}),
    frameBoundary: {
      accessible,
      ...(frameUrl === undefined ? {} : { frameUrl }),
      ...(reason === undefined ? {} : { reason }),
    },
  };
};

/**
 * Internal budget-aware recursive serializer.
 *
 * `includeLayout` controls whether `isVisible()` / `rectOf()` are called for
 * this element.  Only the root element of each public `serializeDomNode()`
 * invocation sets this to `true`; recursive children skip layout reads to
 * avoid O(n) forced reflow (R2).
 */
const serializeNodeBudgeted = (
  node: Node,
  budget: SerializeBudget,
  depth: number,
  includeLayout = false,
): DomNode | null => {
  if (budget.exhausted) return null;

  if (node.nodeType === Node.TEXT_NODE) {
    if (isPluginOwned(node)) return null;
    const text = normalizeText(node.textContent);
    if (text === undefined) return null;
    if (!budget.countNode(30 + utf8ByteLength(text))) {
      return { nodeType: "truncated_budget", truncationReason: budget.truncationReason };
    }
    return { nodeType: "text", text };
  }

  if (!(node instanceof Element)) return null;
  if (filteredReasonOf(node) !== null) return null;

  if (depth >= budget.maxDepth) {
    budget.exhaust("depth");
    return { nodeType: "truncated_budget", truncationReason: "depth" };
  }

  if (!budget.countNode(80)) {
    return { nodeType: "truncated_budget", truncationReason: budget.truncationReason };
  }
  const attrs = budgetedAttributesOf(node, budget);

  if (node instanceof HTMLIFrameElement) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhausted is mutable state
    const children: DomNode[] = budget.exhausted
      ? [{ nodeType: "truncated_budget", truncationReason: budget.truncationReason }]
      : [];
    return {
      ...iframeBoundary(node, includeLayout, attrs.attributes),
      ...(attrs.attributeTruncation === undefined
        ? {}
        : { attributeTruncation: attrs.attributeTruncation }),
      ...(children.length === 0 ? {} : { children }),
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhausted is mutable state
  const children: DomNode[] = budget.exhausted
    ? [{ nodeType: "truncated_budget", truncationReason: budget.truncationReason }]
    : [];
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhausted is mutable state
  for (let index = 0; index < node.childNodes.length && !budget.exhausted; index += 1) {
    const child = node.childNodes.item(index);
    const serialized = serializeNodeBudgeted(child, budget, depth + 1);
    if (serialized !== null) {
      children.push(serialized);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- exhausted is mutable state
  if (node.shadowRoot !== null && !budget.exhausted) {
    children.push(serializeShadowRootBudgeted(node.shadowRoot, budget, depth + 1));
  }

  const formState = readFormState(node);
  return {
    nodeType: "element",
    tagName: lowerTagName(node),
    attributes: attrs.attributes,
    ...(attrs.attributeTruncation === undefined
      ? {}
      : { attributeTruncation: attrs.attributeTruncation }),
    ...(includeLayout ? { visible: isVisible(node), rect: rectOf(node) } : {}),
    ...(formState === undefined ? {} : { formState }),
    ...(children.length === 0 ? {} : { children }),
  };
};

export interface SerializeDomNodeOptions {
  readonly includeLayout?: boolean;
}

export const serializeDomNode = (
  node: Node,
  budget?: SerializeBudget,
  options: SerializeDomNodeOptions = {},
): DomNode | null =>
  serializeNodeBudgeted(node, budget ?? new SerializeBudget(), 0, options.includeLayout ?? true);

export const serializeClosedShadowHost = (host: Element): DomNode => {
  const attributes = collectAttributes(host, new SerializeBudget());
  return {
    nodeType: "element",
    tagName: lowerTagName(host),
    ...attributes,
    visible: isVisible(host),
    rect: rectOf(host),
    shadowRootMode: "closed_boundary",
  };
};

const serializeShallowElement = (element: Element): DomNode => {
  const formState = readFormState(element);
  const attributes = collectAttributes(element, new SerializeBudget());
  return {
    nodeType: element instanceof HTMLIFrameElement ? "iframe_boundary" : "element",
    tagName: lowerTagName(element),
    ...attributes,
    visible: isVisible(element),
    rect: rectOf(element),
    ...(formState === undefined ? {} : { formState }),
    ...(element instanceof HTMLIFrameElement
      ? { frameBoundary: iframeBoundary(element, true, attributes.attributes).frameBoundary }
      : {}),
  };
};

const parentElementAcrossShadow = (node: Node): Element | null => {
  if (node.parentElement !== null) {
    return node.parentElement;
  }
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
};

const parentChainOf = (target: Element): DomNode[] => {
  const chain: DomNode[] = [];
  let current = parentElementAcrossShadow(target);
  while (current !== null) {
    if (!isPluginOwned(current) && filteredReasonOf(current) === null) {
      chain.push(serializeShallowElement(current));
    }
    if (lowerTagName(current) === "body") {
      break;
    }
    current = parentElementAcrossShadow(current);
  }
  return chain;
};

const shadowHostChainOf = (target: Element): DomCapture["shadowHostChain"] => {
  const chain: DomCapture["shadowHostChain"] = [];
  let root: Node = target.getRootNode();
  while (root instanceof ShadowRoot) {
    chain.push({
      tagName: lowerTagName(root.host),
      locators: createDomLocators(root.host),
      mode: root.mode,
    });
    root = root.host.getRootNode();
  }
  return chain;
};

const iframePathOf = (documentValue: Document): DomCapture["iframePath"] => {
  const path: DomCapture["iframePath"] = [];
  let view = documentValue.defaultView;
  while (view !== null) {
    try {
      const frameElement = view.frameElement;
      if (!(frameElement instanceof HTMLIFrameElement)) {
        break;
      }
      const frameUrl = frameElement.getAttribute("src") ?? undefined;
      path.unshift({
        ...(frameUrl === undefined ? {} : { frameUrl }),
        locators: createDomLocators(frameElement),
      });
      view = frameElement.ownerDocument.defaultView;
    } catch {
      break;
    }
  }
  return path;
};

const filteredBoundaryOf = (
  target: Element,
  filteredReason: Exclude<FilteredReason, "plugin_owned">,
): FilteredTargetBoundary => {
  const attributes = collectAttributes(target, new SerializeBudget());
  return {
    tagName: lowerTagName(target),
    ...attributes,
    locators: createDomLocators(target),
    rect: rectOf(target),
    filteredReason,
  };
};

const nearestBusinessAncestor = (target: Element): DomNode => {
  let current = parentElementAcrossShadow(target);
  while (current !== null) {
    const tagName = lowerTagName(current);
    if (
      tagName !== "body" &&
      tagName !== "html" &&
      !isPluginOwned(current) &&
      filteredReasonOf(current) === null
    ) {
      return serializeDomNode(current) ?? serializeShallowElement(current);
    }
    current = parentElementAcrossShadow(current);
  }
  return serializeShallowElement(target.ownerDocument.body);
};

export const captureDomTarget = (target: Element, capturedAt: number): DomCapture | null => {
  if (isPluginOwned(target)) {
    return null;
  }
  const filteredReason = filteredReasonOf(target);
  const captureTarget: DomCapture["target"] =
    filteredReason === null
      ? { kind: "node", node: serializeDomNode(target) ?? serializeShallowElement(target) }
      : {
          kind: "filtered_boundary",
          boundary: filteredBoundaryOf(
            target,
            filteredReason === "plugin_owned" ? "script" : filteredReason,
          ),
          nearestBusinessAncestor: nearestBusinessAncestor(target),
        };
  return {
    target: captureTarget,
    locators: createDomLocators(target),
    parentChain: parentChainOf(target),
    shadowHostChain: shadowHostChainOf(target),
    iframePath: iframePathOf(target.ownerDocument),
    capturedAt,
  };
};
