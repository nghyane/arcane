import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ModelRegistry } from "@nghyane/arcane/config/model-registry";
import { Settings } from "@nghyane/arcane/config/settings";
import { AgentSession, type AgentSessionEvent } from "@nghyane/arcane/session/agent-session";
import { AuthStorage } from "@nghyane/arcane/session/auth-storage";
import { SessionManager } from "@nghyane/arcane/session/session-manager";
import { Agent } from "@nghyane/arcane-agent";
import type { AssistantMessage } from "@nghyane/arcane-ai";
import { getBundledModel } from "@nghyane/arcane-ai/models";
import { TempDir } from "@nghyane/arcane-utils";

describe("AgentSession handoff", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let events: AgentSessionEvent[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-handoff-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.inMemory();
		events = [];

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected built-in anthropic model to exist");
		}

		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
				messages: [],
			},
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": true,
				"compaction.autoContinue": false,
			}),
			modelRegistry,
		});

		session.subscribe(event => {
			events.push(event);
		});

		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "seed" }],
			timestamp: Date.now() - 2,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 16,
				output: 8,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 24,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now() - 1,
		});
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("does not run auto-compaction after handoff turn completes", async () => {
		const model = session.model;
		if (!model) {
			throw new Error("Expected model to be set");
		}

		const handoffText = "## Goal\nContinue from here";
		const handoffAssistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: handoffText }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		const promptSpy = vi.spyOn(session, "prompt").mockImplementation(async () => {
			session.agent.replaceMessages([handoffAssistant]);
			session.agent.emitExternalEvent({ type: "message_end", message: handoffAssistant });
			session.agent.emitExternalEvent({ type: "agent_end", messages: [handoffAssistant] });
		});

		const result = await session.handoff();
		await Bun.sleep(20);

		expect(promptSpy).toHaveBeenCalledTimes(1);
		expect(result?.document).toBe(handoffText);
		expect(events.filter(event => event.type === "auto_compaction_start")).toHaveLength(0);
		expect(events.filter(event => event.type === "auto_compaction_end")).toHaveLength(0);
		expect(sessionManager.getEntries().filter(entry => entry.type === "compaction")).toHaveLength(0);
	});
});
