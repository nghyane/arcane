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

import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "@nghyane/arcane-utils";

export interface ExecutionError {
	/** Error category */
	type: "timeout" | "abort" | "tool_not_found" | "tool_error" | "runtime";
	/** Human-readable error message */
	message: string;
	/** Tool name if the error originated from a sub-tool call */
	toolName?: string;
	/** Numbered code snippet for context */
	snippet?: string;
}

export interface ExecuteResult {
	/** Return value from the code (JSON-serializable) */
	result: unknown;
	/** Captured console.log output */
	logs: string[];
	/** Structured error if execution failed */
	error?: ExecutionError;
	/** Message from abort() if execution was intentionally stopped */
	abortMessage?: string;
}

/** Thrown by `abort()` to cleanly exit execution without error framing. */
export class AbortExecution extends Error {
	constructor(readonly userMessage: string) {
		super(`AbortExecution: ${userMessage}`);
		this.name = "AbortExecution";
	}
}

export type StepEvent =
	| { type: "start"; stepId: string; intent: string; parentStepId?: string }
	| { type: "end"; stepId: string };

export interface ExecutorOptions {
	/** Timeout in milliseconds (default: 300_000 = 5 minutes) */
	timeoutMs?: number;
	/** Abort signal for external cancellation */
	signal?: AbortSignal;
	/** Persistent state object shared across executions */
	state?: Map<string, unknown>;
	/** Additional globals to inject into the sandbox */
	injectedGlobals?: Record<string, unknown>;
	/** Called when step() starts/ends */
	onStep?: (event: StepEvent) => void;
	/** Called when progress() is called */
	onProgress?: (stepId: string, message: string) => void;
}

type ToolFn = (args: Record<string, unknown>) => Promise<unknown>;

// AsyncFunction constructor for building async functions from strings
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** Tracks current step ID for nested step() calls */
const currentStepId = new AsyncLocalStorage<string>();

let stepCounter = 0;
function generateStepId(): string {
	return `step_${++stepCounter}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Returns the current step ID if inside a step() call, or undefined otherwise. */
export function getCurrentStepId(): string | undefined {
	return currentStepId.getStore();
}

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
	const { timeoutMs = 300_000, signal, injectedGlobals, onStep, onProgress } = options;
	const logs: string[] = [];

	const step = async (intent: string, fn: () => Promise<unknown>) => {
		const stepId = generateStepId();
		const parentStepId = currentStepId.getStore();
		onStep?.({ type: "start", stepId, intent, parentStepId });
		try {
			return await currentStepId.run(stepId, fn);
		} finally {
			onStep?.({ type: "end", stepId });
		}
	};

	const progress = (message: string) => {
		const stepId = currentStepId.getStore();
		if (stepId) onProgress?.(stepId, message);
	};

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

	const formatArg = (v: unknown): string => {
		if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			return String(v);
		}
		try {
			return JSON.stringify(v, null, 2);
		} catch {
			return String(v);
		}
	};
	const formatArgs = (args: unknown[]) => args.map(formatArg).join(" ");

	const sandboxConsole = {
		log: (...args: unknown[]) => {
			logs.push(formatArgs(args));
		},
		warn: (...args: unknown[]) => {
			logs.push(`[warn] ${formatArgs(args)}`);
		},
		error: (...args: unknown[]) => {
			logs.push(`[error] ${formatArgs(args)}`);
		},
		info: (...args: unknown[]) => {
			logs.push(formatArgs(args));
		},
	};

	const persistentState = options.state ?? new Map<string, unknown>();
	const memo = async (key: string, fn: () => Promise<unknown>) => {
		if (!persistentState.has(key)) {
			persistentState.set(
				key,
				fn().then(
					v => {
						persistentState.set(key, v);
						return v;
					},
					err => {
						persistentState.delete(key);
						throw err;
					},
				),
			);
		}
		return persistentState.get(key);
	};

	const cleanups: (() => void)[] = [];
	let resultPromise: Promise<unknown> | undefined;
	try {
		// Parameters: injected globals first, then shadowed globals (set to undefined).
		// Keep params/args arrays in sync to avoid positional mismatches.
		const injectedNames = Object.keys(injectedGlobals ?? {});
		const params = [
			"codemode",
			"console",
			"state",
			"memo",
			"step",
			"progress",
			...injectedNames,
			"process",
			"require",
			"Bun",
			"globalThis",
			"global",
		];
		const args = [
			codemode,
			sandboxConsole,
			persistentState,
			memo,
			step,
			progress,
			...Object.values(injectedGlobals ?? {}),
		];

		const fn = new AsyncFunction(...params, `const __fn = ${code};\nreturn await __fn();`);
		resultPromise = fn(...args);

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
		// AbortExecution — clean intentional exit, not an error
		if (err instanceof AbortExecution) {
			resultPromise?.catch(() => {});
			return { result: undefined, logs, abortMessage: err.userMessage };
		}
		const error = formatExecutionError(err, code);
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

/**
 * Format an execution error into a structured object.
 *
 * Bun's eval source maps are unreliable for line pinpointing,
 * so we include a numbered code snippet instead of highlighting a specific line.
 */
function formatExecutionError(err: unknown, code: string): ExecutionError {
	const snippet = buildCodeSnippet(code);

	if (!(err instanceof Error)) {
		return { type: "runtime", message: String(err), snippet };
	}

	// Classify the error
	const message = err.message;
	if (message.includes("timed out")) {
		return { type: "timeout", message, snippet };
	}
	if (message.includes("aborted") || err.name === "AbortError") {
		return { type: "abort", message, snippet };
	}
	if (message.includes("not found in codemode")) {
		const toolMatch = message.match(/Tool "(.+?)" not found/);
		return { type: "tool_not_found", message, toolName: toolMatch?.[1], snippet };
	}

	// Check if it's a sub-tool error (errors thrown from bridged tool functions)
	const toolName = (err as unknown as Record<string, unknown>).toolName as string | undefined;
	if (toolName) {
		return { type: "tool_error", message, toolName, snippet };
	}

	return { type: "runtime", message, snippet };
}

function buildCodeSnippet(code: string): string {
	const codeLines = code.split("\n");
	if (codeLines.length <= 20) {
		return codeLines.map((line, i) => `  ${String(i + 1).padStart(3)} | ${line}`).join("\n");
	}
	const head = codeLines.slice(0, 10).map((line, i) => `  ${String(i + 1).padStart(3)} | ${line}`);
	const tail = codeLines.slice(-10).map((line, i) => {
		const lineNum = codeLines.length - 10 + i + 1;
		return `  ${String(lineNum).padStart(3)} | ${line}`;
	});
	return [...head, `  ... (${codeLines.length - 20} lines omitted)`, ...tail].join("\n");
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
