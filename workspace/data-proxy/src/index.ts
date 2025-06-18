#!/usr/bin/env node
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
