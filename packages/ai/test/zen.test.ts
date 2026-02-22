import { describe, expect, it } from "bun:test";
import MODELS from "@nghyane/arcane-ai/models.json" with { type: "json" };
import { complete } from "@nghyane/arcane-ai/stream";
import type { Model } from "@nghyane/arcane-ai/types";
import { e2eApiKey } from "./oauth";

describe.skipIf(!e2eApiKey("OPENCODE_API_KEY"))("OpenCode Zen Models Smoke Test", () => {
	const zenModels = Object.values(MODELS.opencode);

	zenModels.forEach(model => {
		it(`${model.id}`, async () => {
			const response = await complete(model as Model, {
				messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
			});

			expect(response.content).toBeTruthy();
			expect(response.stopReason).toBe("stop");
		}, 60000);
	});
});
