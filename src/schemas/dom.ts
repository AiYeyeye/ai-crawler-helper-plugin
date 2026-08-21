import { z } from "zod";
import { domRecordIdSchema, gapIdSchema, sessionIdSchema, stepIdSchema } from "../shared/ids";
import { absentSchema, epochMsSchema, schemaVersionSchema } from "./common";

/**
 * DOM facts (PRD 4.3–4.5, design 7).
 *
 * DOM is stored as structured JSON only — never HTML strings or files.
 * The serializer (subtask 02/03) produces these shapes; this module owns the
 * persisted contract.
 */

// ---------------------------------------------------------------------------
// Locators
// ---------------------------------------------------------------------------

export const domAttributeTruncationSchema = z
  .object({
    reason: z.enum(["count", "bytes"]),
    totalAttributes: z.number().int().nonnegative(),
    scannedAttributes: z.number().int().nonnegative(),
    retainedAttributes: z.number().int().nonnegative(),
  })
  .strict();
export type DomAttributeTruncation = z.infer<typeof domAttributeTruncationSchema>;

export const domLocatorsSchema = z
  .object({
    cssSelector: z.string(),
    xpath: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    dataAttributes: z.record(z.string()),
    ariaRole: z.string().optional(),
    ariaName: z.string().optional(),
    visibleText: z.string().optional(),
    attributeTruncation: domAttributeTruncationSchema.optional(),
  })
  .strict();
export type DomLocators = z.infer<typeof domLocatorsSchema>;

export const domRectSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();
export type DomRect = z.infer<typeof domRectSchema>;

// ---------------------------------------------------------------------------
// Node tree (recursive)
// ---------------------------------------------------------------------------

export const domNodeTypeSchema = z.enum(["element", "text", "shadow_root", "iframe_boundary", "truncated_budget"]);

