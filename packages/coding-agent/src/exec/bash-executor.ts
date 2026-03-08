/**
 * Bash command execution with streaming support and cancellation.
 *
 * Uses brush-core via native bindings for shell execution.
 */
import { Shell } from "@nghyane/arcane-natives";
import { Settings } from "../config/settings";
import { OutputSink } from "../session/streaming-output";
import { getOrCreateSnapshot } from "../utils/shell-snapshot";
import { NON_INTERACTIVE_ENV } from "./non-interactive-env";

export interface BashExecutorOptions {
	cwd?: string;
	timeout?: number;
	onChunk?: (chunk: string) => void;
	signal?: AbortSignal;
	/** Session key suffix to isolate shell sessions per agent */
	sessionKey?: string;
	/** Additional environment variables to inject */
	env?: Record<string, string>;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
}

export interface BashResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	timedOut: boolean;
	truncated: boolean;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	artifactId?: string;
}

const HARD_TIMEOUT_GRACE_MS = 5_000;

const shellSessions = new Map<string, Shell>();

export async function executeBash(command: string, options?: BashExecutorOptions): Promise<BashResult> {
	const settings = await Settings.init();
	const { shell, env: shellEnv, prefix } = settings.getShellConfig();
	const snapshotPath = shell.includes("bash") ? await getOrCreateSnapshot(shell, shellEnv) : null;

	const prefixedCommand = prefix ? `${prefix} ${command}` : command;

	const sink = new OutputSink({
		onChunk: options?.onChunk,
		artifactPath: options?.artifactPath,
		artifactId: options?.artifactId,
	});

	let pendingChunks = Promise.resolve();
	const enqueueChunk = (chunk: string) => {
		pendingChunks = pendingChunks.then(() => sink.push(chunk)).catch(() => {});
	};

	if (options?.signal?.aborted) {
		return {
			exitCode: undefined,
			cancelled: true,
			timedOut: false,
			...(await sink.dump("Command cancelled")),
		};
	}

	const sessionKey = buildSessionKey(shell, prefix, snapshotPath, shellEnv, options?.sessionKey);
	let shellSession = shellSessions.get(sessionKey);
	if (!shellSession) {
		shellSession = new Shell({ sessionEnv: shellEnv, snapshotPath: snapshotPath ?? undefined });
		shellSessions.set(sessionKey, shellSession);
	}
	const signal = options?.signal;
	const abortHandler = () => {
		shellSession.abort(signal?.reason instanceof Error ? signal.reason.message : undefined);
	};
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	let hardTimeoutTimer: NodeJS.Timeout | undefined;
	const hardTimeoutDeferred = Promise.withResolvers<"hard-timeout">();
	const baseTimeoutMs = Math.max(1_000, options?.timeout ?? 300_000);
	const hardTimeoutMs = baseTimeoutMs + HARD_TIMEOUT_GRACE_MS;
	hardTimeoutTimer = setTimeout(() => {
		shellSession.abort(`Hard timeout after ${Math.round(hardTimeoutMs / 1000)}s`);
		hardTimeoutDeferred.resolve("hard-timeout");
	}, hardTimeoutMs);

	let resetSession = false;

	try {
		const runPromise = shellSession.run(
			{
				command: prefixedCommand,
				cwd: options?.cwd,
				env: options?.env ? { ...NON_INTERACTIVE_ENV, ...options.env } : NON_INTERACTIVE_ENV,
				timeoutMs: options?.timeout,
				signal,
			},
			(err, chunk) => {
				if (!err) {
					enqueueChunk(chunk);
				}
			},
		);

		const winner = await Promise.race([
			runPromise.then(result => ({ kind: "result" as const, result })),
			hardTimeoutDeferred.promise.then(() => ({ kind: "hard-timeout" as const })),
		]);

		await pendingChunks;

		if (winner.kind === "hard-timeout") {
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				timedOut: true,
				...(await sink.dump(`Command exceeded hard timeout after ${Math.round(hardTimeoutMs / 1000)} seconds`)),
			};
		}

		if (winner.result.timedOut) {
			const annotation = options?.timeout
				? `Command timed out after ${Math.round(options.timeout / 1000)} seconds`
				: "Command timed out";
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: false,
				timedOut: true,
				...(await sink.dump(annotation)),
			};
		}

		if (winner.result.cancelled) {
			resetSession = true;
			return {
				exitCode: undefined,
				cancelled: true,
				timedOut: false,
				...(await sink.dump("Command cancelled")),
			};
		}

		return {
			exitCode: winner.result.exitCode,
			cancelled: false,
			timedOut: false,
			...(await sink.dump()),
		};
	} catch (err) {
		resetSession = true;
		throw err;
	} finally {
		if (hardTimeoutTimer) {
			clearTimeout(hardTimeoutTimer);
		}
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
		await pendingChunks;
		if (resetSession) {
			shellSessions.delete(sessionKey);
		}
	}
}

function buildSessionKey(
	shell: string,
	prefix: string | undefined,
	snapshotPath: string | null,
	env: Record<string, string>,
	agentSessionKey?: string,
): string {
	const entries = Object.entries(env);
	entries.sort(([a], [b]) => a.localeCompare(b));
	const envSerialized = entries.map(([key, value]) => `${key}=${value}`).join("\n");
	return [agentSessionKey ?? "", shell, prefix ?? "", snapshotPath ?? "", envSerialized].join("\n");
}
