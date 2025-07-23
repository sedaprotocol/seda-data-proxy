import { resolve } from "node:path";
import { readableStreamToText } from "bun";

const PLATFORM_TARGETS = [
	"bun-linux-x64",
	"bun-linux-arm64",
	"bun-darwin-x64",
	"bun-darwin-arm64",
	"bun-linux-x64-musl",
	"bun-linux-arm64-musl",
];

const BINARY_NAME = "seda-data-proxy";
const BUILD_FOLDER = resolve(import.meta.dir, "./build/");
const SRC_TARGET = [
	resolve(process.cwd(), "./workspace/data-proxy/src/index.ts"),
];

await Promise.all(
	PLATFORM_TARGETS.map(async (target) => {
		const rawTarget = target.replace("bun-", "");
		console.log(`Compiling for ${rawTarget}..`);

		const cmd = [
			"bun",
			"build",
			"--compile",
			`--target=${target}`,
			...SRC_TARGET,
			"--outfile",
			`${BINARY_NAME}-${rawTarget}`,
		];

		const tmpDir = Bun.env.TMPDIR ?? "/tmp";
		const result = Bun.spawn(cmd, {
			cwd: tmpDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await result.exited;

		if (exitCode !== 0) {
			console.log(
				`Compilation failed for ${rawTarget}: ${await readableStreamToText(result.stderr)} \n ${await readableStreamToText(result.stdout)}`,
			);
		} else {
			// Copy the built binary to build directory
			const binaryName = `${BINARY_NAME}-${rawTarget}${rawTarget.includes("windows") ? ".exe" : ""}`;
			await Bun.write(
				resolve(BUILD_FOLDER, binaryName),
				Bun.file(resolve(tmpDir, binaryName)),
			);
		}

		console.log(`Compiled ${rawTarget}`);
	}),
);