const formStateSchema = z
  .object({
    value: z.string().optional(),
    checked: z.boolean().optional(),
    selectedOptions: z.array(z.string()).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();
export type DomFormState = z.infer<typeof formStateSchema>;

export interface DomNode {
  nodeType: z.infer<typeof domNodeTypeSchema>;
  tagName?: string | undefined;
  attributes?: Record<string, string> | undefined;
  text?: string | undefined;
  formState?: DomFormState | undefined;
  visible?: boolean | undefined;
  rect?: DomRect | undefined;
  /** Open shadow root boundary marker. Closed roots are never expanded. */
  shadowRootMode?: "open" | "closed_boundary" | undefined;
  /** iframe boundary: frame is captured separately under its own scope. */
  frameBoundary?:
    | { accessible: boolean; frameUrl?: string | undefined; reason?: string | undefined }
    | undefined;
  children?: DomNode[] | undefined;
  /** Present when the element's raw attribute collection was only partially inspected. */
  attributeTruncation?: DomAttributeTruncation | undefined;
  /** Present when nodeType is "truncated_budget". */
  truncationReason?: "depth" | "nodes" | "bytes" | undefined;
}

export const domNodeSchema: z.ZodType<DomNode> = z.lazy(() =>
  z
    .object({
      nodeType: domNodeTypeSchema,
      tagName: z.string().optional(),
      attributes: z.record(z.string()).optional(),
      text: z.string().optional(),
      formState: formStateSchema.optional(),
      visible: z.boolean().optional(),
      rect: domRectSchema.optional(),
      shadowRootMode: z.enum(["open", "closed_boundary"]).optional(),
      frameBoundary: z
        .object({
          accessible: z.boolean(),
          frameUrl: z.string().optional(),
          reason: z.string().optional(),
        })
        .strict()
        .optional(),
      children: z.array(domNodeSchema).optional(),
      attributeTruncation: domAttributeTruncationSchema.optional(),
      truncationReason: z.enum(["depth", "nodes", "bytes"]).optional(),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Filtered target boundary (PRD 4.3: svg/canvas targets keep minimal facts)
// ---------------------------------------------------------------------------

export const filteredTargetBoundarySchema = z
  .object({
    tagName: z.string(),
    attributes: z.record(z.string()),
    locators: domLocatorsSchema,
    rect: domRectSchema,
    filteredReason: z.enum(["script", "svg", "canvas", "noscript", "plugin_owned"]),
    attributeTruncation: domAttributeTruncationSchema.optional(),
  })
  .strict();
export type FilteredTargetBoundary = z.infer<typeof filteredTargetBoundarySchema>;

// ---------------------------------------------------------------------------
// DomCapture — the `domBefore` of a user-action step
// ---------------------------------------------------------------------------

export const shadowHostChainEntrySchema = z
  .object({ tagName: z.string(), locators: domLocatorsSchema, mode: z.enum(["open", "closed"]) })
  .strict();

export const domCaptureSchema = z
  .object({
    /** The real event target. Filtered-type targets keep only their boundary. */
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("node"), node: domNodeSchema }).strict(),
      z
        .object({
          kind: z.literal("filtered_boundary"),
          boundary: filteredTargetBoundarySchema,
          /** Nearest unfiltered business ancestor, fully expanded. */
          nearestBusinessAncestor: domNodeSchema,
        })
        .strict(),
    ]),
    locators: domLocatorsSchema,
    /** Ordered chain: target's parent up to and including body. */
    parentChain: z.array(domNodeSchema),
    shadowHostChain: z.array(shadowHostChainEntrySchema),
    /** Path of ancestor iframes from top document to the target's frame. */
    iframePath: z.array(z.object({ frameUrl: z.string().optional(), locators: domLocatorsSchema }).strict()),
    capturedAt: epochMsSchema,
  })
  .strict();
export type DomCapture = z.infer<typeof domCaptureSchema>;

// ---------------------------------------------------------------------------
// domAfter — discriminated: captured / not captured with explicit reason
// ---------------------------------------------------------------------------

export const domAfterSchema = z.discriminatedUnion("captured", [
  z
    .object({
      captured: z.literal(true),
      targetAfter: domNodeSchema.optional(),
      mutationSummary: z
        .object({ added: z.number().int(), updated: z.number().int(), removed: z.number().int() })
        .strict(),
      capturedAt: epochMsSchema,
      /** True when serialization budget was exceeded (task 08). */
      truncated: z.boolean().optional(),
      truncationSummary: z
        .object({
          reasons: z
            .array(z.enum(["records", "bytes", "roots", "serialization"]))
            .min(1),
          seen: z
            .object({ added: z.number().int(), updated: z.number().int(), removed: z.number().int() })
            .strict(),
          retained: z
            .object({ added: z.number().int(), updated: z.number().int(), removed: z.number().int() })
            .strict(),
          dropped: z
            .object({ added: z.number().int(), updated: z.number().int(), removed: z.number().int() })
            .strict(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      captured: z.literal(false),
      reason: z.enum([
        "document_replaced",
        "no_local_result",
        "not_applicable_system_step",
        "missing_due_to_gap",
      ]),
      gapId: gapIdSchema.optional(),
    })
    .strict(),
]);
export type DomAfter = z.infer<typeof domAfterSchema>;

// ---------------------------------------------------------------------------
// Mutation records (PRD 4.4)
// ---------------------------------------------------------------------------

export const domMutationSchema = z.discriminatedUnion("mutationKind", [
  z
    .object({
      mutationKind: z.literal("added"),
      node: domNodeSchema,
      parentLocators: domLocatorsSchema,
      observedAt: epochMsSchema,
    })
    .strict(),
  z
    .object({
      mutationKind: z.literal("updated"),
      targetLocators: domLocatorsSchema,
      attribute: z.string().optional(),
      before: z.string().optional(),
      after: z.string().optional(),
      formStateAfter: formStateSchema.optional(),
      observedAt: epochMsSchema,
    })
    .strict(),
  z
    .object({
      mutationKind: z.literal("removed"),
      node: domNodeSchema,
      parentLocators: domLocatorsSchema,
      observedAt: epochMsSchema,
    })
    .strict(),
]);
export type DomMutation = z.infer<typeof domMutationSchema>;

// ---------------------------------------------------------------------------
// Persisted DOM record (one row in the `domRecords` store)
// ---------------------------------------------------------------------------

export const domRecordSchema = z
  .object({
    schemaVersion: schemaVersionSchema,
    domRecordId: domRecordIdSchema,
    sessionId: sessionIdSchema,
    /** Step the record belongs to per its role. */
    stepId: stepIdSchema,
    role: z.enum(["dom_before", "dom_after", "mutation_batch"]),
    /** Exactly one of the payloads applies per role. */
    payload: z.discriminatedUnion("role", [
      z.object({ role: z.literal("dom_before"), capture: domCaptureSchema }).strict(),
      z.object({ role: z.literal("dom_after"), after: domAfterSchema }).strict(),
      z
        .object({
          role: z.literal("mutation_batch"),
          mutations: z.array(domMutationSchema),
          observedDuringStepId: stepIdSchema,
          inFlightRequestKeys: z.array(z.string()),
        })
        .strict(),
    ]),
    recordedAt: epochMsSchema,
  })
  .strict()
  .superRefine((rec, ctx) => {
    if (rec.role !== rec.payload.role) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `role mismatch: record role ${rec.role} != payload role ${rec.payload.role}`,
      });
    }
  });
export type DomRecord = z.infer<typeof domRecordSchema>;

export const isDomRecord = (value: unknown): value is DomRecord =>
  domRecordSchema.safeParse(value).success;

export { absentSchema as domAbsentSchema };
