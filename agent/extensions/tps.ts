/**
 * Live tokens/sec + TTFT in the status bar.
 *
 * Final number: provider-reported output tokens / decode time (first→last delta),
 * summed across the tool calls of one run so tool gaps don't deflate it.
 * Live number: char estimate (~4 chars/token) over a 1.5s window, since most
 * providers report usage only at completion.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const CHARS_PER_TOKEN = 4;
const WINDOW_MS = 1500;
const RENDER_MS = 200;

export function liveRate(samples: { t: number; c: number }[], now: number): string | null {
	const recent = samples.filter((s) => now - s.t <= WINDOW_MS);
	if (recent.length < 2) return null;
	const span = now - recent[0].t;
	if (span < 300) return null;
	const tps = recent.reduce((n, s) => n + s.c, 0) / CHARS_PER_TOKEN / (span / 1000);
	return tps >= 10 ? String(Math.round(tps)) : tps.toFixed(1);
}

export default function (pi: ExtensionAPI) {
	let samples: { t: number; c: number }[] = [];
	let reqStart = 0;
	let firstTokenAt = 0;
	let lastDeltaAt = 0;
	let ttft = 0;
	let outTokens = 0;
	let decodeMs = 0;
	let renderedAt = 0;

	const render = (ctx: ExtensionContext, text: string | undefined) => {
		if (ctx.mode === "tui") ctx.ui.setStatus("tps", text);
	};

	pi.on("agent_start", (_event, ctx) => {
		samples = [];
		ttft = outTokens = decodeMs = 0;
		render(ctx, "…");
	});

	pi.on("message_start", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		samples = [];
		firstTokenAt = lastDeltaAt = 0;
		reqStart = Date.now();
	});

	pi.on("message_update", (event, ctx) => {
		const ev = event.assistantMessageEvent;
		// Any delta is real output (text, thinking, or tool-call JSON); tool-only
		// messages must contribute decode time or the aggregate rate inflates.
		if (ev.type !== "text_delta" && ev.type !== "thinking_delta" && ev.type !== "toolcall_delta") return;
		const now = Date.now();
		if (!firstTokenAt) firstTokenAt = now;
		lastDeltaAt = now;
		samples.push({ t: now, c: ev.delta.length });
		if (now - renderedAt < RENDER_MS) return;
		renderedAt = now;
		const rate = liveRate(samples, now);
		if (rate) render(ctx, `${rate} t/s`);
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant" || msg.stopReason === "pending") return;
		outTokens += msg.usage.output || 0;
		if (lastDeltaAt > firstTokenAt) decodeMs += lastDeltaAt - firstTokenAt;
		if (firstTokenAt) ttft = firstTokenAt - reqStart;
		if (decodeMs <= 0) return;
		const tps = outTokens / (decodeMs / 1000);
			render(
			ctx,
			`${tps >= 10 ? Math.round(tps) : tps.toFixed(1)} t/s · ${outTokens} tok · ttft ${(ttft / 1000).toFixed(2)}s`,
		);
	});
}
