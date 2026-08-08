/**
 * The platform-independent gate suite run by `npm run ci`, in execution order.
 * Each entry is the argument list handed to npm, e.g. `["run", "lint:all"]`.
 */
export const SOURCE_VERIFICATION_CHECKS: readonly (readonly string[])[];
