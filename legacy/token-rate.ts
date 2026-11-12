/**
 * token-rate — live tokens/s meter for the current model response.
 *
 * Adds a status line to the footer (below pi's built-in token stats) that
 * updates while a response streams:
 *
 *   ▍ ~41.3 tok/s · 812 tok                 (mid-stream, "~" = estimated)
 *   ✓ 1.2k tok · 41.3 tok/s · ttft 1.2s     (final, real provider usage)
 *
 * - "how much": output tokens of the current response (provider-reported,
 *   includes reasoning/thinking tokens)
 * - "how fast": output tokens ÷ time since the first token
 * - ttft: time-to-first-token from the turn start
 *
 * Providers that only report usage at stream end fall back to a
 * 4 chars/token estimate while streaming (shown with a "~" prefix).
 * Session totals (↑input ↓output) are already shown by the built-in footer.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "tok-rate";
const CHARS_PER_TOKEN = 4; // fallback estimate only
const MIN_UI_INTERVAL_MS = 100; // max status update rate while streaming

export default function (pi: ExtensionAPI) {
	// Per-response streaming state.
	let active = false;
	let turnStartAt = 0;
	let firstTokAt = 0;
	let usageOut = 0; // last cumulative provider output usage
	let estTokens = 0; // char-estimate accumulator (fractional)
	let usageSeen = false;
	let lastUiAt = 0;
	let lastEstimateOnly = false;

	const reset = () => {
		active = true;
		firstTokAt = 0;
		usageOut = 0;
		estTokens = 0;
		usageSeen = false;
		lastEstimateOnly = false;
	};

	const fmtTok = (n: number) =>
		n >= 1_000_000
			? `${(n / 1_000_000).toFixed(2)}M`
			: n >= 10_000
				? `${Math.round(n / 1000)}k`
				: n >= 1000
					? `${(n / 1000).toFixed(1)}k`
					: `${Math.round(n)}`;

	const fmtRate = (r: number) => (r >= 100 ? `${Math.round(r)}` : r.toFixed(1));
	const fmtDur = (ms: number) =>
		ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.max(0, Math.round(ms))}ms`;

	/** Best-known token count for the current response. */
	const tokens = () => (usageSeen ? Math.max(usageOut, Math.floor(estTokens)) : Math.floor(estTokens));

	function pushStatus(ctx: ExtensionContext, text: string, force = false) {
		if (!ctx.hasUI) return;
		const now = Date.now();
		if (!force && now - lastUiAt < MIN_UI_INTERVAL_MS) return;
		lastUiAt = now;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function showLive(ctx: ExtensionContext) {
		if (!active) return;
		const t = ctx.ui.theme;
		const tok = tokens();
		const el = firstTokAt ? Date.now() - firstTokAt : 0;
		const rate = el > 500 ? (tok * 1000) / el : undefined; // wait ≥0.5s to avoid startup spikes
		if (rate === undefined) {
			if (firstTokAt) pushStatus(ctx, t.fg("dim", "▍") + t.fg("text", ` ${fmtTok(tok)} tok`));
			return;
		}
		const est = usageSeen ? "" : "~";
		const live =
			t.fg("dim", "▍") +
			t.fg("accent", `${est}${fmtRate(rate)} tok/s`) +
			t.fg("dim", ` · ${fmtTok(tok)} tok`);
		pushStatus(ctx, live);
	}

	function showFinal(ctx: ExtensionContext, usageOutput: number | undefined, now: number) {
		if (!active) return;
		if (usageOutput !== undefined && usageOutput > usageOut) {
			usageOut = usageOutput;
			usageSeen = true;
		}
		active = false;
		const t = ctx.ui.theme;
		const tok = tokens();
		const gen = now - firstTokAt;
		const rate = gen > 0 ? (tok * 1000) / gen : 0;
		let text = t.fg("success", "✓") + t.fg("text", ` ${fmtTok(tok)} tok`) + t.fg("accent", ` @ ${fmtRate(rate)} tok/s`);
		if (turnStartAt && firstTokAt > turnStartAt) {
			text += t.fg("dim", ` · ttft ${fmtDur(firstTokAt - turnStartAt)}`);
		}
		pushStatus(ctx, text, true);
	}

	pi.on("turn_start", async (event, ctx) => {
		turnStartAt = event.timestamp;
		if (active) showLive(ctx);
	});

	pi.on("message_start", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		reset();
		// Seed with usage already reported at stream start (e.g. input tokens present).
		const u = (event.message as { usage?: { output?: number } }).usage;
		if (u && typeof u.output === "number" && u.output > 0) {
			usageOut = u.output;
			usageSeen = true;
		}
	});

	pi.on("message_update", async (event, ctx) => {
		if (!active || event.message.role !== "assistant") return;
		const now = Date.now();
		const msg = event.message as { usage?: { output?: number } };
		const usageNow = msg.usage && typeof msg.usage.output === "number" ? msg.usage.output : undefined;
		const u = usageNow !== undefined && usageNow > usageOut ? usageNow : undefined;

		if (u !== undefined) {
			usageOut = u;
			usageSeen = true;
			lastEstimateOnly = false;
			if (firstTokAt === 0) firstTokAt = now;
			showLive(ctx);
			return;
		}

		const ev = event.assistantMessageEvent;
		const delta =
			ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta"
				? ev.delta.length / CHARS_PER_TOKEN
				: 0;
		if (delta > 0) {
			if (firstTokAt === 0) firstTokAt = now;
			estTokens += delta;
			lastEstimateOnly = !usageSeen;
			showLive(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!active || event.message.role !== "assistant") return;
		const u = (event.message as { usage?: { output?: number } }).usage;
		showFinal(ctx, u?.output, Date.now());
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// If a stream never finished cleanly, clear the stale live readout.
		if (active) active = false;
	});
}
