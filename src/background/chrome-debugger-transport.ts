import type { DebuggerCommandTarget, DebuggerTransport } from "./debugger-session-manager";

export interface ChromeDebuggerCommandApi {
  attach(debuggee: { tabId: number }, requiredVersion: string): Promise<void>;
  detach(debuggee: { tabId: number }): Promise<void>;
  sendCommand(
    debuggee: { tabId: number; sessionId?: string },
    method: string,
    commandParams?: object,
  ): Promise<unknown>;
}

/** Typed adapter around chrome.debugger's root/flat-child command shape. */
export class ChromeDebuggerTransport implements DebuggerTransport {
  constructor(private readonly api: ChromeDebuggerCommandApi) {}

  attach(tabId: number): Promise<void> {
    return this.api.attach({ tabId }, "1.3");
  }

  detach(tabId: number): Promise<void> {
    return this.api.detach({ tabId });
  }

  sendCommand(
    target: DebuggerCommandTarget,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const debuggee = {
      tabId: target.tabId,
      ...(target.sessionId === undefined ? {} : { sessionId: target.sessionId }),
    };
    return this.api.sendCommand(debuggee, method, params);
  }
}
