import { createHmac } from "node:crypto";

function ask(label: string, defaultValue?: string): string {
	const suffix = defaultValue ? ` [${defaultValue}]` : "";
	const answer = prompt(`${label}${suffix}:`)?.trim();
	const value = answer || defaultValue;

	if (!value) {
		console.error(`A value for "${label}" is required.`);
		process.exit(1);
	}

	return value;
}

const issuer = ask("Issuer (provided by dxFeed)");
const secret = ask("Secret (signing key provided by dxFeed)");
const session = ask("Session / sessionType (provided by dxFeed)");
const message = ask("Message (<userID> or <userID>,<filter_1>;...;<filter_n>)");
const days = Number(ask("Validity in days", "30"));

if (!Number.isInteger(days) || days <= 0) {
	console.error("Validity in days must be a positive integer.");
	process.exit(1);
}

const notBeforeTime = "";
const issuedAtTime = Math.floor(Date.now() / 1000);
const expirationTime = issuedAtTime + days * 86400;

const payload = [
	issuer,
	session,
	notBeforeTime,
	expirationTime,
	issuedAtTime,
	message,
].join(",");

const encodedPayload = Buffer.from(encodeURI(payload))
	.toString("base64")
	.split("=")[0];

const signature = createHmac("sha256", encodeURI(secret))
	.update(encodedPayload)
	.digest("base64")
	.split("=")[0]
	.replace(/\+/g, "-")
	.replace(/\//g, "_");

const token = `${encodedPayload}.${signature}`;

console.log(`\nPayload: ${payload}`);
console.log(
	`Expires: ${new Date(expirationTime * 1000).toISOString()} (in ${days} ${days === 1 ? "day" : "days"})`,
);
console.log(`\nToken: ${token}`);
