/**
 * Discover running language_server_macos_x64 processes.
 * Parses `ps aux` to extract CSRF tokens, ports, and workspace IDs.
 */

import { execSync } from "node:child_process";

export interface ServerInfo {
    pid: number;
    csrfToken: string;
    extPort: number;
    grpcPort: number;        // ext_port + 1
    extCsrfToken: string;
    workspaceId: string;
    cloudCodeEndpoint: string;
}

export function discoverServers(filterWorkspace?: string): ServerInfo[] {
    const raw = execSync("ps aux", { encoding: "utf-8" });
    const lines = raw.split("\n").filter((l) => l.includes("language_server_macos_x64") && !l.includes("grep"));

    const servers: ServerInfo[] = [];

    for (const line of lines) {
        const csrfMatch = line.match(/--csrf_token\s+(\S+)/);
        const extPortMatch = line.match(/--extension_server_port\s+(\S+)/);
        const extCsrfMatch = line.match(/--extension_server_csrf_token\s+(\S+)/);
        const workspaceMatch = line.match(/--workspace_id\s+(\S+)/);
        const endpointMatch = line.match(/--cloud_code_endpoint\s+(\S+)/);
        const pidMatch = line.match(/^\S+\s+(\d+)/);

        if (!csrfMatch || !extPortMatch || !pidMatch) continue;

        const extPort = parseInt(extPortMatch[1], 10);

        const info: ServerInfo = {
            pid: parseInt(pidMatch[1], 10),
            csrfToken: csrfMatch[1],
            extPort,
            grpcPort: extPort + 1,
            extCsrfToken: extCsrfMatch?.[1] ?? "",
            workspaceId: workspaceMatch?.[1] ?? "unknown",
            cloudCodeEndpoint: endpointMatch?.[1] ?? "",
        };

        if (filterWorkspace && !info.workspaceId.includes(filterWorkspace)) continue;
        servers.push(info);
    }

    return servers;
}
