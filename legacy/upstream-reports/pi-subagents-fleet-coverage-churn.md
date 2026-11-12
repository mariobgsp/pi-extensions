# pi-subagents: Fleet roster expansion makes the whole screen repaint ~2x/s (transcript jumps) while runs are live

Extension: `pi-subagents@0.70.1` (npm latest as of filing) · Pi `0.86.1` · Linux/tmux · terminal 120x36 · no project panes, no `PI_CLEAR_ON_SHRINK`

## Summary

With a subagent run live, pressing **Down** to expand the inline Fleet roster (the
`↓/← to inspect` line under the editor) makes the terminal repaint the **entire screen**
roughly twice per second; the transcript visibly jumps/flickers while the roster stays
expanded. The same session is quiet while the roster is collapsed.

Root cause: `SubagentFleetStatus.refresh()` publishes an **empty** inline-workflow
coverage map on every refresh tick whose render key changed, and `render()` then
republishes the real map. `setInlineWorkflowCoverage` drops the sibling async widget's
cached lines (and requests a render) on *both* transitions, so that widget re-renders
expanded and then collapsed again — two dock layout changes per tick. The render key
embeds `Math.round((now - startedAt) / 1000)`, so it changes about once per second on its
own while any run is live; pressing Down adds one more cycle immediately.

The height churn lands in Pi's main-screen scroll/shrink accounting, which escalates to a
whole-screen repaint (`fullRender`) instead of a partial diff. That escalation only
happens once the frame reaches the viewport edge — see the short-transcript control below —
but the coverage churn is what drives it every tick.

## Reproduction

```bash
tmux new-session -d -s glitch -x 120 -y 36
# record the raw TUI stream (keeps a tty AND a byte log)
tmux send-keys -t glitch "script -q -c 'pi' /tmp/glitch/pi.raw" Enter
# one async run that stays alive
tmux send-keys -t glitch "/run scout Run this bash command and then reply with done: sleep 300 --bg" Enter
# wait until the collapsed status line is visible, then expand the roster
tmux send-keys -t glitch Down
tmux capture-pane -p -t glitch
```

Frames are delimited by Pi's synchronized-output marker `ESC[?2026h`; "full repaint" =
frame begins with `ESC[1;1H` (no partial diff). Measured with `analyze.py <raw>`, which
splits at the first rendered `↑↓/jk select` roster header:

| build | phase | frames | full-screen repaints | avg frame |
| --- | --- | --- | --- | --- |
| 0.70.1 | collapsed, run live | 231 | 15 (6%) | 602 B |
| 0.70.1 | **expanded (after Down)** | **195** | **132 (68%)** | **3048 B** |
| patched | collapsed, run live | 244 | 13 (5%) | 611 B |
| patched | expanded (after Down) | 92 | **2 (2%)** | 355 B |

The unpatched expanded frames come in a strict two-frame cycle, i.e. two whole-screen
repaints per tick:

```text
4095, 4726, 4136, 4726, 21, 4136, 4726, 330, 4136, 4726, 21, 4136, 4726, ...
```

Replaying those frames through a small screen emulator shows the *same* dock at two
different vertical offsets: one frame keeps 7 extra transcript rows in the live region and
repaints 36 rows, the next one scrolls them away and paints 29. That alternating
scroll/high-water bookkeeping is the visible jump.

Patched (same rig, same screen fullness, roster held expanded for 23 s, parent idle) the
cycle is gone — the only full repaints are the two transition frames (`4269`, `4415`) and
every later tick is a ~200-500 B partial diff:

```text
4269, 4415, 21, 519, 21, 330, 210, 519, 21, 330, 210, 519, 21, 330, 210, ...
```

Control worth noting: the same unpatched build with a *short* transcript (frame below the
viewport edge) showed 1% full repaints while expanded — the churn is only amplified into
whole-screen repaints when the frame is at the edge, which is the common case for a session
with content and is exactly what expanding the roster triggers.

## Root cause chain

1. `src/tui/fleet-status.js` (0.70.1, `refresh()`):

   ```js
   const renderKey = this.getRenderKey();
   if (!this.active || renderKey !== this.lastRenderKey)
       this.clearWorkflowCoverage();      // publishes an EMPTY coverage map
   ...
   this.lastRenderKey = renderKey;
   this.tui?.requestRender();
   ```

