import { $env } from "@nghyane/arcane-utils";
import OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
} from "openai/resources/responses/responses";
import { getEnvApiKey } from "../stream";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolChoice,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { appendRawHttpRequestDumpFor400, type RawHttpRequestDump } from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { sanitizeSurrogates } from "../utils/sanitize-unicode";
import { mapToOpenAIResponsesToolChoice } from "../utils/tool-choice";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers";
import {
	appendResponsesToolResultMessages,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	normalizeResponsesToolCallIdForTransform,
	processResponsesStream,
} from "./openai-responses-shared";
import { transformMessages } from "./transform-messages";

/**
 * Resolve cache retention preference.
 * Defaults to "short" and uses ARCANE_CACHE_RETENTION for backward compatibility.
 */
function resolveCacheRetention(cacheRetention?: CacheRetention): CacheRetention {
	if (cacheRetention) {
		return cacheRetention;
	}
	if ($env.ARCANE_CACHE_RETENTION === "long") {
		return "long";
	}
	return "short";
}

/**
 * Get prompt cache retention based on cacheRetention and base URL.
 * Only applies to direct OpenAI API calls (api.openai.com).
 */
function getPromptCacheRetention(baseUrl: string, cacheRetention: CacheRetention): "24h" | undefined {
	if (cacheRetention !== "long") {
		return undefined;
	}
	if (baseUrl.includes("api.openai.com")) {
		return "24h";
	}
	return undefined;
}

// OpenAI Responses-specific options
export interface OpenAIResponsesOptions extends StreamOptions {
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	toolChoice?: ToolChoice;
	/**
	 * Enforce strict tool call/result pairing when building Responses API inputs.
	 * Azure OpenAI and GitHub Copilot Responses paths require tool results to match prior tool calls.
	 */
	strictResponsesPairing?: boolean;
}

/**
 * Generate function for OpenAI Responses API
 */
export const streamOpenAIResponses: StreamFunction<"openai-responses"> = (
	model: Model<"openai-responses">,
	context: Context,
	options?: OpenAIResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	// Start async processing
	(async () => {
		const startTime = Date.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-responses" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			// Create OpenAI client
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			const client = createClient(model, context, apiKey, options?.headers);
			const params = buildParams(model, context, options);
			options?.onPayload?.(params);
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: `${model.baseUrl ?? "https://api.openai.com/v1"}/responses`,
				body: params,
			};
			const openaiStream = await client.responses.create(
				params,
				options?.signal ? { signal: options.signal } : undefined,
			);
			stream.push({ type: "start", partial: output });
			await processResponsesStream(openaiStream, output, stream, model, {
				onFirstToken: () => {
					if (!firstTokenTime) firstTokenTime = Date.now();
				},
			});

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error("An unknown error occurred");
			}

			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as { index?: number }).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = await appendRawHttpRequestDumpFor400(
				formatErrorMessageWithRetryAfter(error),
				error,
				rawRequestDump,
			);
			output.duration = Date.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function createClient(
	model: Model<"openai-responses">,
	context: Context,
	apiKey?: string,
	extraHeaders?: Record<string, string>,
) {
	if (!apiKey) {
		if (!$env.OPENAI_AARCANE_KEY) {
			throw new Error(
				"OpenAI API key is required. Set OPENAI_AARCANE_KEY environment variable or pass it as an argument.",
			);
		}
		apiKey = $env.OPENAI_AARCANE_KEY;
	}

	const headers = { ...(model.headers ?? {}), ...(extraHeaders ?? {}) };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
		Object.assign(headers, copilotHeaders);
	}

	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		maxRetries: 5,
		defaultHeaders: headers,
	});
}

function buildParams(model: Model<"openai-responses">, context: Context, options?: OpenAIResponsesOptions) {
	const strictResponsesPairing =
		options?.strictResponsesPairing ??
		(isAzureOpenAIBaseUrl(model.baseUrl ?? "") || model.provider === "github-copilot");
	const messages = convertMessages(model, context, strictResponsesPairing);

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = cacheRetention === "none" ? undefined : options?.sessionId;
	const params: ResponseCreateParamsStreaming = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: promptCacheKey ? getPromptCacheRetention(model.baseUrl, cacheRetention) : undefined,
		store: false,
	};

	if (options?.maxTokens) {
		params.max_output_tokens = options?.maxTokens;
	}

	if (options?.temperature !== undefined) {
		params.temperature = options?.temperature;
	}

	if (options?.serviceTier !== undefined) {
		params.service_tier = options.serviceTier;
	}

	if (context.tools) {
		params.tools = convertTools(context.tools);
		if (options?.toolChoice) {
			params.tool_choice = mapToOpenAIResponsesToolChoice(options.toolChoice);
		}
	}

	if (model.reasoning) {
		// Always request encrypted reasoning content so reasoning items can be
		// replayed in multi-turn conversations when store is false (items aren't
		// persisted server-side, so we must include the full content).
		// See: https://github.com/nghyane/arcane/issues/41
		params.include = ["reasoning.encrypted_content"];

		if (options?.reasoningEffort || options?.reasoningSummary) {
			params.reasoning = {
				effort: options?.reasoningEffort || "medium",
				summary: options?.reasoningSummary || "auto",
			};
		} else {
			if (model.name.startsWith("gpt-5")) {
				// Jesus Christ, see https://community.openai.com/t/need-reasoning-false-option-for-gpt-5/1351588/7
				messages.push({
					role: "developer",
					content: [
						{
							type: "input_text",
							text: "# Juice: 0 !important",
						},
					],
				});
			}
		}
	}

	return params;
}

function isAzureOpenAIBaseUrl(baseUrl: string): boolean {
	return baseUrl.includes(".openai.azure.com") || baseUrl.includes("azure.com/openai");
}

function convertMessages(
	model: Model<"openai-responses">,
	context: Context,
	strictResponsesPairing: boolean,
): ResponseInput {
	const messages: ResponseInput = [];
	const knownCallIds = new Set<string>();
	const transformedMessages = transformMessages(context.messages, model, normalizeResponsesToolCallIdForTransform);

	if (context.systemPrompt) {
		const role = model.reasoning ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			const content = convertResponsesInputContent(msg.content, model.input.includes("image"), sanitizeSurrogates);
			if (!content) continue;
			messages.push({ role: "user", content });
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const outputItems = convertResponsesAssistantMessage(
				assistantMsg,
				model,
				msgIndex,
				knownCallIds,
				sanitizeSurrogates,
			);
			if (outputItems.length === 0) continue;
			messages.push(...outputItems);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				model,
				strictResponsesPairing,
				knownCallIds,
				sanitizeSurrogates,
			);
		}
		msgIndex++;
	}

	return messages;
}

function convertTools(tools: Tool[]): OpenAITool[] {
	return tools.map(tool => ({
		type: "function",
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as Record<string, unknown>,
		strict: false,
	}));
}
