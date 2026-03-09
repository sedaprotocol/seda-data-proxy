import { Data } from "effect";

export class FailedToDecodeProofError extends Data.TaggedError(
	"FailedToDecodeProofError",
)<{ error: string | unknown }> {
	message = `Failed to decode proof: ${this.error}`;
}

export class FailedToDecodeSedaFastProofError extends Data.TaggedError(
	"FailedToDecodeSedaFastProofError",
)<{ error: string | unknown }> {
	message = `Failed to decode SEDA Fast proof: ${this.error}`;
}

export class FailedToVerifyCoreProofError extends Data.TaggedError(
	"FailedToVerifyCoreProofError",
)<{ error: string | unknown }> {
	message = `Failed to verify core proof: ${this.error}`;
}

export class FailedToGetCosmWasmClientError extends Data.TaggedError(
	"FailedToGetCosmWasmClientError",
)<{ error: string | unknown }> {
	message = `Failed to get cosmwasm client: ${this.error}`;
}

export class FailedToGetCometClientError extends Data.TaggedError(
	"FailedToGetCometClientError",
)<{ error: string | unknown }> {
	message = `Failed to get comet client: ${this.error}`;
}

export class FailedToGetCoreContractAddressError extends Data.TaggedError(
	"FailedToGetCoreContractAddressError",
)<{ error: string | unknown }> {
	message = `Failed to get core contract address: ${this.error}`;
}

export class FailedToGetDataProxyRegistrationError extends Data.TaggedError(
	"FailedToGetDataProxyRegistrationError",
)<{ error: string | unknown }> {
	message = `Failed to get data proxy registration: ${this.error}`;
}
