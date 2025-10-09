#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
import dotenv from "@dotenvx/dotenvx";
import { version } from "../package.json";
import { initCmd } from "./cli/init";
import { registerCmd } from "./cli/register";
import { runCmd, validateCmd } from "./cli/run";

// Initialize dotenvx configuration
const dotenvResult = dotenv.config({
	path: process.env.DOTENV_CONFIG_PATH,
	envKeysFile:
		process.env.DOTENV_KEYS_PATH ??
		join(homedir(), ".dotenvx", "data-proxy.keys"),
	overload: true, // Override existing environment variables
});

// Debug: Log which variables were loaded (only show the first few characters)
if (process.env.NODE_ENV === "development" || process.env.DEBUG) {
	console.log("Loaded environment variables:");
	if (process.env.SEDA_DATA_PROXY_PRIVATE_KEY) {
		console.log(`  SEDA_DATA_PROXY_PRIVATE_KEY: ${process.env.SEDA_DATA_PROXY_PRIVATE_KEY.substring(0, 8)}...`);
	}
	if (process.env.ALCHEMY_API_KEY) {
		console.log(`  ALCHEMY_API_KEY: ${process.env.ALCHEMY_API_KEY.substring(0, 8)}...`);
	}
	if (process.env.DATA_PROXY_CONFIG) {
		console.log(`  DATA_PROXY_CONFIG: ${process.env.DATA_PROXY_CONFIG}`);
	}
}

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
