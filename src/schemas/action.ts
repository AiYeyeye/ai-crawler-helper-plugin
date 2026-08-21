import { z } from "zod";
import { epochMsSchema } from "./common";
import { domLocatorsSchema } from "./dom";

/**
 * User action facts (PRD 4.2, design 5).
 * The `ActionRecord` is embedded in a UserActionStep; it never exists for
 * system steps (discriminated union enforces that).
 */

export const userActionTypeSchema = z.enum([
  "click",
  "dblclick",
  "contextmenu",
  "input",
  "change",
  "submit",
  "hover",
  "keydown",
  "scroll",
  "drag_drop",
]);
export type UserActionType = z.infer<typeof userActionTypeSchema>;

export const modifierKeysSchema = z
  .object({
    ctrl: z.boolean(),
    alt: z.boolean(),
    shift: z.boolean(),
    meta: z.boolean(),
  })
  .strict();
export type ModifierKeys = z.infer<typeof modifierKeysSchema>;

const pointerDetailSchema = z
  .object({
    button: z.number().int(),
    clientX: z.number(),
    clientY: z.number(),
    pageX: z.number(),
    pageY: z.number(),
  })
  .strict();

/**
 * Input batch (PRD 4.2): consecutive input on one node merged; passwords and
 * hidden inputs recorded verbatim (no masking); file inputs keep name/type/size
 * metadata only.
 */
const inputBatchSchema = z
  .object({
    valueBefore: z.string(),
    valueAfter: z.string(),
    inputType: z.string(),
    isContentEditable: z.boolean(),
    batchStartedAt: epochMsSchema,
    batchEndedAt: epochMsSchema,
    endedBy: z.enum(["quiet_window", "change", "blur", "submit", "next_action", "stop"]),
    files: z
      .array(
        z.object({ name: z.string(), type: z.string(), sizeBytes: z.number().int() }).strict(),
      )
      .optional(),
  })
  .strict();

const keydownDetailSchema = z
  .object({
    key: z.string(),
    code: z.string(),
    modifiers: modifierKeysSchema,
  })
  .strict();

const scrollDetailSchema = z
  .object({
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    /** Scroll container locators; absent means document scroll. */
    containerLocators: domLocatorsSchema.optional(),
  })
  .strict();

const dragDropDetailSchema = z
  .object({
    sourceLocators: domLocatorsSchema,
    targetLocators: domLocatorsSchema.optional(),
    events: z.array(z.enum(["dragstart", "drag", "dragenter", "dragover", "drop", "dragend"])),
  })
  .strict();

const hoverDetailSchema = z
  .object({
    dwellMs: z.number().int().nonnegative(),
    thresholdMs: z.number().int().nonnegative(),
    promotedBy: z.enum(["dwell_threshold", "dom_change", "network_request"]),
  })
  .strict();

const formStateAtEventSchema = z
  .object({
    value: z.string().optional(),
    checked: z.boolean().optional(),
    selectedOptions: z.array(z.string()).optional(),
  })
  .strict();

export const actionRecordSchema = z
  .object({
    type: userActionTypeSchema,
    occurredAt: epochMsSchema,
    modifiers: modifierKeysSchema,
    pointer: pointerDetailSchema.optional(),
    inputBatch: inputBatchSchema.optional(),
    keydown: keydownDetailSchema.optional(),
    scroll: scrollDetailSchema.optional(),
    dragDrop: dragDropDetailSchema.optional(),
    hover: hoverDetailSchema.optional(),
    /** Explicitly-read DOM properties at event time (PRD 4.2 property rule). */
    formStateAtEvent: formStateAtEventSchema.optional(),
  })
  .strict()
  .superRefine((action, ctx) => {
    const requires: Partial<Record<UserActionType, keyof typeof action>> = {
      input: "inputBatch",
      keydown: "keydown",
      scroll: "scroll",
      drag_drop: "dragDrop",
      hover: "hover",
    };
    const requiredField = requires[action.type];
    if (requiredField !== undefined && action[requiredField] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `action type ${action.type} requires field ${requiredField}`,
      });
    }
  });
export type ActionRecord = z.infer<typeof actionRecordSchema>;
