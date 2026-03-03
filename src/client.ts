/**
 * Raw gRPC client — no .proto files needed.
 * Uses Buffer passthrough for serialization/deserialization.
 */

import * as grpc from "@grpc/grpc-js";

export interface CallResult {
    error: grpc.ServiceError | null;
    response: Buffer | null;
}

export class LanguageServerClient {
    private client: grpc.Client;

    constructor(address: string, certPem: Buffer) {
        const channelCreds = grpc.credentials.createSsl(certPem);

        this.client = new grpc.Client(address, channelCreds, {
            "grpc.ssl_target_name_override": "localhost",
            // increase deadline defaults
            "grpc.max_receive_message_length": 10 * 1024 * 1024,
        });
    }

    /**
     * Make a raw unary gRPC call.
     * @param method  Full method path, e.g. "/exa.language_server_pb.LanguageServerService/Heartbeat"
     * @param metadata  gRPC metadata (for CSRF token etc.)
     * @param body  Request body bytes (empty for Heartbeat)
     * @param timeoutMs  Deadline in ms
     */
    callUnary(
        method: string,
        metadata: grpc.Metadata,
        body: Buffer = Buffer.alloc(0),
        timeoutMs: number = 5000
    ): Promise<CallResult> {
        return new Promise((resolve) => {
            this.client.makeUnaryRequest(
                method,
                (arg: Buffer) => arg,       // serialize: passthrough
                (arg: Buffer) => arg,       // deserialize: passthrough
                body,
                metadata,
                { deadline: new Date(Date.now() + timeoutMs) },
                (error, response) => {
                    resolve({
                        error: error as grpc.ServiceError | null,
                        response: (response as Buffer) ?? null,
                    });
                }
            );
        });
    }

    close(): void {
        this.client.close();
    }
}
