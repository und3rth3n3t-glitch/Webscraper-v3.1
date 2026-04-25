# SPEC — chart-bridge injection (v1.0)

> Stage F implementation spec for the staged plan at `~/.claude/plans/chart-bridge-injection.md`. Stages A–E confirmed; this is Stage F. Implementer should follow exactly; deviations need plan owner approval.

---

## Context

[src/entrypoints/chart-bridge.ts](../src/entrypoints/chart-bridge.ts) is the MAIN-world script that reads chart-library globals (`Highcharts.charts[]`, `Chart.getChart()`, `Plotly.data`, `ECharts`, `ApexCharts`) and answers `DETECT_CHART_LIBRARY` / `EXTRACT_CHART_DATA` postMessages from the content script. It is the privileged side of chart-data extraction.

**The bug.** The script is declared as `defineUnlistedScript`. WXT builds it but does not auto-inject it; nothing else in the codebase calls `chrome.scripting.executeScript` to inject it. Result: every postMessage from `extractFromChartLibrary` ([chartExtractor.ts:292-322](../src/content/extraction/chartExtractor.ts#L292-L322)) and `queryChartLibrary` ([chartExtractor.ts:223-237](../src/content/extraction/chartExtractor.ts#L223-L237)) goes nowhere — both time out (2-3 s) and resolve `null`. **Every chart on every page falls through to SVG-based extraction**, which is structurally weaker.

This spec converts the bridge from `defineUnlistedScript` to `defineContentScript` with `world: 'MAIN'`. WXT then auto-injects it per page, per frame, at `document_idle`, with no manual injection code.

---

## File 1 (RENAMED + REWRITTEN): `src/entrypoints/chart-bridge.ts` → `src/entrypoints/chart-bridge.content.ts`

**Important: WXT determines entrypoint type by filename pattern, not by which `defineXxx` function is called.** A bare `chart-bridge.ts` is treated as an unlisted script regardless of body content. Files matching `*.content.ts` (or `content.ts` exactly) are recognised as content scripts.

### Step 1 — rename the file

```bash
git mv src/entrypoints/chart-bridge.ts src/entrypoints/chart-bridge.content.ts
```

### Step 2 — replace the entire file content with:

```ts
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  world: 'MAIN',
  runAt: 'document_idle',

  main() {
    const w = window as Window & { __blueberryChartBridge?: boolean };
    if (w.__blueberryChartBridge) return;
    w.__blueberryChartBridge = true;

    window.addEventListener('message', function (event: MessageEvent) {
      if (event.source !== window) return;
      const msg = event.data as { type?: string; messageId?: string; elementIndex?: { marker?: string; id?: string; nthCanvas?: number } } | null;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'DETECT_CHART_LIBRARY') {
        handleDetectLibrary(msg.messageId!);
      } else if (msg.type === 'EXTRACT_CHART_DATA') {
        handleExtractChartData(msg.messageId!, msg.elementIndex ?? null);
      }
    });

    function handleDetectLibrary(messageId: string): void {
      const w = window as unknown as Record<string, unknown>;
      let library: string | null = null;
      if (w['Chart']) library = 'Chart.js';
      else if (w['Highcharts']) library = 'Highcharts';
      else if (w['echarts']) library = 'ECharts';
      else if (w['Plotly']) library = 'Plotly';
      else if (w['ApexCharts']) library = 'ApexCharts';
      else if (w['d3']) library = 'D3';
      window.postMessage({ type: 'CHART_LIBRARY_RESULT', messageId, library }, '*');
    }

    function resolveElementFromIndex(elementIndex: { marker?: string; id?: string; nthCanvas?: number } | null): Element | null {
      if (!elementIndex) return null;
      if (elementIndex.marker) return document.querySelector(`[${elementIndex.marker}]`);
      if (elementIndex.id) return document.getElementById(elementIndex.id);
      if (typeof elementIndex.nthCanvas === 'number' && elementIndex.nthCanvas >= 0) {
        const all = document.querySelectorAll('canvas, svg');
        return all[elementIndex.nthCanvas] || null;
      }
      return null;
    }

    function extractHighchartsAxisLabels(axis: Record<string, unknown> | null): unknown[] | null {
      if (!axis) return null;
      if (Array.isArray(axis.categories) && (axis.categories as unknown[]).length) return axis.categories as unknown[];
      if (Array.isArray(axis.names) && (axis.names as unknown[]).length) return axis.names as unknown[];
      if (axis.ticks && typeof axis.ticks === 'object') {
        const entries = Object.keys(axis.ticks as object)
          .filter((k) => k !== '-1')
          .sort((a, b) => Number(a) - Number(b));
        if (entries.length > 0) {
          const labels = entries
            .map((k) => ((axis.ticks as Record<string, Record<string, Record<string, string>>>)[k]?.label?.textStr))
            .filter((t) => t !== null && t !== undefined && t !== '');
          if (labels.length > 0) return labels;
        }
      }
      return null;
    }

    function handleExtractChartData(
      messageId: string,
      elementIndex: { marker?: string; id?: string; nthCanvas?: number } | null,
    ): void {
      const element = resolveElementFromIndex(elementIndex);
      if (!element) {
        window.postMessage({ type: 'CHART_DATA_RESULT', messageId, chartData: null }, '*');
        return;
      }

      const w = window as unknown as Record<string, unknown>;
      let chartData: unknown = null;

      // Chart.js
      try {
        if (w['Chart']) {
          const Chart = w['Chart'] as Record<string, unknown>;
          let instance: Record<string, unknown> | null = null;
          if (typeof Chart['getChart'] === 'function') {
            instance = (Chart['getChart'] as (el: Element) => Record<string, unknown>)(element);
          }
          if (!instance && Chart['instances']) {
            const instances = Object.values(Chart['instances'] as Record<string, unknown>);
            instance = (instances as Record<string, unknown>[]).find((c) => {
              const canvas = c['canvas'] as Element | undefined;
              return canvas === element || canvas === element.querySelector('canvas') || (canvas && element.contains(canvas));
            }) ?? null;
          }
          if (instance) {
            const data = instance['data'] as { labels: unknown; datasets: Array<{ label: unknown; data: unknown }> };
            chartData = {
              _library: 'Chart.js',
              labels: data.labels,
              datasets: data.datasets.map((ds) => ({ label: ds.label, data: ds.data })),
            };
          }
        }
      } catch { /* expected */ }

      // Highcharts
      if (!chartData) {
        try {
          if (w['Highcharts']) {
            const HC = w['Highcharts'] as { charts: Array<Record<string, unknown> | null> };
            const chart = HC.charts.find((c) => {
              if (!c) return false;
              const renderTo = c['renderTo'] as Element;
              return renderTo === element || renderTo?.contains(element) || element.contains(renderTo);
            });
            if (chart) {
              const title = chart['title'] as { textStr?: string } | undefined;
              const series = chart['series'] as Array<{
                name: string;
                data: Array<{ x?: unknown; category?: unknown; y: unknown; name?: string }>;
              }>;
              const xAxis = chart['xAxis'] as unknown[];
              const yAxis = chart['yAxis'] as unknown[];
              chartData = {
                _library: 'Highcharts',
                title: title?.textStr || null,
                series: series.map((s) => ({
                  name: s.name,
                  data: s.data.map((p) => ({ x: p.x ?? p.category, y: p.y, name: p.name || null })),
                })),
                xAxisCategories: extractHighchartsAxisLabels((xAxis?.[0] as Record<string, unknown>) ?? null),
                yAxisCategories: extractHighchartsAxisLabels((yAxis?.[0] as Record<string, unknown>) ?? null),
              };
            }
          }
        } catch { /* expected */ }
      }

      // ECharts
      if (!chartData) {
        try {
          if (w['echarts']) {
            const echarts = w['echarts'] as { getInstanceByDom?: (el: Element) => Record<string, unknown> | null };
            let instance: Record<string, unknown> | null = null;
            if (typeof echarts.getInstanceByDom === 'function') {
              instance = echarts.getInstanceByDom(element);
            }
            if (!instance) {
              let parent: Element | null = element.parentElement;
              while (parent && !instance) {
                instance = echarts.getInstanceByDom?.(parent) ?? null;
                parent = parent.parentElement;
              }
            }
            if (instance) {
              chartData = { _library: 'ECharts', ...(instance['getOption'] as () => Record<string, unknown>)() };
            }
          }
        } catch { /* expected */ }
      }

      // Plotly
      if (!chartData) {
        try {
          if (w['Plotly']) {
            const el = element as Element & { data?: unknown; layout?: { title?: unknown } };
            if (el.data && el.layout) {
              chartData = { _library: 'Plotly', data: el.data, layout: { title: el.layout?.title || null } };
            }
          }
        } catch { /* expected */ }
      }

      // ApexCharts
      if (!chartData) {
        try {
          if (w['ApexCharts']) {
            type ApexEl = Element & { __apexcharts__?: Record<string, unknown> };
            let instance = (element as ApexEl).__apexcharts__ ?? null;
            if (!instance) {
              let parent: ApexEl | null = element as ApexEl;
              while (parent && !instance) {
                if (parent.__apexcharts__) { instance = parent.__apexcharts__; break; }
                parent = parent.parentElement as ApexEl | null;
              }
            }
            const Apex = w['Apex'] as { _chartInstances?: Array<{ el: Element; w: Record<string, unknown> }> } | undefined;
            if (!instance && Apex?._chartInstances) {
              const found = Apex._chartInstances.find((c) => c.el && (c.el === element || c.el.contains(element) || element.contains(c.el)));
              if (found) instance = found as unknown as Record<string, unknown>;
            }
            if (instance) {
              const w2 = (instance as { w?: { config?: Record<string, unknown> } }).w?.config;
              chartData = {
                _library: 'ApexCharts',
                series: w2?.['series'] || null,
                labels: w2?.['labels'] || null,
                xAxisCategories: (w2?.['xaxis'] as Record<string, unknown> | undefined)?.['categories'] || null,
                yAxisCategories: (w2?.['yaxis'] as Record<string, unknown>[] | undefined)?.[0]?.['categories'] || null,
              };
            }
          }
        } catch { /* expected */ }
      }

      window.postMessage({ type: 'CHART_DATA_RESULT', messageId, chartData }, '*');
    }
  },
});
```

**Changes vs. current:**
- Outer wrapper: `defineUnlistedScript(() => { ... })` → `defineContentScript({ matches, allFrames, world, runAt, main() { ... } })`.
- Added `__blueberryChartBridge` flag at top of `main()` to guard against double-injection.
- All inner functions (`handleDetectLibrary`, `resolveElementFromIndex`, `extractHighchartsAxisLabels`, `handleExtractChartData`) are nested inside `main()` (declarative content scripts have a single `main` function entry).
- Functional behaviour identical — same protocol, same library handlers, same response shape.

---

## Verify nothing else broke

After the edit, run from the repo root:

```bash
grep -n "defineUnlistedScript" src/
```

Expected output: **zero matches**. The conversion is complete.

```bash
grep -n "__blueberryChartBridge" src/
```

Expected output: one match in `src/entrypoints/chart-bridge.ts`. Sanity check the guard is in place.

---

## Verification

### Automated

Run from the repo root:

```bash
npm run lint
npm run type-check
npm run build
npm run test
```

All must pass with zero new errors. The build will emit a new `content_scripts` entry into the generated `manifest.json` (visible in `.output/chrome-mv3/manifest.json`). This is expected.

### Manual

1. **Reload the extension.** Chrome → `chrome://extensions` → Reload Blueberry. Required because `content_scripts` manifest entries are read at install/reload, not hot-reloaded.

2. **Verify the bridge is loaded on a chart page.** Open the World Bank Climate Portugal page. In the page's DevTools console (top-frame context):
   ```
   window.__blueberryChartBridge
   ```
   Expected: `true`.

3. **Re-run the previously-failing flow.** Same Wikipedia → World Bank Portugal config. Expected output change for the Temperature chart:
   - `method: "js_library"` (was `"svg_structure"`)
   - `canExtract: true` (was `false`)
   - `series` populated with real numeric data points like `{ x, y, name }` triples per series
   - `_extractionNote: "Actual data values extracted from the Highcharts JavaScript API."` (was the SVG-structure copy)

4. **iframe-embedded chart.** Find a page with a chart in an iframe (any embed widget). Run a wholepage scrape; confirm the iframe's chart still extracts.

5. **No-charts page.** Open a plain blog post or doc. Confirm `window.__blueberryChartBridge === true` (bridge loads), no console errors.

6. **Chart-scan throughput.** Run "Scan for charts" on the Portugal page. Each chart's library detection should now complete in milliseconds. *(Broader scan-progress / abort improvements are tracked as Fix B.)*

### Edge cases (covered by design — no extra steps)

- *Strict-CSP page.* Declarative content scripts bypass CSP — bridge loads regardless.
- *Page collision on `__blueberryChartBridge` name.* Bridge no-ops; protocol times out the same way as today. Graceful degradation.
- *Multi-frame.* Each frame gets its own scoped guard and listener. No cross-talk.
- *SPA navigation.* Bridge stays alive for document lifetime; new charts visible.
- *Lazy chart init.* Bridge is reactive — query happens at extraction time, library globals checked then.

---

## Out of scope (do not add in v1)

- Firefox MV2 chart-bridge support (`world: 'MAIN'` not supported on Firefox MV2 content scripts).
- New chart-library handlers (D3, Vega, custom rendering).
- On-demand injection (only inject when chart present).
- Bridge protocol versioning / capability negotiation.
- SVG-fallback improvements (parseAxisLabel unit-stripping, dual-axis handling) — Fix C.
- Scan progress / abort UX — Fix B.

---

## Rollback

If a regression is found post-merge, revert with:

```bash
git revert <commit-sha>
```

The change is self-contained in one file. Reverting cleanly removes the content_scripts entry from the next build's manifest.json. No data migration was performed.
