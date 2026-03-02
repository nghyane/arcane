import { Database, type Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger, parseJsonlLenient } from "@nghyane/arcane-utils";
import { getAgentDir } from "@nghyane/arcane-utils/dirs";

export interface SessionIndexEntry {
	sessionId: string;
	title: string;
	firstMessage: string;
	files: string;
	cwd: string;
	createdAt: number;
	messageCount: number;
}

export interface SessionSearchResult {
	threadId: string;
	title: string;
	date: string;
	messageCount: number;
	snippet: string;
}

interface SearchRow {
	session_id: string;
	title: string;
	created_at: number;
	message_count: number;
	snippet: string;
}

const FILE_PATH_PARAMS = new Set(["path", "file", "filePath", "glob", "pattern", "command_working_directory"]);

export class SessionIndex {
	#db: Database;
	static #instance?: SessionIndex;

	#upsertStmt: Statement;
	#hasStmt: Statement;

	private constructor(dbPath: string) {
		const dir = path.dirname(dbPath);
		fs.mkdirSync(dir, { recursive: true });

		this.#db = new Database(dbPath);

		this.#db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS session_index (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    first_message TEXT,
    files TEXT,
    cwd TEXT,
    created_at INTEGER,
    message_count INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
    title, first_message, files,
    content='session_index', content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS session_index_ai AFTER INSERT ON session_index BEGIN
    INSERT INTO session_fts(rowid, title, first_message, files)
    VALUES (new.rowid, new.title, new.first_message, new.files);
END;

CREATE TRIGGER IF NOT EXISTS session_index_ad AFTER DELETE ON session_index BEGIN
    INSERT INTO session_fts(session_fts, rowid, title, first_message, files)
    VALUES ('delete', old.rowid, old.title, old.first_message, old.files);
END;

CREATE TRIGGER IF NOT EXISTS session_index_au AFTER UPDATE ON session_index BEGIN
    INSERT INTO session_fts(session_fts, rowid, title, first_message, files)
    VALUES ('delete', old.rowid, old.title, old.first_message, old.files);
    INSERT INTO session_fts(rowid, title, first_message, files)
    VALUES (new.rowid, new.title, new.first_message, new.files);
END;
`);

		this.#upsertStmt = this.#db.prepare(
			"INSERT OR REPLACE INTO session_index (session_id, title, first_message, files, cwd, created_at, message_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		this.#hasStmt = this.#db.prepare("SELECT 1 FROM session_index WHERE session_id = ?");
	}

	static open(dbPath: string = path.join(getAgentDir(), "session-index.db")): SessionIndex {
		if (!SessionIndex.#instance) {
			SessionIndex.#instance = new SessionIndex(dbPath);
		}
		return SessionIndex.#instance;
	}

	upsert(entry: SessionIndexEntry): void {
		try {
			this.#upsertStmt.run(
				entry.sessionId,
				entry.title,
				entry.firstMessage,
				entry.files,
				entry.cwd,
				entry.createdAt,
				entry.messageCount,
			);
		} catch (error) {
			logger.error("SessionIndex upsert failed", { error: String(error) });
		}
	}

	has(sessionId: string): boolean {
		return this.#hasStmt.get(sessionId) != null;
	}

	search(query: string, limit: number): SessionSearchResult[] {
		const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 50);
		const { ftsQuery, afterTs, beforeTs } = this.#parseQuery(query);
		if (!ftsQuery) return [];

		const conditions = ["session_fts MATCH ?"];
		const params: (string | number)[] = [ftsQuery];

		if (afterTs != null) {
			conditions.push("si.created_at >= ?");
			params.push(afterTs);
		}
		if (beforeTs != null) {
			conditions.push("si.created_at <= ?");
			params.push(beforeTs);
		}
		params.push(safeLimit);

		const sql = `SELECT si.session_id, si.title, si.created_at, si.message_count,
       snippet(session_fts, -1, '<match>', '</match>', '...', 32) as snippet
FROM session_fts f
JOIN session_index si ON si.rowid = f.rowid
WHERE ${conditions.join(" AND ")}
ORDER BY si.created_at DESC
LIMIT ?`;

		try {
			const rows = this.#db.prepare(sql).all(...params) as SearchRow[];
			return rows.map(row => ({
				threadId: row.session_id,
				title: row.title || "Untitled",
				date: new Date(row.created_at * 1000).toISOString().slice(0, 10),
				messageCount: row.message_count,
				snippet: row.snippet || "",
			}));
		} catch (error) {
			logger.error("SessionIndex search failed", { error: String(error) });
			return [];
		}
	}

	async indexSessionFile(filePath: string): Promise<void> {
		try {
			const content = await Bun.file(filePath).text();
			const entries = parseJsonlLenient<Record<string, unknown>>(content);
			if (entries.length === 0) return;

			const header = entries.find(e => e.type === "session") as
				| { type: string; id?: string; title?: string; cwd?: string; timestamp?: string }
				| undefined;
			if (!header?.id) return;

			let firstMessage = "";
			let messageCount = 0;
			const fileSet = new Set<string>();

			for (const entry of entries) {
				if (entry.type !== "message") continue;
				const msg = entry.message as { role?: string; content?: unknown } | undefined;
				if (!msg?.role) continue;

				messageCount++;

				if (msg.role === "user" && !firstMessage) {
					firstMessage = extractTextContent(msg.content);
				}

				if (msg.role === "assistant") {
					extractFilePaths(msg.content, fileSet);
				}
			}

			const title = header.title || firstMessage.slice(0, 100) || "Untitled";
			const createdAt = header.timestamp ? Math.floor(new Date(header.timestamp).getTime() / 1000) : 0;

			this.upsert({
				sessionId: header.id,
				title,
				firstMessage: firstMessage.slice(0, 500),
				files: [...fileSet].join(" "),
				cwd: header.cwd || "",
				createdAt,
				messageCount,
			});
		} catch (error) {
			logger.warn("SessionIndex indexSessionFile failed", { path: filePath, error: String(error) });
		}
	}

	async indexAllSessions(sessionsDir?: string): Promise<void> {
		const dir = sessionsDir ?? path.join(getAgentDir(), "sessions");
		let subdirs: string[];
		try {
			subdirs = fs.readdirSync(dir);
		} catch {
			return;
		}

		for (const subdir of subdirs) {
			const subdirPath = path.join(dir, subdir);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(subdirPath);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;

			let files: string[];
			try {
				files = fs.readdirSync(subdirPath).filter(f => f.endsWith(".jsonl"));
			} catch {
				continue;
			}

			for (const file of files) {
				const filePath = path.join(subdirPath, file);
				try {
					const firstLine = await Bun.file(filePath).text();
					const headerLine = firstLine.split("\n")[0];
					if (!headerLine) continue;
					const header = JSON.parse(headerLine) as { id?: string };
					if (!header.id) continue;
					if (this.has(header.id)) continue;
					await this.indexSessionFile(filePath);
				} catch {}
			}
		}
	}

	#parseQuery(query: string): { ftsQuery: string | null; afterTs: number | null; beforeTs: number | null } {
		let afterTs: number | null = null;
		let beforeTs: number | null = null;

		const remaining = query.replace(/\b(after|before):(\S+)/g, (_, dir: string, val: string) => {
			const ts = this.#parseDate(val);
			if (ts != null) {
				if (dir === "after") afterTs = ts;
				else beforeTs = ts;
			}
			return "";
		});

		const ftsQuery = this.#buildFtsQuery(remaining);
		return { ftsQuery, afterTs, beforeTs };
	}

	#parseDate(value: string): number | null {
		const relMatch = value.match(/^(\d+)([dwm])$/);
		if (relMatch) {
			const n = Number.parseInt(relMatch[1], 10);
			const unit = relMatch[2];
			const now = Date.now();
			let ms = 0;
			if (unit === "d") ms = n * 86400_000;
			else if (unit === "w") ms = n * 7 * 86400_000;
			else if (unit === "m") ms = n * 30 * 86400_000;
			return Math.floor((now - ms) / 1000);
		}

		const d = new Date(value);
		if (!Number.isNaN(d.getTime())) {
			return Math.floor(d.getTime() / 1000);
		}
		return null;
	}

	#buildFtsQuery(query: string): string | null {
		const tokens = query
			.trim()
			.split(/\s+/)
			.map(t => t.trim())
			.filter(Boolean);

		if (tokens.length === 0) return null;

		return tokens
			.map(token => {
				const escaped = token.replace(/"/g, '""');
				return `"${escaped}"*`;
			})
			.join(" ");
	}
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
				return String(block.text);
			}
		}
	}
	return "";
}

function extractFilePaths(content: unknown, fileSet: Set<string>): void {
	if (!Array.isArray(content)) return;
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		const args = "arguments" in block ? (block.arguments as Record<string, unknown>) : null;
		if (!args) continue;
		for (const [key, val] of Object.entries(args)) {
			if (FILE_PATH_PARAMS.has(key) && typeof val === "string" && val.length > 0) {
				fileSet.add(val);
			}
		}
	}
}
