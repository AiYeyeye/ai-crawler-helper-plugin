// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  captureDomTarget,
  serializeClosedShadowHost,
  serializeDomNode,
} from "../../src/content/dom-serializer";

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

describe("DOM serializer", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("captures the exact target subtree and a shallow parent chain without a page snapshot", () => {
    document.body.innerHTML = `
      <section id="unrelated">must-not-be-captured</section>
      <main data-page="quote">
        <article id="card" data-kind="rate-card">
          <button id="submit" name="submitRate" aria-label="Search rates" style="color:red">
            Search <span>now</span>
          </button>
        </article>
      </main>
    `;
    const button = requireElement("#submit", HTMLButtonElement);

    const capture = captureDomTarget(button, 1_700_000_000_000);

    expect(capture).not.toBeNull();
    expect(capture?.target.kind).toBe("node");
    if (capture?.target.kind !== "node") {
      throw new Error("expected node capture");
    }
    expect(capture.target.node.tagName).toBe("button");
    expect(capture.target.node.attributes).toMatchObject({
      id: "submit",
      name: "submitRate",
      "aria-label": "Search rates",
      style: "color:red",
    });
    expect(capture.target.node.children?.[1]?.tagName).toBe("span");
    expect(capture.parentChain.map((node) => node.tagName)).toEqual([
      "article",
      "main",
      "body",
    ]);
    expect(capture.parentChain.every((node) => node.children === undefined)).toBe(true);
    expect(JSON.stringify(capture)).not.toContain("must-not-be-captured");
    expect(capture.locators.id).toBe("submit");
    expect(capture.locators.name).toBe("submitRate");
    expect(capture.locators.ariaName).toBe("Search rates");
  });

  it("preserves style, hidden controls, raw attributes and live form properties", () => {
    document.body.innerHTML = `
      <div id="form-root">
        <style>.secret { display:none }</style>
        <input id="password" type="password" value="attribute-value" data-private="yes">
        <input id="hidden" type="hidden" value="hidden-attribute">
        <select id="region" multiple>
          <option value="cn" selected>China</option>
          <option value="de">Germany</option>
        </select>
        <script>ignored()</script>
        <!-- ignored comment -->
      </div>
    `;
    const root = requireElement("#form-root", HTMLDivElement);
    const password = requireElement("#password", HTMLInputElement);
    const hidden = requireElement("#hidden", HTMLInputElement);
    const region = requireElement("#region", HTMLSelectElement);
    password.value = "runtime-password";
    hidden.value = "runtime-hidden";
    const germany = region.options.item(1);
    if (germany === null) {
      throw new Error("missing Germany option fixture");
    }
    germany.selected = true;

    const node = serializeDomNode(root);

    expect(node?.children?.some((child) => child.tagName === "style")).toBe(true);
    expect(node?.children?.some((child) => child.tagName === "script")).toBe(false);
    const passwordNode = node?.children?.find((child) => child.tagName === "input");
    expect(passwordNode?.attributes?.["data-private"]).toBe("yes");
    expect(passwordNode?.formState?.value).toBe("runtime-password");
    const hiddenNode = node?.children?.filter((child) => child.tagName === "input")[1];
    expect(hiddenNode?.formState?.value).toBe("runtime-hidden");
    const selectNode = node?.children?.find((child) => child.tagName === "select");
    expect(selectNode?.formState?.selectedOptions).toEqual(["cn", "de"]);
  });

  it("records filtered SVG targets as a boundary and promotes the nearest business ancestor", () => {
    document.body.innerHTML = `
      <main>
        <article id="chart-card">
          <svg id="chart" data-series="rates"><path id="line"></path></svg>
        </article>
      </main>
    `;
    const path = requireElement("#line", SVGElement);

    const capture = captureDomTarget(path, 10);

    expect(capture?.target.kind).toBe("filtered_boundary");
    if (capture?.target.kind !== "filtered_boundary") {
      throw new Error("expected filtered boundary capture");
    }
    expect(capture.target.boundary.tagName).toBe("path");
    expect(capture.target.boundary.filteredReason).toBe("svg");
    expect(capture.target.nearestBusinessAncestor.tagName).toBe("article");
    expect(JSON.stringify(capture.target.nearestBusinessAncestor)).not.toContain("<svg");
  });

  it("keeps form, table, dialog and dynamic-list business structures", () => {
    document.body.innerHTML = `
      <section id="fixture-root">
        <form><input name="origin" value="Qingdao"></form>
        <table><tbody><tr><td>USD 1200</td></tr></tbody></table>
        <dialog open>Rate details</dialog>
        <ul><li data-row="1">20GP</li><li data-row="2">40GP</li></ul>
      </section>
    `;
    const root = requireElement("#fixture-root", HTMLElement);

    const serialized = JSON.stringify(serializeDomNode(root));

    expect(serialized).toContain('"tagName":"form"');
    expect(serialized).toContain('"tagName":"table"');
    expect(serialized).toContain('"tagName":"dialog"');
    expect(serialized).toContain("USD 1200");
    expect(serialized).toContain("40GP");
  });

  it("records a Canvas target as a filtered boundary", () => {
    document.body.innerHTML = `<article id="canvas-card"><canvas id="chart"></canvas></article>`;
    const canvas = requireElement("#chart", HTMLCanvasElement);

    const capture = captureDomTarget(canvas, 10);

    expect(capture?.target.kind).toBe("filtered_boundary");
    if (capture?.target.kind !== "filtered_boundary") {
      throw new Error("expected Canvas boundary capture");
    }
    expect(capture.target.boundary.filteredReason).toBe("canvas");
    expect(capture.target.nearestBusinessAncestor.tagName).toBe("article");
  });

  it("ignores plugin-owned targets completely", () => {
    document.body.innerHTML = `<div data-ai-crawler-helper-owned="true"><button id="owned">x</button></div>`;
    const owned = requireElement("#owned", HTMLButtonElement);

    expect(captureDomTarget(owned, 10)).toBeNull();
  });

  it("expands open shadow roots and can represent a known closed boundary explicitly", () => {
    const host = document.createElement("quote-card");
    host.id = "open-host";
    document.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<button id="inside">Inside</button>`;

    const node = serializeDomNode(host);

    const shadow = node?.children?.find((child) => child.nodeType === "shadow_root");
    expect(shadow?.shadowRootMode).toBe("open");
    expect(shadow?.children?.[0]?.tagName).toBe("button");

    const closedHost = document.createElement("secure-widget");
    closedHost.setAttribute("data-version", "1");
    document.body.append(closedHost);
    const closed = serializeClosedShadowHost(closedHost);
    expect(closed.shadowRootMode).toBe("closed_boundary");
    expect(closed.attributes?.["data-version"]).toBe("1");
    expect(closed.children).toBeUndefined();
  });

  it("records iframe elements as explicit boundaries", () => {
    const iframe = document.createElement("iframe");
    iframe.src = "https://example.com/child";
    document.body.append(iframe);

    const node = serializeDomNode(iframe);

    expect(node?.nodeType).toBe("iframe_boundary");
    expect(node?.frameBoundary?.frameUrl).toBe("https://example.com/child");
    expect(typeof node?.frameBoundary?.accessible).toBe("boolean");
  });

  it("marks an inaccessible iframe explicitly instead of fabricating empty content", () => {
    const iframe = document.createElement("iframe");
    iframe.src = "https://cross-origin.example/child";
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      get: () => {
        throw new DOMException("Blocked a frame with origin", "SecurityError");
      },
    });
    document.body.append(iframe);

    const node = serializeDomNode(iframe);

    expect(node?.frameBoundary).toEqual({
      accessible: false,
      frameUrl: "https://cross-origin.example/child",
      reason: "permission_or_origin_boundary",
    });
    expect(node?.children).toBeUndefined();
  });
});
