/**
 * Vision handoff — multi-model image reading.
 *
 * Main model often can't see images (text-only). This extension gives it two tools:
 *   - describe_image: read a local image file via a vision-capable model, return
 *     "what it is + details" as text so the main model never needs vision.
 *   - ask_model: generic text handoff to another model (provider/id).
 *
 * Model pick for describe_image:
 *   1. params.model ("provider/id") if given
 *   2. your default: /vision-model (saved across sessions), --vision-model flag, or $VISION_MODEL
 *   3. current session model if it supports image input + has auth
 *   4. first available image-capable model with auth (same provider first)
 *
 * Usage: copy to ~/.pi/agent/extensions/vision-handoff.ts, then /reload.
 * The image stays OUT of the main conversation — only the description returns.
 */

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_BYTES = 10 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

function mimeFor(path: string): string | undefined {
	const dot = path.toLowerCase().lastIndexOf(".");
	return dot >= 0 ? MIME_BY_EXT[path.toLowerCase().slice(dot)] : undefined;
}

function supportsImage(m: unknown): boolean {
	const input = (m as { input?: string[] } | null)?.input;
	return Array.isArray(input) && input.includes("image");
}

function idOf(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

type VisionModel = { provider: string; id: string; input?: string[] };

// User-set default from /vision-model (session-persisted). Flag/env beat it per-run.
let preferredVisionModel: string | undefined;

function configuredVisionModel(pi: ExtensionAPI): string | undefined {
	const flag = pi.getFlag("vision-model") as string | undefined;
	return preferredVisionModel ?? flag ?? process.env.VISION_MODEL ?? undefined;
}

// Global default shared by all sessions: <agentDir>/vision-model.json.
function globalDefaultPath(): string {
	return join(getAgentDir(), "vision-model.json");
}

function loadGlobalDefault(): string | undefined {
	try {
		const raw = readFileSync(globalDefaultPath(), "utf8");
		const model = (JSON.parse(raw) as { model?: unknown } | null)?.model;
		return typeof model === "string" && model.includes("/") ? model : undefined;
	} catch {
		return undefined;
	}
}

function saveGlobalDefault(id: string | null): void {
	try {
		if (id === null) unlinkSync(globalDefaultPath());
		else
			writeFileSync(globalDefaultPath(), JSON.stringify({ model: id }), "utf8");
	} catch {
		// ponytail: global default is best-effort; the session entry still applies this session.
	}
}

async function pickVisionModel(
	ctx: ExtensionContext,
	explicit?: string,
): Promise<{ model: VisionModel; via: string } | { error: string }> {
	// SAFETY: narrowing ExtensionContext registry to the subset this file uses (find/getAvailable/hasConfiguredAuth).
	const reg = ctx.modelRegistry as unknown as {
		find(p: string, id: string): VisionModel | undefined;
		getAvailable(): VisionModel[] | Promise<VisionModel[]>;
		hasConfiguredAuth(m: VisionModel): boolean;
	};

	// 1. Explicit "provider/id".
	if (explicit) {
		const slash = explicit.indexOf("/");
		if (slash < 0)
			return { error: `Bad model "${explicit}". Use "provider/id".` };
		const found = reg.find(explicit.slice(0, slash), explicit.slice(slash + 1));
		if (!found)
			return { error: `Model "${explicit}" not found. Pick one from /model.` };
		if (!supportsImage(found))
			return { error: `Model "${explicit}" has no image input.` };
		if (!reg.hasConfiguredAuth(found))
			return { error: `No auth for "${explicit}". Run /login first.` };
		return { model: found, via: "explicit" };
	}

	// 2. Current model if it can see.
	// SAFETY: ctx.model always matches VisionModel shape (provider/id/input) when present.
	const current = ctx.model as unknown as VisionModel | undefined;
	if (current && supportsImage(current) && reg.hasConfiguredAuth(current)) {
		return { model: current, via: "current" };
	}

	// 3. First vision model with auth, same provider preferred.
	const all = await reg.getAvailable();
	const vision = all
		.filter(supportsImage)
		.filter((m) => reg.hasConfiguredAuth(m));
	if (vision.length === 0) {
		return {
			error:
				"No vision-capable model with auth. Run /login for a provider with image input.",
		};
	}
	const sameProvider = current
		? vision.find((m) => m.provider === current.provider)
		: undefined;
	return {
		model: sameProvider ?? vision[0],
		via: sameProvider ? "same-provider" : "fallback",
	};
}

const DESCRIBE_SYSTEM =
	"You describe images precisely. Answer: 1) what it is in one line, 2) details an engineer needs " +
	"(text, layout, colors, objects, counts, state, anomalies). Be factual; mark guesses as guesses.";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("vision-model", {
		description: 'Preferred vision model as "provider/id" (overrides auto-pick)',
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		preferredVisionModel = loadGlobalDefault();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "vision-model") {
				const m = (entry.data as { model?: string | null } | undefined)?.model;
				preferredVisionModel = m ?? undefined;
			}
		}
	});

	pi.registerCommand("vision-model", {
		description:
			"Show, pick, or set preferred vision model: /vision-model [provider/id | search | pick | clear]",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const setVision = (id: string) => {
				preferredVisionModel = id;
				pi.appendEntry("vision-model", { model: id });
				saveGlobalDefault(id);
				ctx.ui.notify(`Vision model → ${id} (saved as default)`, "info");
			};
			if (/^(clear|auto|none)$/i.test(arg)) {
				preferredVisionModel = undefined;
				pi.appendEntry("vision-model", { model: null });
				saveGlobalDefault(null);
				ctx.ui.notify("Vision model reset to auto-pick (default cleared)", "info");
				return;
			}
			if (arg.includes("/")) {
				setVision(arg);
				return;
			}
			// SAFETY: narrowing registry to the getAvailable/hasConfiguredAuth subset used below.
			const reg = ctx.modelRegistry as unknown as {
				getAvailable(): VisionModel[] | Promise<VisionModel[]>;
				hasConfiguredAuth(m: VisionModel): boolean;
			};
			const all = await reg.getAvailable();
			const vision = all
				.filter(supportsImage)
				.filter((m) => reg.hasConfiguredAuth(m));
			if (vision.length === 0) {
				ctx.ui.notify(
					"No vision-capable model with auth. Run /login first.",
					"error",
				);
				return;
			}
			const current = configuredVisionModel(pi);
			let query = /^(pick|choose|select|list)$/i.test(arg) ? "" : arg;
			if (!query && ctx.hasUI) {
				const typed = await ctx.ui.input("Search vision models (blank = all):", "");
				if (typed === undefined) {
					ctx.ui.notify(
						`Vision model unchanged: ${current ?? "(auto-pick)"}`,
						"info",
					);
					return;
				}
				query = typed.trim();
			}
			const q = query.toLowerCase();
			const matches = q
				? vision.filter((m) => idOf(m).toLowerCase().includes(q))
				: vision;
			if (matches.length === 0) {
				ctx.ui.notify(`No vision models match "${query}".`, "error");
				return;
			}
			if (matches.length === 1) {
				setVision(idOf(matches[0]));
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Vision models: ${matches.map(idOf).join(", ")}`, "info");
				return;
			}
			const choice = await ctx.ui.select(
				`Vision model (current: ${current ?? "auto-pick"}):`,
				matches.map((m) => idOf(m)),
			);
			if (!choice) {
				ctx.ui.notify(
					`Vision model unchanged: ${current ?? "(auto-pick)"}`,
					"info",
				);
				return;
			}
			setVision(choice);
		},
	});
	pi.registerTool({
		name: "describe_image",
		label: "Describe Image",
		description:
			"Read a local image via a vision-capable model and return what it is plus details as text. " +
			"Use describe_image whenever the user points at an image, screenshot, photo, or diagram — " +
			"pass the file path, never paste base64 yourself.",
		promptGuidelines: [
			"Use describe_image when the user asks about an image file — it hands the image to a vision-capable model and returns text.",
		],
		parameters: Type.Object({
			path: Type.String({
				description:
					"Image path (relative to cwd or absolute). Strips a leading @.",
			}),
			prompt: Type.Optional(
				Type.String({
					description: "What to focus on. Default: what it is + full detail.",
				}),
			),
			model: Type.Optional(
				Type.String({
					description:
						'Vision model as "provider/id". Default: /vision-model, --vision-model, or $VISION_MODEL.',
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const clean = params.path.startsWith("@")
				? params.path.slice(1)
				: params.path;
			const abs = resolve(ctx.cwd, clean);
			const mime = mimeFor(abs);
			if (!mime) {
				return {
					content: [
						{
							type: "text",
							text: `Unsupported image type: ${clean}. Use jpg, png, gif, or webp.`,
						},
					],
					isError: true,
				};
			}
			try {
				const size = (await stat(abs)).size;
				if (size > MAX_BYTES) {
					return {
						content: [
							{
								type: "text",
								text: `Image too large (${(size / 1048576).toFixed(1)}MB, max 10MB): ${clean}`,
							},
						],
						isError: true,
					};
				}
			} catch {
				return {
					content: [{ type: "text", text: `Image not found: ${clean}` }],
					isError: true,
				};
			}

			const fallback = configuredVisionModel(pi);
			const picked = await pickVisionModel(ctx, params.model ?? fallback);
			if ("error" in picked) {
				return { content: [{ type: "text", text: picked.error }], isError: true };
			}

			const data = (await readFile(abs)).toString("base64");
			const question =
				params.prompt?.trim() ||
				"What is in this image? Describe it and list all relevant details.";
			try {
				const res = (await ctx.modelRegistry.complete(
					picked.model as never,
					{
						systemPrompt: DESCRIBE_SYSTEM,
						messages: [
							{
								role: "user",
								content: [
									{ type: "text", text: question },
									{ type: "image", source: { type: "base64", mediaType: mime, data } },
								],
								timestamp: Date.now(),
							} as never,
						],
					} as never,
					{
						signal,
						maxTokens: 2000,
						cacheRetention: "none",
						sessionId: uuidv7(),
					} as never,
				)) as { content: Array<{ type: string; text?: string }>; usage?: unknown };
				const text = res.content
					.filter((c) => c.type === "text" && c.text)
					.map((c) => c.text as string)
					.join("\n")
					.trim();
				if (!text)
					return {
						content: [{ type: "text", text: "Vision model returned no text." }],
						isError: true,
					};
				return {
					content: [{ type: "text", text }],
					details: {
						model: idOf(picked.model),
						via:
							picked.via === "explicit" && !params.model ? "preferred" : picked.via,
						path: clean,
						usage: res.usage,
					},
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Vision call failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "ask_model",
		label: "Ask Model",
		description:
			"Ask another model a text question (multi-model handoff). Returns its answer as text.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Question/task for the other model." }),
			model: Type.Optional(
				Type.String({
					description: 'Model as "provider/id". Default: current model.',
				}),
			),
			systemPrompt: Type.Optional(
				Type.String({ description: "System prompt for the other model." }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// SAFETY: narrowing registry to find/hasConfiguredAuth subset used below.
			const reg = ctx.modelRegistry as unknown as {
				find(p: string, id: string): VisionModel | undefined;
				hasConfiguredAuth(m: VisionModel): boolean;
			};
			// SAFETY: ctx.model matches VisionModel shape (provider/id) when present.
			let model = ctx.model as unknown as VisionModel | undefined;
			if (params.model) {
				const slash = params.model.indexOf("/");
				if (slash < 0)
					return {
						content: [
							{
								type: "text",
								text: `Bad model "${params.model}". Use "provider/id".`,
							},
						],
						isError: true,
					};
				const found = reg.find(
					params.model.slice(0, slash),
					params.model.slice(slash + 1),
				);
				if (!found)
					return {
						content: [{ type: "text", text: `Model "${params.model}" not found.` }],
						isError: true,
					};
				if (!reg.hasConfiguredAuth(found)) {
					return {
						content: [
							{
								type: "text",
								text: `No auth for "${params.model}". Run /login first.`,
							},
						],
						isError: true,
					};
				}
				model = found;
			}
			if (!model)
				return {
					content: [{ type: "text", text: "No model selected." }],
					isError: true,
				};
			try {
				const res = (await ctx.modelRegistry.complete(
					model as never,
					{
						systemPrompt: params.systemPrompt,
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: params.prompt }],
								timestamp: Date.now(),
							} as never,
						],
					} as never,
					{
						signal,
						maxTokens: 2000,
						cacheRetention: "none",
						sessionId: uuidv7(),
					} as never,
				)) as { content: Array<{ type: string; text?: string }>; usage?: unknown };
				const text = res.content
					.filter((c) => c.type === "text" && c.text)
					.map((c) => c.text as string)
					.join("\n")
					.trim();
				return {
					content: [{ type: "text", text: text || "(no output)" }],
					details: { model: idOf(model), usage: res.usage },
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Model call failed: ${e instanceof Error ? e.message : String(e)}`,
						},
					],
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("describe-image", {
		description:
			"Describe an image via a vision model: /describe-image <path> [focus]",
		handler: (args, ctx) => {
			const [path, ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (!path) {
				ctx.ui.notify("Usage: /describe-image <path> [what to focus on]", "error");
				return;
			}
			pi.sendUserMessage(
				`Use describe_image on "${path}"${rest.length ? ` focusing on: ${rest.join(" ")}` : ""}.`,
			);
		},
	});
}
