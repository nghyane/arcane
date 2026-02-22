/**
 * Centralized file logger for arcane.
 *
 * Logs to ~/.arcane/logs/ with size-based rotation, supporting concurrent arcane instances.
 * Each log entry includes process.pid for traceability.
 */
import * as fs from "node:fs";
import winston from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import { getLogsDir } from "./dirs";

/** Ensure logs directory exists */
function ensureLogsDir(): string {
	const logsDir = getLogsDir();
	if (!fs.existsSync(logsDir)) {
		fs.mkdirSync(logsDir, { recursive: true });
	}
	return logsDir;
}

/** Custom format that includes pid and flattens metadata */
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: "YYYY-MM-DDTHH:mm:ss.SSSZ" }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		const entry: Record<string, unknown> = {
			timestamp,
			level,
			pid: process.pid,
			message,
		};
		// Flatten metadata into entry
		for (const [key, value] of Object.entries(meta)) {
			if (key !== "level" && key !== "timestamp" && key !== "message") {
				entry[key] = value;
			}
		}
		return JSON.stringify(entry);
	}),
);

/** Size-based rotating file transport */
const fileTransport = new DailyRotateFile({
	dirname: ensureLogsDir(),
	filename: "arcane.%DATE%.log",
	datePattern: "YYYY-MM-DD",
	maxSize: "10m",
	maxFiles: 5,
	zippedArchive: true,
});

/** The winston logger instance */
const winstonLogger = winston.createLogger({
	level: "debug",
	format: logFormat,
	transports: [fileTransport],
	// Don't exit on error - logging failures shouldn't crash the app
	exitOnError: false,
});

/**
 * Centralized logger for arcane.
 *
 * Logs to ~/.arcane/logs/arc.YYYY-MM-DD.log with size-based rotation.
 * Safe for concurrent access from multiple arcane instances.
 *
 * @example
 * ```typescript
 * import { logger } from "@nghyane/arcane-utils";
 *
 * logger.error("MCP request failed", { url, method });
 * logger.warn("Theme file invalid, using fallback", { path });
 * logger.debug("LSP fallback triggered", { reason });
 * ```
 */
export interface Logger {
	error(message: string, context?: Record<string, unknown>): void;
	warn(message: string, context?: Record<string, unknown>): void;
	debug(message: string, context?: Record<string, unknown>): void;
}

export function error(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.error(message, context);
	} catch {
		// Silently ignore logging failures
	}
}

export function warn(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.warn(message, context);
	} catch {
		// Silently ignore logging failures
	}
}

export function debug(message: string, context?: Record<string, unknown>): void {
	try {
		winstonLogger.debug(message, context);
	} catch {
		// Silently ignore logging failures
	}
}
