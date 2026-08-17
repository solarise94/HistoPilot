/** Repository-boundary regression tests for the independently shipped UI bundle. */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const uiDir = resolve(here, "../integrations/pathtogether/ui");

function bundleText(): string {
	return readdirSync(uiDir)
		.filter((name) => name.endsWith(".js"))
		.sort()
		.map((name) => readFileSync(resolve(uiDir, name), "utf8"))
		.join("\n");
}

function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.map((line) => (/^\s*\/\//.test(line) ? "" : line))
		.join("\n");
}

describe("PathTogether UI bundle boundary", () => {
	it("does not reach into PathTogether private viewer state or DOM", () => {
		const code = stripComments(bundleText());
		const forbidden = [
			"OpenSeadragon",
			"window.viewer",
			"viewer.viewport",
			"state.slide",
			"state.roi",
			"editItem",
			"annoPanelList",
			'getElementById("anno',
			"getElementById('anno",
			"redrawAnnoCanvas",
		];
		expect(forbidden.filter((value) => code.includes(value))).toEqual([]);
	});

	it("uses HostBridge for platform capabilities", () => {
		const text = bundleText();
		expect(text).toContain("viewer.highlight");
		expect(text).toContain("HostBridgeHost");
		expect(text).toContain("slide.opened");
		expect(text).toContain("selection.getBbox");
	});

	it("exposes only the HistoPilot product namespace", () => {
		const text = bundleText();
		expect(text).toContain("window.HistoPilot");
		expect(text).not.toMatch(/window\.(?:viewer|state|annoPanelList)\b/);
	});
});
