#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import dotenv from "@dotenvx/dotenvx";

// Initialize dotenvx to decrypt environment variables
dotenv.config({
	path: process.env.DOTENV_CONFIG_PATH,
	envKeysFile:
		process.env.DOTENV_KEYS_PATH ??
		join(homedir(), ".dotenvx", "data-proxy.keys"),
	overload: true, // Override existing environment variables
});

import { Command } from "@commander-js/extra-typings";
import { version } from "../package.json";
import { initCmd } from "./cli/init";
import { registerCmd } from "./cli/register";
import { runCmd, validateCmd } from "./cli/run";

const program = new Command()
	.description("SEDA Data Proxy CLI")
	.version(version)
	.addHelpText("after", "\r")
	.addCommand(runCmd)
	.addCommand(validateCmd)
	.addCommand(initCmd)
	.addCommand(registerCmd)
	.helpOption(undefined, "Display this help");

program.parse(process.argv);
