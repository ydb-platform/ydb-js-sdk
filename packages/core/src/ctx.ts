import { createContextKey } from "@connectrpc/connect";

export const nodeIdKey = createContextKey(0, {
    description: "YDB Node ID",
});
