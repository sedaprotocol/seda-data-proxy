import { FileSystem, Path } from "@effect/platform";
import chalk from "chalk";
import { format } from "date-fns/format";
import {
	Cause,
	Clock,
	Duration,
	Effect,
	FiberId,
	Inspectable,
	LogLevel,
	LogSpan,
	Logger,
	Match,
	Option,
} from "effect";
import type { DurationInput } from "effect/Duration";
import {
	LOG_FILE_DATE_PATTERN,
	LOG_FILE_DIR,
	LOG_FILE_MAX_FILES,
	LOG_LEVEL,
} from "./constants";

let envSecrets: Set<string> = new Set();

function redactEnvSecrets(message: string | unknown) {
	if (typeof message !== "string") {
		return message;
	}

	let result = message;
	for (const secret of envSecrets) {
		result = result.replaceAll(secret, "<redacted>");
	}
	return result;
}

export function setEnvSecrets(secrets: Set<string>) {
	envSecrets = secrets;
}

const myStringLogger = Logger.jsonLogger;

export interface RotatedFileLoggerOptions {
	batchWindow?: DurationInput;
	datePattern?: string;
	maxFiles?: number;
}

interface RotatedFileLoggerConfig {
	files: {
		date: number;
		filePath: string;
	}[];
}

const ROTATED_FILE_CONFIG_FILE = "rotating-logger.json";

const parseRotatingFileConfig = (dirPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const fileExists = yield* fs.exists(
			path.resolve(dirPath, ROTATED_FILE_CONFIG_FILE),
		);

		if (!fileExists) {
			return {
				files: [],
			};
		}

		const rawConfig = yield* fs.readFileString(
			path.resolve(dirPath, ROTATED_FILE_CONFIG_FILE),
		);
		const config = JSON.parse(rawConfig) as RotatedFileLoggerConfig;
		return config;
	});

const createFileName = (datePattern: string) =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis;
		return `${format(new Date(now), datePattern)}.log`;
	});

const rotatedFileLogger = <Message>(
	self: Logger.Logger<Message, string>,
	dirPath: string,
	options?: RotatedFileLoggerOptions,
) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;
		const encoder = new TextEncoder();

		const datePattern = options?.datePattern ?? "yyyy-MM-dd";
		const maxFiles = options?.maxFiles ?? 10;
		const absoluteDirPath = path.resolve(dirPath);

		// Make sure the directory exists
		yield* fs.makeDirectory(absoluteDirPath, { recursive: true });

		// Find the rotating file configuration
		const config: RotatedFileLoggerConfig =
			yield* parseRotatingFileConfig(absoluteDirPath);
		const lastLogFile = Option.fromNullable(
			config.files[config.files.length - 1],
		);

		// Open the log files
		const openLogFile = yield* Match.value(lastLogFile).pipe(
			Match.when(Option.isSome, (file) =>
				Effect.gen(function* () {
					const openFile = yield* fs.open(file.value.filePath, {
						flag: "a+",
						...options,
					});

					return {
						filePath: file.value.filePath,
						file: openFile,
					};
				}),
			),
			Match.when(Option.isNone, () =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const fileName = yield* createFileName(datePattern);
					const absoluteFilePath = path.resolve(absoluteDirPath, fileName);

					// Since there is no config file we need to create it
					yield* fs.writeFileString(
						path.resolve(absoluteDirPath, ROTATED_FILE_CONFIG_FILE),
						JSON.stringify(
							{
								files: [
									{
										date: now,
										filePath: absoluteFilePath,
									},
								],
							},
							null,
							2,
						),
					);

					return {
						filePath: absoluteFilePath,
						file: yield* fs.open(absoluteFilePath, { flag: "a+", ...options }),
					};
				}),
			),
			Match.exhaustive,
		);

		return yield* Logger.batched(
			self,
			options?.batchWindow ?? Duration.seconds(1),
			(output) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis;
					const fileName = yield* createFileName(datePattern);
					const absoluteFilePath = path.resolve(absoluteDirPath, fileName);
					const message = redactEnvSecrets(output.join("\n"));

					if (openLogFile.filePath === absoluteFilePath) {
						// The file is the same, so we can just write to it
						yield* openLogFile.file.write(encoder.encode(`${message}\n`));
					} else {
						// We need to rotate now
						openLogFile.file = yield* fs.open(absoluteFilePath, {
							flag: "a+",
							...options,
						});
						openLogFile.filePath = absoluteFilePath;

						// Update the config
						config.files.push({
							date: now,
							filePath: absoluteFilePath,
						});

						// Remove the oldest file if we have too many
						if (config.files.length > maxFiles) {
							const oldestFile = config.files.shift();

							if (oldestFile) {
								yield* fs.remove(oldestFile.filePath);
							}
						}

						// Write the config to the file
						yield* fs.writeFileString(
							path.resolve(absoluteDirPath, ROTATED_FILE_CONFIG_FILE),
							JSON.stringify(config, null, 2),
						);

						// Write to the new file
						yield* openLogFile.file.write(encoder.encode(`${message}\n`));
					}
				}).pipe(
					Effect.catchAll((error) => {
						console.error("FATAL error in logs", error);
						return Effect.void;
					}),
				),
		);
	});

