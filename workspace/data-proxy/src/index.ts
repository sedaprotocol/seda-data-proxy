#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";
import { version } from "../package.json";
import { initCommand } from "./cli/init";
import { registerCommand } from "./cli/register";
import { runCommand } from "./cli/run";

const program = new Command()
	.description("SEDA Data Proxy CLI")
	.version(version)
	.addHelpText("after", "\r")
	.addCommand(runCommand)
	.addCommand(initCommand)
	.addCommand(registerCommand)
	.helpOption(undefined, "Display this help");

program.parse(process.argv);
