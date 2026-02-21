/**
 * Bun-based Code Mode executor.
 *
 * Runs LLM-generated JavaScript code with a `codemode` Proxy that
 * dispatches tool calls back to the host. Uses `new AsyncFunction()`
 * in the same process with common globals shadowed (process, require,
 * Bun, globalThis, global) to limit the API surface.
 *
 * NOTE: This is NOT a security sandbox. Dynamic `import()`, `eval()`,
 * `fetch()`, and constructor-chain escapes (e.g., `this.constructor`)
 * remain accessible. The sandbox exists to guide LLM-generated code
 * toward the codemode API, not to contain malicious code.
 */

import { logger } from "@oh-my-pi/pi-utils";

export interface ExecuteResult {
	/** Return value from the code (JSON-serializable) */
	result: unknown;
	/** Captured console.log output */
	logs: string[];
	/** Error message if execution failed */
	error?: string;
}

export interface ExecutorOptions {
	/** Timeout in milliseconds (default: 300_000 = 5 minutes) */
	timeoutMs?: number;
	/** Abort signal for external cancellation */
	signal?: AbortSignal;
}

type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

// AsyncFunction constructor for building async functions from strings
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/**
 * Execute LLM-generated code with a codemode proxy.
 *
 * The code must be a normalized async arrow function string
 * (e.g., `async () => { ... }`). It receives `codemode` as an
 * implicit global via function parameter injection.
 */
export async function execute(
	code: string,
	fns: Record<string, ToolFn>,
	options: ExecutorOptions = {},
): Promise<ExecuteResult> {
	const { timeoutMs = 300_000, signal } = options;
	const logs: string[] = [];

	// Build the codemode proxy — any property access returns an async dispatch function.
	// Must handle symbol keys (e.g., Symbol.toPrimitive, Symbol.toStringTag) and
	// "then" (to prevent `await codemode` treating it as a thenable).
	const codemode = new Proxy({} as Record<string, ToolFn>, {
		get: (_target, prop) => {
			// Symbol keys and "then" return undefined to avoid thenable/inspect issues
			if (typeof prop !== "string" || prop === "then") return undefined;
			const fn = fns[prop];
			if (!fn) {
				return async () => {
					throw new Error(`Tool "${prop}" not found in codemode`);
				};
			}
			return async (args: Record<string, unknown> = {}) => fn(args);
		},
	});

	// Captured console for sandboxed code
	const sandboxConsole = {
		log: (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		},
		warn: (...args: unknown[]) => {
			logs.push(`[warn] ${args.map(String).join(" ")}`);
		},
		error: (...args: unknown[]) => {
			logs.push(`[error] ${args.map(String).join(" ")}`);
		},
		info: (...args: unknown[]) => {
			logs.push(args.map(String).join(" "));
		},
	};

	const cleanups: (() => void)[] = [];
	let resultPromise: Promise<unknown> | undefined;
	try {
		// Build an async function that receives codemode and console as params.
		// Shadow dangerous globals (process, require, Bun, globalThis, global)
		// to limit the API surface available to sandboxed code.
		const fn = new AsyncFunction(
			"codemode",
			"console",
			"process",
			"require",
			"Bun",
			"globalThis",
			"global",
			`const __fn = ${code};\nreturn await __fn();`,
		);

		resultPromise = fn(codemode, sandboxConsole, undefined, undefined, undefined, undefined, undefined);

		// NOTE: This timeout only works for async/awaiting code. Synchronous infinite
		// loops (e.g. `while(true){}`) block the event loop and prevent the timeout
		// callback from firing. A Worker thread would be needed for preemptive termination.
		// Race against timeout and abort
		const timeout = createTimeout(timeoutMs);
		cleanups.push(timeout.cleanup);

		const racers: Promise<unknown>[] = [resultPromise, timeout.promise];
		if (signal) {
			const abort = createAbortPromise(signal);
			cleanups.push(abort.cleanup);
			racers.push(abort.promise);
		}

		const result = await Promise.race(racers);

		return { result, logs };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		logger.debug("Code Mode execution error", { error });
		// Suppress unhandled rejection from the still-running resultPromise.
		// The code may still be executing in-flight tool calls after timeout/abort;
		// swallowing the rejection prevents Node/Bun from crashing.
		resultPromise?.catch(() => {});
		return { result: undefined, logs, error };
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

function createTimeout(ms: number): { promise: Promise<never>; cleanup: () => void } {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new Error(`Code Mode execution timed out after ${ms}ms`)), ms);
	return { promise, cleanup: () => clearTimeout(timer) };
}

function createAbortPromise(signal: AbortSignal): { promise: Promise<never>; cleanup: () => void } {
	const { promise, reject } = Promise.withResolvers<never>();
	const onAbort = () => reject(new Error("Code Mode execution aborted"));
	if (signal.aborted) {
		onAbort();
	} else {
		signal.addEventListener("abort", onAbort, { once: true });
	}
	return { promise, cleanup: () => signal.removeEventListener("abort", onAbort) };
}
