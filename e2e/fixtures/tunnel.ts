import { spawn, type ChildProcess } from "node:child_process";

let tunnelProcess: ChildProcess | null = null;

/**
 * Start a cloudflared tunnel to expose localhost:4738 publicly.
 * Returns the public tunnel URL.
 *
 * If E2E_TUNNEL_URL is set, skips starting a tunnel and returns that URL.
 */
export async function startTunnel(port: number): Promise<string> {
	const preConfigured = process.env.E2E_TUNNEL_URL;
	if (preConfigured) {
		console.log(`[e2e] Using pre-configured tunnel URL: ${preConfigured}`);
		return preConfigured;
	}

	return new Promise<string>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error("[e2e] Tunnel failed to start within 15s"));
		}, 15_000);

		tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
			stdio: ["ignore", "pipe", "pipe"],
		});

		tunnelProcess.on("error", (err) => {
			clearTimeout(timeout);
			reject(
				new Error(
					`[e2e] Failed to start cloudflared: ${err.message}\n` +
						"Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
				),
			);
		});

		// cloudflared prints the tunnel URL to stderr
		let stderrBuffer = "";
		tunnelProcess.stderr?.on("data", (chunk: Buffer) => {
			stderrBuffer += chunk.toString();
			const match = stderrBuffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
			if (match) {
				clearTimeout(timeout);
				console.log(`[e2e] Tunnel started: ${match[0]}`);
				resolve(match[0]);
			}
		});

		tunnelProcess.on("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0 && code !== null) {
				reject(new Error(`[e2e] cloudflared exited with code ${code}\nOutput: ${stderrBuffer}`));
			}
		});
	});
}

/**
 * Stop the tunnel process.
 */
export async function stopTunnel(): Promise<void> {
	if (tunnelProcess) {
		tunnelProcess.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			tunnelProcess!.on("close", () => resolve());
			setTimeout(resolve, 5_000); // Force resolve after 5s
		});
		tunnelProcess = null;
	}
}
