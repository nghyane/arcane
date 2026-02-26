import type { Agent, ThinkingLevel } from "@nghyane/arcane-agent";
import type { Model, ProviderSessionState } from "@nghyane/arcane-ai";
import { modelsAreEqual, supportsXhigh } from "@nghyane/arcane-ai";
import { logger } from "@nghyane/arcane-utils";
import { MODEL_ROLE_IDS, type ModelRegistry, type ModelRole } from "../config/model-registry";
import { expandRoleAlias, parseModelString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { SessionManager } from "./session-manager";
import type { ModelCycleResult, RoleModelCycleResult } from "./session-types";

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

/** Thinking levels including xhigh (for supported models) */
const THINKING_LEVELS_WITH_XHIGH: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * Owns model selection, thinking level, and scoped model cycling.
 *
 * AgentSession delegates all model/thinking operations here.
 * The controller mutates agent state (model, thinking level) and
 * persists changes to sessionManager and settings.
 */
export class ModelController {
	#agent: Agent;
	#settings: Settings;
	#sessionManager: SessionManager;
	#modelRegistry: ModelRegistry;
	#scopedModels: Array<{ model: Model; thinkingLevel: ThinkingLevel }>;
	#forceCopilotAgentInitiator: boolean;
	#providerSessionState = new Map<string, ProviderSessionState>();

	constructor(
		agent: Agent,
		settings: Settings,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
		options: {
			scopedModels?: Array<{ model: Model; thinkingLevel: ThinkingLevel }>;
			forceCopilotAgentInitiator?: boolean;
		},
	) {
		this.#agent = agent;
		this.#settings = settings;
		this.#sessionManager = sessionManager;
		this.#modelRegistry = modelRegistry;
		this.#scopedModels = options.scopedModels ? [...options.scopedModels] : [];
		this.#forceCopilotAgentInitiator = options.forceCopilotAgentInitiator ?? false;
	}

	get registry(): ModelRegistry {
		return this.#modelRegistry;
	}

	get model(): Model | undefined {
		return this.#agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.#agent.state.thinkingLevel;
	}

	get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel: ThinkingLevel }> {
		return this.#scopedModels;
	}

	get providerSessionState(): Map<string, ProviderSessionState> {
		return this.#providerSessionState;
	}

	applySessionModelOverrides(model: Model): Model {
		if (!this.#forceCopilotAgentInitiator || model.provider !== "github-copilot") {
			return model;
		}
		return {
			...model,
			headers: {
				...model.headers,
				"X-Initiator": "agent",
			},
		};
	}

	setModelDirect(model: Model): void {
		const currentModel = this.model;
		if (currentModel) {
			this.#closeProviderSessionsForModelSwitch(currentModel, model);
		}
		this.#agent.setModel(this.applySessionModelOverrides(model));
	}

	async setModel(model: Model, role: ModelRole = "default"): Promise<void> {
		const apiKey = await this.#modelRegistry.getApiKey(model, this.#sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.setModelDirect(model);
		this.#sessionManager.appendModelChange(`${model.provider}/${model.id}`, role);
		this.#settings.setModelRole(role, `${model.provider}/${model.id}`);
		this.#settings.getStorage()?.recordModelUsage(`${model.provider}/${model.id}`);
	}

	async setModelTemporary(model: Model): Promise<void> {
		const apiKey = await this.#modelRegistry.getApiKey(model, this.#sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		this.setModelDirect(model);
		this.#sessionManager.appendModelChange(`${model.provider}/${model.id}`);
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this.#scopedModels.length > 0) {
			return this.#cycleScopedModel(direction);
		}
		return this.#cycleAvailableModel(direction);
	}

	async cycleRoleModels(
		roleOrder: readonly ModelRole[],
		options?: { temporary?: boolean },
	): Promise<RoleModelCycleResult | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length === 0) return undefined;

		const currentModel = this.model;
		if (!currentModel) return undefined;
		const roleModels: Array<{ role: ModelRole; model: Model }> = [];

		for (const role of roleOrder) {
			const roleModelStr =
				role === "default"
					? (this.#settings.getModelRole("default") ?? `${currentModel.provider}/${currentModel.id}`)
					: this.#settings.getModelRole(role);
			if (!roleModelStr) continue;

			const expandedRoleModelStr = expandRoleAlias(roleModelStr, this.#settings);
			const parsed = parseModelString(expandedRoleModelStr);
			let match: Model | undefined;
			if (parsed) {
				match = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			}
			if (!match) {
				match = availableModels.find(m => m.id.toLowerCase() === expandedRoleModelStr.toLowerCase());
			}
			if (!match) continue;

			roleModels.push({ role, model: match });
		}

		if (roleModels.length <= 1) return undefined;

		const lastRole = this.#sessionManager.getLastModelChangeRole();
		let currentIndex = lastRole
			? roleModels.findIndex(entry => entry.role === lastRole)
			: roleModels.findIndex(entry => modelsAreEqual(entry.model, currentModel));
		if (currentIndex === -1) currentIndex = 0;

		const nextIndex = (currentIndex + 1) % roleModels.length;
		const next = roleModels[nextIndex];

		if (options?.temporary) {
			await this.setModelTemporary(next.model);
		} else {
			await this.setModel(next.model, next.role);
		}

		return { model: next.model, thinkingLevel: this.thinkingLevel, role: next.role };
	}

	resolveRoleModel(role: ModelRole): Model | undefined {
		return this.#resolveRoleModel(role, this.#modelRegistry.getAvailable(), this.model);
	}

	getAvailableModels(): Model[] {
		return this.#modelRegistry.getAvailable();
	}

	setThinkingLevel(level: ThinkingLevel, persist = false): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level, availableLevels);

		const isChanging = effectiveLevel !== this.#agent.state.thinkingLevel;

		this.#agent.setThinkingLevel(effectiveLevel);

		if (isChanging) {
			this.#sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (persist) {
				this.#settings.set("defaultThinkingLevel", effectiveLevel);
			}
		}
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.supportsThinking()) return ["off"];
		return this.supportsXhighThinking() ? THINKING_LEVELS_WITH_XHIGH : THINKING_LEVELS;
	}

	supportsXhighThinking(): boolean {
		return this.model ? supportsXhigh(this.model) : false;
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	getCompactionModelCandidates(availableModels: Model[]): Model[] {
		const candidates: Model[] = [];
		const seen = new Set<string>();

		const addCandidate = (model: Model | undefined): void => {
			if (!model) return;
			const key = this.getModelKey(model);
			if (seen.has(key)) return;
			seen.add(key);
			candidates.push(model);
		};

		const currentModel = this.model;
		for (const role of MODEL_ROLE_IDS) {
			addCandidate(this.#resolveRoleModel(role, availableModels, currentModel));
		}

		const sortedByContext = [...availableModels].sort((a, b) => b.contextWindow - a.contextWindow);
		for (const model of sortedByContext) {
			addCandidate(model);
		}

		return candidates;
	}

	resolveContextPromotionTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		return this.#resolveContextPromotionConfiguredTarget(currentModel, availableModels);
	}

	closeCodexProviderSessionsForHistoryRewrite(): void {
		const currentModel = this.model;
		if (!currentModel || currentModel.api !== "openai-codex-responses") return;
		this.#closeProviderSessionsForModelSwitch(currentModel, currentModel);
	}

	get #sessionId(): string {
		return this.#sessionManager.getSessionId();
	}

	// =========================================================================
	// Private
	// =========================================================================

	async #getScopedModelsWithApiKey(): Promise<Array<{ model: Model; thinkingLevel: ThinkingLevel }>> {
		const apiKeysByProvider = new Map<string, string | undefined>();
		const result: Array<{ model: Model; thinkingLevel: ThinkingLevel }> = [];

		for (const scoped of this.#scopedModels) {
			const provider = scoped.model.provider;
			let apiKey: string | undefined;
			if (apiKeysByProvider.has(provider)) {
				apiKey = apiKeysByProvider.get(provider);
			} else {
				apiKey = await this.#modelRegistry.getApiKeyForProvider(provider, this.#sessionId);
				apiKeysByProvider.set(provider, apiKey);
			}

			if (apiKey) {
				result.push(scoped);
			}
		}

		return result;
	}

	async #cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const scopedModels = await this.#getScopedModelsWithApiKey();
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex(sm => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];

		this.setModelDirect(next.model);
		this.#sessionManager.appendModelChange(`${next.model.provider}/${next.model.id}`);
		this.#settings.setModelRole("default", `${next.model.provider}/${next.model.id}`);
		this.#settings.getStorage()?.recordModelUsage(`${next.model.provider}/${next.model.id}`);

		this.setThinkingLevel(next.thinkingLevel);

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	async #cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = this.#modelRegistry.getAvailable();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex(m => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const apiKey = await this.#modelRegistry.getApiKey(nextModel, this.#sessionId);
		if (!apiKey) {
			throw new Error(`No API key for ${nextModel.provider}/${nextModel.id}`);
		}

		this.setModelDirect(nextModel);
		this.#sessionManager.appendModelChange(`${nextModel.provider}/${nextModel.id}`);
		this.#settings.setModelRole("default", `${nextModel.provider}/${nextModel.id}`);
		this.#settings.getStorage()?.recordModelUsage(`${nextModel.provider}/${nextModel.id}`);

		this.setThinkingLevel(this.thinkingLevel);

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	clampThinkingLevel(level: ThinkingLevel, availableLevels: ThinkingLevel[]): ThinkingLevel {
		const ordered = THINKING_LEVELS_WITH_XHIGH;
		const available = new Set(availableLevels);
		const requestedIndex = ordered.indexOf(level);
		if (requestedIndex === -1) {
			return availableLevels[0] ?? "off";
		}
		for (let i = requestedIndex; i < ordered.length; i++) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		for (let i = requestedIndex - 1; i >= 0; i--) {
			const candidate = ordered[i];
			if (available.has(candidate)) return candidate;
		}
		return availableLevels[0] ?? "off";
	}

	#closeProviderSessionsForModelSwitch(currentModel: Model, nextModel: Model): void {
		if (currentModel.api !== "openai-codex-responses" && nextModel.api !== "openai-codex-responses") return;

		const providerKey = "openai-codex-responses";
		const state = this.#providerSessionState.get(providerKey);
		if (!state) return;

		try {
			state.close();
		} catch (error) {
			logger.warn("Failed to close provider session state during model switch", {
				providerKey,
				error: String(error),
			});
		}

		this.#providerSessionState.delete(providerKey);
	}

	getModelKey(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#resolveContextPromotionConfiguredTarget(currentModel: Model, availableModels: Model[]): Model | undefined {
		const configuredTarget = currentModel.contextPromotionTarget?.trim();
		if (!configuredTarget) return undefined;

		const parsed = parseModelString(configuredTarget);
		if (parsed) {
			const explicitModel = availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
			if (explicitModel) return explicitModel;
		}

		return availableModels.find(m => m.provider === currentModel.provider && m.id === configuredTarget);
	}

	#resolveRoleModel(role: ModelRole, availableModels: Model[], currentModel: Model | undefined): Model | undefined {
		const roleModelStr =
			role === "default"
				? (this.#settings.getModelRole("default") ??
					(currentModel ? `${currentModel.provider}/${currentModel.id}` : undefined))
				: this.#settings.getModelRole(role);

		if (!roleModelStr) return undefined;

		const parsed = parseModelString(roleModelStr);
		if (parsed) {
			return availableModels.find(m => m.provider === parsed.provider && m.id === parsed.id);
		}
		const roleLower = roleModelStr.toLowerCase();
		return availableModels.find(m => m.id.toLowerCase() === roleLower);
	}
}
