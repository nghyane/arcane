/**
 * Normalize LLM-generated code into a valid async arrow function.
 *
 * The LLM may produce:
 * - A complete async arrow function: `async () => { ... }`
 * - Loose statements: `const x = await codemode.read(...); return x;`
 * - A single expression: `codemode.bash({ command: "ls" })`
 * - Markdown-fenced code blocks
 * - Empty or whitespace
 *
 * This normalizer strips fences and wraps everything into `async () => { ... }` form.
 */

const ASYNC_ARROW_RE = /^\s*async\s*\(.*?\)\s*=>/s;
const FENCE_RE = /^```(?:jsx?|tsx?|javascript|typescript)?\s*\n([\s\S]*?)\n\s*```\s*$/;

/** Strip markdown code fences if present */
function stripFences(code: string): string {
	const match = FENCE_RE.exec(code);
	return match ? match[1] : code;
}

/** Lines starting with these cannot be auto-returned */
const NON_EXPRESSION_PREFIXES = [
	"const ",
	"let ",
	"var ",
	"if ",
	"if(",
	"for ",
	"for(",
	"while ",
	"while(",
	"switch ",
	"switch(",
	"try ",
	"try{",
	"throw ",
	"do ",
	"do{",
	"class ",
	"function ",
	"async function ",
	"{",
	"}",
	"})",
	"});",
	"else ",
	"else{",
	"}]",
	"],",
	"//",
	"/*",
	"return ",
];

export function normalizeCode(code: string): string {
	const trimmed = stripFences(code.trim()).trim();

	if (!trimmed) {
		return "async () => {}";
	}

	// Already a valid async arrow function
	if (ASYNC_ARROW_RE.test(trimmed)) {
		return trimmed;
	}

	// Check if code contains `return` statement — treat as function body
	if (/^\s*return\b/m.test(trimmed)) {
		return `async () => {\n${trimmed}\n}`;
	}

	// Check if code has multiple statements (contains semicolons or newlines with statements)
	const lines = trimmed.split("\n").filter(l => l.trim().length > 0);
	if (lines.length > 1) {
		// Multi-statement: wrap as body, auto-return last expression if possible
		const stmts = trimmed.split("\n");
		const lastLine = stmts[stmts.length - 1].trim();
		const isExpression = !NON_EXPRESSION_PREFIXES.some(p => lastLine.startsWith(p));

		if (isExpression) {
			stmts[stmts.length - 1] = `return (${lastLine.replace(/;$/, "")});`;
		}
		return `async () => {\n${stmts.join("\n")}\n}`;
	}

	// Single expression: wrap with return
	return `async () => {\nreturn (${trimmed.replace(/;$/, "")});\n}`;
}
