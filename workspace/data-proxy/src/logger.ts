import { createLogger, format, transports } from "winston";
import { LOG_LEVEL } from "./constants";

const logFormat = format.printf((info) => {
	if (info.metadata?.error) {
		return `${info.timestamp} ${info.level}: ${info.message} ${info.metadata.error}`;
	}

	return `${info.timestamp} ${info.level}: ${info.message}`;
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
