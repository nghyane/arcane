import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@nghyane/arcane-ai";
import { Settings } from "../../src/config/settings";
import type { LoadExtensionsResult } from "../../src/extensibility/extensions/types";
import * as sdkModule from "../../src/sdk";
import type { AgentSession, AgentSessionEvent } from "../../src/session/agent-session";
import type { AuthStorage } from "../../src/session/auth-storage";
import { runAgent } from "../../src/task/executor";
import type { AgentDefinition } from "../../src/task/types";
import { EventBus } from "../../src/utils/event-bus";

vi.mock("../../src/sdk", () => ({
	createAgentSession: vi.fn(),
	discoverAuthStorage: vi.fn(async () => ({})),
}));

function createAssistantStopMessage(text: string, stopReason: "stop" | "error" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createMockSession(
	onPrompt: (params: {
		text: string;
		promptIndex: number;
		emit: (event: AgentSessionEvent) => void;
		state: { messages: AssistantMessage[] };
	}) => void,
): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const state = { messages: [] as AssistantMessage[] };
	let promptIndex = 0;

	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};

	const session = {
		state,
		agent: { state: { systemPrompt: "test" } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: {
			appendSessionInit: () => {},
		},
		getActiveToolNames: () => ["read"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (text: string) => {
			promptIndex += 1;
			onPrompt({ text, promptIndex, emit, state });
		},
		abort: async () => {},
		dispose: async () => {},
	};

	return session as unknown as AgentSession;
}

describe("runAgent lightweight fork", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const baseAgent: AgentDefinition = {
		name: "task",
		kind: "hybrid",
		description: "test",
		systemPrompt: "test",
		source: "bundled",
		tools: [],
	};

	const baseOptions = {
		cwd: "/tmp",
		agent: baseAgent,
		task: "do work",
		index: 0,
		id: "subagent-1",
		settings: Settings.isolated(),
		authStorage: {} as unknown as AuthStorage,
		modelRegistry: { refresh: async () => {} } as unknown as import("../../src/config/model-registry").ModelRegistry,
		enableLsp: false,
		eventBus: new EventBus(),
	};

	it("runs a single prompt to completion", async () => {
		const prompts: string[] = [];
		const session = createMockSession(({ text, emit, state }) => {
			prompts.push(text);
			const assistant = createAssistantStopMessage("did some work");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runAgent(baseOptions);
		expect(prompts).toHaveLength(1);
		expect(result.exitCode).toBe(0);
	});

	it("passes skipPythonPreflight when python not in agent tools", async () => {
		const session = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage("ok");
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		const createAgentSessionMock = sdkModule.createAgentSession as unknown as {
			mockResolvedValue: (value: unknown) => void;
			mock: { calls: unknown[][] };
		};
		createAgentSessionMock.mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const agentWithTools = { ...baseAgent, tools: ["bash", "read", "write"] };
		await runAgent({ ...baseOptions, agent: agentWithTools, id: "subagent-no-python" });
		const calls = createAgentSessionMock.mock.calls;
		const lastCall = calls[calls.length - 1]?.[0] as { skipPythonPreflight?: boolean };
		expect(lastCall?.skipPythonPreflight).toBe(true);
	});

	it("marks execution failed when assistant ends with stopReason=error", async () => {
		const session = createMockSession(({ emit, state }) => {
			const assistant = createAssistantStopMessage("failure", "error");
			assistant.errorMessage = "Subagent failed at runtime";
			state.messages.push(assistant);
			emit({ type: "message_end", message: assistant });
		});

		(sdkModule.createAgentSession as unknown as { mockResolvedValue: (value: unknown) => void }).mockResolvedValue({
			session,
			extensionsResult: {} as unknown as LoadExtensionsResult,
			setToolUIContext: () => {},
		});

		const result = await runAgent({ ...baseOptions, id: "subagent-error" });
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Subagent failed at runtime");
	});
});