const makeCustomLogger = Logger.make(
	({ logLevel, message, fiberId, date, annotations, cause, spans }) => {
		let out = `${chalk.gray(date.toISOString())} `;

		out += Match.value(logLevel.label).pipe(
			Match.when("FATAL", () => chalk.red(logLevel.label)),
			Match.when("ERROR", () => chalk.red(logLevel.label)),
			// Add an extra space to align with the maximum log level length (5 characters)
			Match.when("WARN", () => chalk.yellow(`${logLevel.label} `)),
			Match.when("INFO", () => chalk.green(`${logLevel.label} `)),
			Match.when("DEBUG", () => chalk.blue(logLevel.label)),
			Match.when("TRACE", () => chalk.gray(logLevel.label)),
			Match.orElse(() => chalk.gray(logLevel.label)),
		);

		out += ` ${chalk.bold(`${FiberId.threadName(fiberId)}`)}`;

		for (const [_label, value] of annotations) {
			out += ` [${chalk.gray(value)}]`;
		}

		const messages = Array.isArray(message) ? message : [message];
		for (let i = 0; i < messages.length; i++) {
			out += ` ${Inspectable.toStringUnknown(messages[i])}`;
		}

		if (!Cause.isEmpty(cause)) {
			out += ` ${chalk.red(Cause.pretty(cause, { renderErrorCause: true }))}`;
		}

		for (const span of spans) {
			out += ` ${chalk.yellow.bold(LogSpan.render(date.getTime())(span))}`;
		}

		const filteredOut = redactEnvSecrets(out);

		// Log to the correct console method, helps with debugging
		Match.value(logLevel.label).pipe(
			Match.when("DEBUG", () => console.debug(filteredOut)),
			Match.when("INFO", () => console.info(filteredOut)),
			Match.when("WARN", () => console.warn(filteredOut)),
			Match.when("ERROR", () => console.error(filteredOut)),
			Match.when("FATAL", () => console.error(filteredOut)),
			Match.orElse(() => console.log(filteredOut)),
		);
	},
);

export const logBootstrap =
	(debug: boolean) =>
	<A, E, R>(self: Effect.Effect<A, E, R>) =>
		Effect.gen(function* () {
			let logLevel = yield* LOG_LEVEL;

			if (debug) {
				logLevel = "Debug";
			}

			const fileLogger = yield* rotatedFileLogger(
				myStringLogger,
				yield* LOG_FILE_DIR,
				{
					batchWindow: Duration.seconds(1),
					datePattern: yield* LOG_FILE_DATE_PATTERN,
					maxFiles: yield* LOG_FILE_MAX_FILES,
				},
			);

			const combinedLogger = Logger.zip(makeCustomLogger, fileLogger);
			const combinedLoggerLive = Logger.replace(
				Logger.defaultLogger,
				combinedLogger,
			);

			return yield* self.pipe(
				Logger.withMinimumLogLevel(LogLevel.fromLiteral(logLevel)),
				Effect.provide(combinedLoggerLive),
			);
		});
