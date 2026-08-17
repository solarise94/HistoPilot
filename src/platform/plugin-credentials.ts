/**
 * Plugin installation credential resolution (Stage 4-1b).
 *
 * HistoPilot needs `{installation_id, secret}` to build a
 * {@link PathTogetherHttpClient}. These come from either the environment or the
 * secret file that the Flask platform bootstraps:
 *
 *   - env `PLUGIN_INSTALLATION_ID` + `PLUGIN_HISTOPILOT_SECRET` (operator-managed);
 *   - file `HISTOPILOT_CONFIG_DIR/plugin-secret-histopilot.json`.
 *
 * This module never logs the resolved secret.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** HistoPilot-owned configuration directory. */
export function defaultPluginDataDir(): string {
	return process.env.HISTOPILOT_CONFIG_DIR || join(homedir(), ".histopilot");
}

/** The default plugin secret file path for the histopilot installation. */
export function defaultPluginSecretFile(): string {
	return join(defaultPluginDataDir(), "plugin-secret-histopilot.json");
}

export interface PluginCredentials {
	installationId: string;
	secret: string;
}

export interface ResolvePluginCredentialsOptions {
	/** Override env (tests). Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Absolute path to the plugin secret file. Defaults to the platform file. */
	secretFile?: string;
}

/**
 * Resolve the plugin credentials, or return `null` when absent/incomplete. The
 * caller decides whether to fail closed or explicitly enable the legacy adapter.
 */
export async function resolvePluginCredentials(
	opts: ResolvePluginCredentialsOptions = {},
): Promise<PluginCredentials | null> {
	const env = opts.env ?? process.env;
	let installationId = env.PLUGIN_INSTALLATION_ID?.trim() || "";
	let secret = env.PLUGIN_HISTOPILOT_SECRET?.trim() || "";

	const filePath = opts.secretFile || defaultPluginSecretFile();
	try {
		const raw = (await fs.readFile(filePath, "utf8")).trim();
		if (raw) {
			try {
				const parsed = JSON.parse(raw) as { installation_id?: unknown; secret?: unknown };
				if (!installationId && typeof parsed.installation_id === "string") {
					installationId = parsed.installation_id.trim();
				}
				if (!secret && typeof parsed.secret === "string") {
					secret = parsed.secret.trim();
				}
			} catch {
				// Legacy plain-secret file: whole content is the secret.
				if (!secret) secret = raw;
			}
		}
	} catch {
		// File missing/unreadable → rely on env only.
	}

	if (installationId && secret) {
		return { installationId, secret };
	}
	return null;
}
