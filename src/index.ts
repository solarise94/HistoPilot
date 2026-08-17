/**
 * HistoPilot service process entry point.
 *
 * Resolves env-based configuration, runs boot-time session recovery, and
 * starts the HTTP server. The sidecar does NOT read ai_config.json — the
 * per-run engine config is injected by the caller (Flask proxy, Step 5) in
 * each request body.
 *
 * Env:
 *   HISTOPILOT_PORT   listen port (default 8055)
 *   HISTOPILOT_HOST   listen host (default 127.0.0.1)
 *                     且不发布宿主端口时才设 0.0.0.0；`--network host` 下
 *                     必须保持 127.0.0.1，否则无鉴权接口会绑到宿主网卡。
 *   HISTOPILOT_INTERNAL_TOKEN protects all endpoints except /healthz.
 *   HISTOPILOT_SESSIONS_DIR stores canonical sessions.
 *   PATHTOGETHER_URL is the PathTogether Plugin Contract base URL.
 */
import { SessionStore } from "./session-store.js";
import { SessionEventBus } from "./events.js";
import { AgentRunner } from "./agent-runner.js";
import { SidecarServer, assertInboundAuthAllowed } from "./server.js";
import { createFlaskClient, resolveAiInternalToken } from "./flask-client.js";
import { LegacyFlaskPlatformAdapter } from "./platform/legacy-flask-adapter.js";
import { PathTogetherHttpClient } from "./platform/http-client.js";
import { resolvePluginCredentials } from "./platform/plugin-credentials.js";
import type { PlatformClient } from "./platform/contract.js";

/**
 * Resolve the platform {@link PlatformClient} for production:
 *
 *   - WITH plugin credentials (env PLUGIN_INSTALLATION_ID + PLUGIN_HISTOPILOT_SECRET,
 *     or the platform's `plugin-secret-histopilot.txt`) → the formal
 *     `/api/plugin/v1` client (Bearer JWT + X-Run-Grant + unified envelope).
 *   - WITHOUT credentials the service fails closed. The legacy adapter is only
 *     available when HISTOPILOT_ALLOW_LEGACY_ADAPTER=1 is explicitly set.
 */
async function resolvePlatformClient(baseUrl: string): Promise<PlatformClient> {
	const creds = await resolvePluginCredentials();
	if (creds) {
		return new PathTogetherHttpClient({
			baseUrl,
			installationId: creds.installationId,
			secret: creds.secret,
		});
	}
	if (envFlag("HISTOPILOT_ALLOW_LEGACY_ADAPTER")) {
		console.warn("[histopilot] using explicitly enabled legacy /internal/ai adapter");
		const flaskEngine = await createFlaskClient();
		return new LegacyFlaskPlatformAdapter({ flask: flaskEngine });
	}
	throw new Error(
		"PathTogether plugin credentials are required: set PLUGIN_INSTALLATION_ID and PLUGIN_HISTOPILOT_SECRET",
	);
}

async function main(): Promise<void> {
	const store = new SessionStore();
	await store.ensureDir();

	// Boot recovery (ai_session.py:498-504 generalized): any session left
	// "running" by a crashed process is flipped to "paused", and every
	// session's last_event_seq is reconciled against its events file tail.
	const recovery = await store.recoverOnBoot();
	if (recovery.paused.length || recovery.repaired.length) {
		console.log(
			`[histopilot] boot recovery: ${recovery.paused.length} session(s) paused, ${recovery.repaired.length} seq-repaired`,
		);
	}
	if (recovery.legacy.length) {
		console.warn(
			`[histopilot] boot recovery: ${recovery.legacy.length} legacy session file(s) skipped (see warnings above)`,
		);
	}

	const bus = new SessionEventBus(store);
	// Production wiring (§9.2 / Stage 4-1b): prefer the formal /api/plugin/v1
	// client when plugin credentials are present. The legacy Flask adapter is
	// available only behind an explicit migration flag. HistoPilot core sees
	// only the PlatformClient surface either way.
	const baseUrl = process.env.PATHTOGETHER_URL || process.env.AI_FLASK_URL || "http://127.0.0.1:8000";
	const flask = await resolvePlatformClient(baseUrl);
	const runner = new AgentRunner(store, bus, flask);

	const port = parseInt(process.env.HISTOPILOT_PORT || process.env.AI_SIDECAR_PORT || "", 10) || 8055;
	const host = process.env.HISTOPILOT_HOST || process.env.AI_SIDECAR_HOST || "127.0.0.1";
	const allowUnauth = envFlag("HISTOPILOT_ALLOW_UNAUTH") || envFlag("ALLOW_UNAUTH_SIDECAR");
	let inboundToken = "";
	try {
		inboundToken = await resolveAiInternalToken();
	} catch {
		inboundToken = "";
	}
	if (!inboundToken) {
		assertInboundAuthAllowed(host, inboundToken, allowUnauth);
		console.warn(
			"[histopilot] inbound auth disabled on loopback; set HISTOPILOT_INTERNAL_TOKEN for production",
		);
	}
	const server = new SidecarServer({
		host, port, store, bus, flask, runner,
		internalToken: inboundToken, allowUnauth,
	});
	await server.start();
	console.log(`[histopilot] listening on http://${host}:${port}`);
}

function envFlag(name: string): boolean {
	const v = (process.env[name] || "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

main().catch((err) => {
	console.error("[histopilot] fatal:", err);
	process.exit(1);
});
