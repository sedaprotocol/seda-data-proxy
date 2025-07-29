import { createLogger, format, type transport, transports } from "winston";
import "winston-daily-rotate-file";
import { Maybe } from "true-myth";
import { LOG_FILE_DIR } from "./constants";

let envSecrets: Set<string> = new Set();

function redactEnvSecrets(message: string | unknown) {
	if (typeof message !== "string") {
		return message;
	}

	let result = message;
	for (const secret of envSecrets) {
		result = result.replace(secret, "<redacted>");
	}
	return result;
}

const logFormat = format.printf((info) => {
	const metadata =
		(info.metadata as { requestId?: string; error?: string | Error }) ?? {};

	const requestId = Maybe.of(metadata.requestId).mapOr(" ", (t) => {
		return ` [${cyan(t)}] `;
	});
	const logMsg = `${info.timestamp}${requestId}${info.level}`;

	const message = redactEnvSecrets(info.message);

	return Maybe.of(metadata.error).mapOr(
		`${logMsg}: ${message}`,
		(err) => `${logMsg}: ${message} ${err}`,
	);
});

const destinations: transport[] = [
	new transports.Console({
		format: format.combine(format.colorize(), logFormat),
	}),
];

if (LOG_FILE_DIR) {
	destinations.push(
		new transports.DailyRotateFile({
			filename: "data-proxy-%DATE%.log",
			dirname: LOG_FILE_DIR,
			format: format.json({
				replacer(key, value) {
					return redactEnvSecrets(value);
				},
			}),
			datePattern: "YYYY-MM-DD",
			maxFiles: "14d",
			level: "debug",
		}),
	);
}

const logger = createLogger({
	level: process.env.LOG_LEVEL ?? "info",
	format: format.combine(
		format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
		format.metadata({
			fillExcept: ["message", "level", "timestamp", "label"],
		}),
	),
	transports: destinations,
});

export function setLogLevel(level: string) {
	logger.level = level;
}

export function setEnvSecrets(secrets: Set<string>) {
	envSecrets = secrets;
}

export default logger;

function cyan(val: string) {
	return `\x1b[36m${val}\x1b[0m`;
}
