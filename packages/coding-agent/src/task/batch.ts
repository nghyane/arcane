/**
 * Lightweight batch runner for subagent tasks.
 *
 * Encapsulates: agent resolution, artifacts dir lifecycle, concurrency execution, temp cleanup.
 * Used by TaskTool and analyze-file (commit agent).
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Snowflake } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { isDefaultModelAlias } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AuthStorage } from "../session/auth-storage";
import { getBundledAgent } from "./agents";
import { type ExecutorOptions, runAgent } from "./executor";
import { mapWithConcurrencyLimit, type ParallelResult } from "./parallel";
import type { AgentDefinition, SingleResult } from "./types";

export interface BatchTask {
	id: string;
	description: string;
	task: string;
}

export interface BatchOptions {
	cwd: string;
	agentName: string;
	tasks: BatchTask[];
	sessionFile: string | null;
	signal?: AbortSignal;
	authStorage?: AuthStorage;
	modelRegistry?: ModelRegistry;
	settings: Settings;
	executorOverrides?: Partial<ExecutorOptions>;
}

export interface BatchResult {
	results: ParallelResult<SingleResult>["results"];
	aborted: boolean;
	agent: AgentDefinition;
	artifactsDir: string;
	persistArtifacts: boolean;
}

export async function runTaskBatch(options: BatchOptions): Promise<BatchResult> {
	const agent = getBundledAgent(options.agentName);
	if (!agent) {
		throw new Error(`Agent "${options.agentName}" not found.`);
	}

	const modelOverride = isDefaultModelAlias(agent.model) ? undefined : agent.model;

	const sessionFile = options.sessionFile;
	const artifactsDir = sessionFile ? sessionFile.slice(0, -path.extname(sessionFile).length) : null;
	const tempArtifactsDir = artifactsDir ? null : path.join(os.tmpdir(), `omp-batch-${Snowflake.next()}`);
	const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;
	const persistArtifacts = !!artifactsDir;

	await fs.mkdir(effectiveArtifactsDir, { recursive: true });

	const maxConcurrency = options.settings.get("task.maxConcurrency");

	try {
		const result = await mapWithConcurrencyLimit(
			options.tasks,
			maxConcurrency,
			async (task, index) =>
				runAgent({
					cwd: options.cwd,
					agent,
					task: task.task,
					description: task.description,
					index,
					id: task.id,
					modelOverride,
					sessionFile,
					persistArtifacts,
					artifactsDir: effectiveArtifactsDir,
					enableLsp: false,
					signal: options.signal,
					authStorage: options.authStorage,
					modelRegistry: options.modelRegistry,
					settings: options.settings,
					...options.executorOverrides,
				}),
			options.signal,
		);

		return {
			results: result.results,
			aborted: result.aborted,
			agent,
			artifactsDir: effectiveArtifactsDir,
			persistArtifacts,
		};
	} finally {
		if (tempArtifactsDir) {
			await fs.rm(tempArtifactsDir, { recursive: true, force: true });
		}
	}
}
