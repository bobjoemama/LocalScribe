export const TEST_RUN_DEADLINE_MS: number;
export const TEST_RUN_TERM_GRACE_MS: number;

export function processGroupIdForChild(pid: unknown): number;
export function processGroupIsAlive(processGroupId: number): boolean;
