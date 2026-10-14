export type { UpdateInfo } from "../update.ts";

// The page reloads once the restarted server reports another version than the one it had before.
export const shouldReload = (before: string, after: string | undefined) => !!after && after !== before;
