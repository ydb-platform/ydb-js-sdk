import type { DescMessage, MessageShape } from "@bufbuild/protobuf";
import type { StreamResponse } from "@connectrpc/connect";

export async function* withHooks<I extends DescMessage, O extends DescMessage>(res: StreamResponse<I, O>, hooks: {
    onMessage?: (message: MessageShape<O>) => void,
    onHeader?: (header: Headers) => void,
    onTailer?: (trailer: Headers) => void
}) {
    hooks.onHeader?.(res.header);

    for await (const m of res.message) {
        yield m;
        hooks.onMessage?.(m);
    }

    yield* res.message;

    hooks.onTailer?.(res.trailer);
}
