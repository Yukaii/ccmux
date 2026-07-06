/**
 * Type surface for the authored JS extension. The real implementation
 * lives in `ccmux.js`; this file is solely for TypeScript callers (tests,
 * the renderer). Kept intentionally loose: the extension talks to pi's
 * runtime whose types are not in our dependency graph.
 */

export interface MakeExtensionOptions {
  markersDir: string;
  version: string;
  now?: () => number;
}

export interface PiExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string | undefined;
    getSessionFile(): string | undefined;
  };
}

/** Minimal slice of pi's ExtensionAPI used by the ccmux extension. */
export interface PiExtensionApi {
  on(
    event: string,
    handler: (event: unknown, ctx: PiExtensionContext) => void | Promise<void>,
  ): void;
}

export type PiExtension = ((pi: PiExtensionApi) => void) & { version: string };

export function makeExtension(opts: MakeExtensionOptions): PiExtension;

declare const ccmuxExtension: PiExtension;
export default ccmuxExtension;
