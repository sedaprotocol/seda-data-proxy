import { createLogger, format, transports } from "winston";
import { Maybe } from "true-myth";
import { LOG_LEVEL } from "./constants";

function cyan(val: string) {
	return `\x1b[36m${val}\x1b[0m`;
}

const logFormat = format.printf((info) => {
	const requestId = Maybe.of(info.metadata?.requestId).mapOr(" ", (t) => {
		return ` [${cyan(t)}] `;
	});
	const logMsg = `${info.timestamp}${requestId}${info.level}`;

	if (info.metadata?.error) {
		return `${logMsg}: ${info.message} ${info.metadata.error}`;
	}

	return `${logMsg}: ${info.message}`;
});

const logger = createLogger({
	level: LOG_LEVEL,
	format: format.combine(
		format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
		format.metadata({
			fillExcept: ["message", "level", "timestamp", "label"],
		}),
	),
	transports: [
		new transports.Console({
			format: format.combine(format.colorize(), logFormat),
		}),
	],
});

export default logger;