2. `clearWorkflowCoverage()` → `setInlineWorkflowCoverage(ui, new Map())` → in
   `render.js`, the coverage Map changes → `asyncWidgetInvalidations.get(ui)?.()` →
   `cachedLines = undefined; tui.requestRender()` plus `resetWidgetLayoutSession()` on the
   next render.

3. The very next frame runs `SubagentFleetStatus.render()`, which recomputes and
   republishes the real coverage (guarded by `this.ui && this.widgetRegistered &&
   this.onWorkflowCoverageChange`) → the async widget invalidates again.

4. Net effect per tick: two invalidation + layout-session resets in the region above the
   editor. `renderKey` contains `Math.round((now - entry.startedAt) / 1000)`, so step 1
   fires unconditionally ~1/s while a run is live — no state change is required.

## Patch

```diff
--- a/src/tui/fleet-status.js
+++ b/src/tui/fleet-status.js
@@ -616,7 +616,14 @@
             return;
         }
         const renderKey = this.getRenderKey();
-        if (!this.active || renderKey !== this.lastRenderKey)
+        // While the roster is active, render() is the source of truth for coverage:
+        // it republishes on every frame, and the paths that stop publishing clear
+        // coverage themselves. Clearing here on every renderKey change - which
+        // advances about once per second while runs are live - made the sibling async
+        // widget drop its cached lines twice per tick (expanded, then collapsed
+        // again), so the dock changed height twice per tick and Pi's main-screen
+        // renderer escalated to whole-screen repaints.
+        if (!this.active)
             this.clearWorkflowCoverage();
         if (!this.widgetRegistered) {
             ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => {
```

Coverage stays truthful because every path that stops publishing clears it itself:
`render()` clears for `!hasInlineSurface() || widgetsSuspended || inspectorOpen ||
fleetInspectorOpen` and for `!this.active`; `clearWidget()` / `clearUiRegistration()` /
`dispose()` clear too. One path returns without clearing — `refresh()` returns early when
`getActiveUiContext()` is undefined (no UI attached, nothing to hide rows in) — which was
equally true before the patch.

A deeper (larger) fix would move coverage publication out of `render()` and into
`refresh()`. It currently lives in `render()` because the covered window depends on the
rendered width and the visible slice.

## Verification

1. Deterministic, against the real component (drive `refresh()` ticks with an active roster
   and a live workflow job with two children, advancing the clock 1 s per tick, recording
   every `onWorkflowCoverageChange` call, then render the roster once at width 200):

   | build | empty coverage publishes over 5 active ticks | coverage published by `render()` | deactivate clears | roster lines over width |
   | --- | --- | --- | --- | --- |
   | 0.70.1 (control) | **5/5** | 1 | yes | 0 |
   | patched | **0/5** | 1 | yes | 0 |

   The control's event stream is `[0, 0,0,0,0,0, 1, 0]` (empty map on every tick, then the
   render publish); the patched stream is `[0, 1, 0, 0]` (no tick publishes at all, the
   render publish still happens). That also shows the fix does not just disable the feature.

2. End-to-end, identical rig and keypress sequence, roster held expanded 23 s with the
   parent idle and a live child: 68% → 2% full-screen repaints, with the alternating
   two-frame cycle replaced by small partial diffs (see the reproduction table above).

Limits of this evidence: the measurement is Linux/tmux at 120x36 on Pi 0.86.1, one async
workflow run at a time; the host-side escalation path itself was not instrumented, only
observed through the emitted frames.

## Host-side amplifier (separate issue, not fixed by this patch)

The escalation to a whole-screen repaint lives in Pi/`@earendil-works/pi-tui`'s main-screen
renderer (scroll/shrink accounting and the `firstChanged < previousViewportTop` full-render
escalation). With `clearOnShrink` enabled that path also emits `ESC[2J ESC[H ESC[3J`, which
would wipe scrollback. A package cannot fix that, and any extension widget whose rendered
height changes while the session sits at the bottom will hit the same behavior. Worth a
host-side fix or a documented contract: a below-editor widget that changes height forces a
full-screen repaint per change, so extensions should keep its line count stable.
