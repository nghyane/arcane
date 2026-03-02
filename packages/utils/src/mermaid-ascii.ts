import { type AsciiRenderOptions, renderMermaidAscii } from "beautiful-mermaid";

export { type AsciiRenderOptions, renderMermaidAscii };

export function renderMermaidAsciiSafe(source: string, options?: AsciiRenderOptions): string | null {
	try {
		return renderMermaidAscii(source, options);
	} catch {
		return null;
	}
}

/**
 * Extract mermaid code blocks from markdown text.
 */
export function extractMermaidBlocks(markdown: string): { source: string; hash: bigint }[] {
	const blocks: { source: string; hash: bigint }[] = [];
	const regex = /```mermaid\s*\n([\s\S]*?)```/g;

	for (let match = regex.exec(markdown); match !== null; match = regex.exec(markdown)) {
		const source = match[1].trim();
		const hash = Bun.hash.xxHash64(source);
		blocks.push({ source, hash });
	}

	return blocks;
}
