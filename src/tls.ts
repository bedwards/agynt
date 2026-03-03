/**
 * Extract the self-signed TLS certificate from the language server's gRPC port.
 */

import * as tls from "node:tls";

export function extractCert(host: string, port: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect(
            {
                host,
                port,
                servername: "localhost",
                rejectUnauthorized: false,   // self-signed
            },
            () => {
                const cert = socket.getPeerX509Certificate?.();
                if (!cert) {
                    socket.destroy();
                    return reject(new Error("No peer certificate returned"));
                }

                // Convert to PEM
                const pem = cert.toString();  // X509Certificate.toString() returns PEM
                socket.destroy();
                resolve(Buffer.from(pem, "utf-8"));
            }
        );

        socket.on("error", reject);
        socket.setTimeout(5000, () => {
            socket.destroy();
            reject(new Error("TLS connect timeout"));
        });
    });
}
