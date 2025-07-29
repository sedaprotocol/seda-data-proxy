import { version } from "../../package.json";

export function getVersions() {
	return {
		proxy: version,
	};
}
