/** Expected while a hard pause drains already-delivered browser events. */
export const isExpectedFactGateClosure = (cause: unknown): boolean =>
  cause instanceof Error &&
  cause.message.includes("persistence rejected: SESSION_NOT_ACCEPTING_FACTS");
