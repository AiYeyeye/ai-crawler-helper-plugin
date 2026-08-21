import type { DebuggerCaptureContext, ResolvedNetworkRequestContext } from "./network-capture-controller";
import type { NavigationContextRepository } from "../persistence/navigation-context-repository";
import type { NetworkStateRepository } from "../persistence/network-state-repository";
import type { SessionRepository } from "../persistence/session-repository";
import { identifierMappingSchema, type IdentifierMappingKeyParts } from "../schemas/network";
import {
  cdpFrameIdSchema,
  cdpLoaderIdSchema,
  extFrameIdSchema,
} from "../shared/ids";

export interface NetworkRequestContextInput {
  url: string;
  frameId?: string;
  loaderId?: string;
}

export interface NetworkRequestContextResolverOptions {
  sessions: Pick<SessionRepository, "getControl">;
  networkState: Pick<NetworkStateRepository, "getIdentifierMapping">;
  navigationContexts: Pick<NavigationContextRepository, "getCurrentDocument">;
}

/** Resolves only explicit cross-space mappings; URL/time never confirm identity. */
export class NetworkRequestContextResolver {
  private readonly sessions: NetworkRequestContextResolverOptions["sessions"];
  private readonly networkState: NetworkRequestContextResolverOptions["networkState"];
  private readonly navigationContexts: NetworkRequestContextResolverOptions["navigationContexts"];

  constructor(options: NetworkRequestContextResolverOptions) {
    this.sessions = options.sessions;
    this.networkState = options.networkState;
    this.navigationContexts = options.navigationContexts;
  }

  async resolve(
    debuggerContext: DebuggerCaptureContext,
    input: NetworkRequestContextInput,
  ): Promise<ResolvedNetworkRequestContext | null> {
    void input.url;
    const control = await this.sessions.getControl(debuggerContext.sessionId);
    if (control === null) {
      return null;
    }
    const keyParts: IdentifierMappingKeyParts = {
      sessionId: debuggerContext.sessionId,
      tabId: debuggerContext.tabId,
      ...(debuggerContext.childSessionId === undefined
        ? {}
        : { childSessionId: debuggerContext.childSessionId }),
      attachEpoch: debuggerContext.attachEpoch,
      ...(input.frameId === undefined ? {} : { frameId: cdpFrameIdSchema.parse(input.frameId) }),
      ...(input.loaderId === undefined
        ? {}
        : { loaderId: cdpLoaderIdSchema.parse(input.loaderId) }),
    };
    const stored = await this.networkState.getIdentifierMapping(keyParts);
    if (stored?.mapping.state === "confirmed") {
      const ext = stored.mapping.ext;
      if (
        ext?.frameId !== undefined &&
        ext.documentId !== undefined &&
        ext.tabId === debuggerContext.tabId
      ) {
        const current = await this.navigationContexts.getCurrentDocument(
          debuggerContext.sessionId,
          debuggerContext.tabId,
          ext.frameId,
        );
        if (current?.documentId === ext.documentId) {
          return {
            stepContext: {
              sessionId: debuggerContext.sessionId,
              captureEpochId: control.captureEpochId,
              scope: {
                tabId: ext.tabId,
                frameId: ext.frameId,
                documentId: ext.documentId,
              },
            },
            identifierMapping: stored.mapping,
          };
        }
      }
    }

    const rootDocument = await this.navigationContexts.getCurrentDocument(
      debuggerContext.sessionId,
      debuggerContext.tabId,
      extFrameIdSchema.parse(0),
    );
    if (rootDocument === null) {
      return null;
    }
    const fallbackState =
      stored?.mapping.state ??
      (debuggerContext.childSessionId === undefined && input.frameId === undefined
        ? "unmapped"
        : "ambiguous");
    return {
      stepContext: {
        sessionId: debuggerContext.sessionId,
        captureEpochId: control.captureEpochId,
        scope: {
          tabId: rootDocument.tabId,
          frameId: rootDocument.frameId,
          documentId: rootDocument.documentId,
        },
      },
      identifierMapping: identifierMappingSchema.parse({
        state: fallbackState === "confirmed" ? "ambiguous" : fallbackState,
        ext: {
          tabId: rootDocument.tabId,
          frameId: rootDocument.frameId,
          documentId: rootDocument.documentId,
        },
        cdp: {
          ...(debuggerContext.childSessionId === undefined
            ? {}
            : { sessionId: debuggerContext.childSessionId }),
          ...(keyParts.frameId === undefined ? {} : { frameId: keyParts.frameId }),
          ...(keyParts.loaderId === undefined ? {} : { loaderId: keyParts.loaderId }),
        },
        evidence:
          "tab_root_fallback_only; extension and CDP document identities are not equated",
      }),
    };
  }
}
