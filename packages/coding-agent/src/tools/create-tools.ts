import type { AgentTool } from "@nghyane/arcane-agent";
import { $env, logger } from "@nghyane/arcane-utils";
import { getPreludeDocs, warmPythonEnvironment } from "../ipy/executor";
import { checkPythonKernelAvailability } from "../ipy/kernel";
import { LspTool } from "../lsp";
import { EditTool } from "../patch";
import { TaskTool } from "../task";
import { time } from "../utils/timings";
import { SearchTool } from "../web/search";
import { AskTool } from "./ask";
import { BashTool } from "./bash";
import { BrowserTool } from "./browser";
import { exploreConfig } from "./explore";
import { FetchTool } from "./fetch";
import { FindTool } from "./find";
import { GitHubTool } from "./github";
import { GrepTool } from "./grep";
import type { ToolSession } from "./index";
import { librarianConfig } from "./librarian";
import { NotebookTool } from "./notebook";
import { oracleConfig } from "./oracle";
import { wrapToolWithMetaNotice } from "./output-meta";
import { PythonTool } from "./python";
import { ReadTool } from "./read";
import { reviewerConfig } from "./reviewer-tool";
import { SearchCodeTool } from "./search-code";
import { loadSshTool } from "./ssh";
import { SubagentTool } from "./subagent-tool";
import { TodoWriteTool } from "./todo-write";
import { UndoEditTool } from "./undo-edit";
import { WriteTool } from "./write";

type ToolFactory = (session: ToolSession) => AgentTool<any, any, any> | null | Promise<AgentTool<any, any, any> | null>;

export const BUILTIN_TOOLS: Record<string, ToolFactory> = {
	ask: AskTool.createIf,
	bash: s => new BashTool(s),
	python: s => new PythonTool(s),
	ssh: loadSshTool,
	edit: s => new EditTool(s),
	find: s => new FindTool(s),
	explore: s => new SubagentTool(s, exploreConfig),
	github: s => new GitHubTool(s),
	grep: s => new GrepTool(s),
	librarian: s => new SubagentTool(s, librarianConfig),
	lsp: LspTool.createIf,
	notebook: s => new NotebookTool(s),
	oracle: s => new SubagentTool(s, oracleConfig),
	read: s => new ReadTool(s),
	browser: s => new BrowserTool(s),
	task: TaskTool.create,
	code_review: s => new SubagentTool(s, reviewerConfig),
	todo_write: s => new TodoWriteTool(s),
	undo_edit: s => new UndoEditTool(s),
	fetch: s => new FetchTool(s),
	web_search: () => new SearchTool(),
	search_code: () => new SearchCodeTool(),
	write: s => new WriteTool(s),
};

export type ToolName = keyof typeof BUILTIN_TOOLS;

type PythonToolMode = "ipy-only" | "bash-only" | "both";

/**
 * Parse ARCANE_PY environment variable to determine Python tool mode.
 * Returns null if not set or invalid.
 *
 * Values:
 * - "0" or "bash" \u2192 bash-only
 * - "1" or "py" \u2192 ipy-only
 * - "mix" or "both" \u2192 both
 */
function getPythonModeFromEnv(): PythonToolMode | null {
	const value = $env.ARCANE_PY?.toLowerCase();
	if (!value) return null;

	switch (value) {
		case "0":
		case "bash":
			return "bash-only";
		case "1":
		case "py":
			return "ipy-only";
		case "mix":
		case "both":
			return "both";
		default:
			return null;
	}
}

/**
 * Create tools from BUILTIN_TOOLS registry.
 */
export async function createTools(session: ToolSession, toolNames?: string[]): Promise<AgentTool[]> {
	time("createTools:start");
	const enableLsp = session.enableLsp ?? true;
	const requestedTools = toolNames && toolNames.length > 0 ? [...new Set(toolNames)] : undefined;
	const pythonMode = getPythonModeFromEnv() ?? session.settings.get("python.toolMode");
	const skipPythonPreflight = session.skipPythonPreflight === true;
	let pythonAvailable = true;
	const shouldCheckPython =
		!skipPythonPreflight &&
		pythonMode !== "bash-only" &&
		(requestedTools === undefined || requestedTools.includes("python"));
	const isTestEnv = Bun.env.BUN_ENV === "test" || Bun.env.NODE_ENV === "test";
	const skipPythonWarm = isTestEnv || $env.ARCANE_PYTHON_SKIP_CHECK === "1";
	if (shouldCheckPython) {
		const availability = await checkPythonKernelAvailability(session.cwd);
		time("createTools:pythonCheck");
		pythonAvailable = availability.ok;
		if (!availability.ok) {
			logger.warn("Python kernel unavailable, falling back to bash", {
				reason: availability.reason,
			});
		} else if (!skipPythonWarm && getPreludeDocs().length === 0) {
			const sessionFile = session.getSessionFile?.() ?? undefined;
			const warmSessionId = sessionFile ? `session:${sessionFile}:cwd:${session.cwd}` : `cwd:${session.cwd}`;
			try {
				await warmPythonEnvironment(session.cwd, warmSessionId, session.settings.get("python.sharedGateway"));
				time("createTools:warmPython");
			} catch (err) {
				logger.warn("Failed to warm Python environment", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	const effectiveMode = pythonAvailable ? pythonMode : "bash-only";
	const allowBash = effectiveMode !== "ipy-only";
	const allowPython = effectiveMode !== "bash-only";
	if (
		requestedTools &&
		allowBash &&
		!allowPython &&
		requestedTools.includes("python") &&
		!requestedTools.includes("bash")
	) {
		requestedTools.push("bash");
	}
	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS };
	const isToolAllowed = (name: string) => {
		if (name === "lsp") return enableLsp;
		if (name === "bash") return allowBash;
		if (name === "python") return allowPython;
		if (name === "todo_write") return session.settings.get("todo.enabled");
		if (name === "find") return session.settings.get("find.enabled");
		if (name === "grep") return session.settings.get("grep.enabled");
		if (name === "notebook") return session.settings.get("notebook.enabled");
		if (name === "fetch") return session.settings.get("fetch.enabled");
		if (name === "web_search") return session.settings.get("web_search.enabled");
		if (name === "lsp") return session.settings.get("lsp.enabled");
		if (name === "browser") return session.settings.get("browser.enabled");
		if (name === "librarian") return session.settings.get("librarian.enabled");
		if (name === "oracle") return session.settings.get("oracle.enabled");
		if (name === "github") return session.settings.get("github.enabled");
		if (name === "search_code") return session.isSubagent;
		if (name === "task") {
			return !session.isSubagent;
		}
		return true;
	};

	const filteredRequestedTools = requestedTools?.filter(name => name in allTools && isToolAllowed(name));

	const entries =
		filteredRequestedTools !== undefined
			? filteredRequestedTools.map(name => [name, allTools[name]] as const)
			: [...Object.entries(BUILTIN_TOOLS).filter(([name]) => isToolAllowed(name))];

	const results = await Promise.all(
		entries.map(async ([name, factory]) => {
			if (filteredRequestedTools && !filteredRequestedTools.includes(name)) {
				return null;
			}
			const tool = await factory(session);
			time(`createTools:${name}`);
			return tool ? wrapToolWithMetaNotice(tool) : null;
		}),
	);
	const tools = results.filter((r): r is AgentTool => r !== null);

	return tools;
}
