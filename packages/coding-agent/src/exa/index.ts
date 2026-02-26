/**
 * Exa MCP Tools
 *
 * Provides Exa tools filtered by user settings.
 */
import type { ExaSettings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { companyTool } from "./company";
import { linkedinTool } from "./linkedin";
import { researcherTools } from "./researcher";
import { searchTools } from "./search";
import type { ExaRenderDetails } from "./types";
import { websetsTools } from "./websets";

/** Get Exa tools filtered by settings */
export function getExaTools(settings: Required<ExaSettings>): CustomTool<any, ExaRenderDetails>[] {
	if (!settings.enabled) return [];

	const tools: CustomTool<any, ExaRenderDetails>[] = [];

	if (settings.enableSearch) tools.push(...searchTools);
	if (settings.enableLinkedin) tools.push(linkedinTool);
	if (settings.enableCompany) tools.push(companyTool);
	if (settings.enableResearcher) tools.push(...researcherTools);
	if (settings.enableWebsets) tools.push(...websetsTools);

	return tools;
}
