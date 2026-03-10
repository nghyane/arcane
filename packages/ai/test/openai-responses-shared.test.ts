import { describe, expect, it } from "bun:test";
import {
	convertResponsesAssistantMessage,
	encodeTextSignatureV1,
} from "@nghyane/arcane-ai/providers/openai-responses-shared";
import type { AssistantMessage, Model } from "@nghyane/arcane-ai/types";

const testModel: Model<"openai-codex-responses"> = {
	id: "gpt-5.1-codex",
	name: "GPT-5.1 Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function createAssistantMessage(textSignature: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Answer 1", textSignature }],
		usage: {
			input: 0,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: testModel.api,
		provider: testModel.provider,
		model: testModel.id,
	};
}

describe("openai responses shared history conversion", () => {
	it("preserves encoded text signature metadata for assistant messages", () => {
		const assistantMsg = createAssistantMessage(encodeTextSignatureV1("msg_original", "commentary"));
		const items = convertResponsesAssistantMessage(assistantMsg, testModel, 1, new Set<string>(), text => text);
		const messageItem = items.find(item => item.type === "message");

		expect(messageItem).toMatchObject({
			type: "message",
			role: "assistant",
			id: "msg_original",
			phase: "commentary",
		});
	});
});
