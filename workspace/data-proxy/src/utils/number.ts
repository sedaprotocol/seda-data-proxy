/** Maximum value of an unsigned 32-bit integer (2^32 - 1). */
export const U32_MAX = 0xffff_ffff;

/** True if `n` is an integer in the inclusive u32 range [0, 2^32 - 1]. */
export const isU32 = (n: number): boolean =>
	Number.isInteger(n) && n >= 0 && n <= U32_MAX;
