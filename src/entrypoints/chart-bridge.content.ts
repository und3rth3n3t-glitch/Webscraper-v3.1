export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  world: 'MAIN',
  runAt: 'document_idle',

  main() {
    const w = window as Window & { __blueberryChartBridge?: boolean };
    if (w.__blueberryChartBridge) return;
    w.__blueberryChartBridge = true;

    // Flip to true to re-enable verbose diagnostic logging for the chart-bridge.
    // Logs: per-frame library presence, per-extract Highcharts match counts.
    const DEBUG = false;

    if (DEBUG) {
      // Per-frame: which chart libraries are present?
      setTimeout(() => {
        const wAny = window as unknown as Record<string, unknown>;
        const hc = wAny['Highcharts'] as { charts?: unknown[] } | undefined;
        console.log('[Blueberry chart-bridge] alive in frame:', window.location.href.substring(0, 100));
        console.log('[Blueberry chart-bridge] libraries detected:', {
          Highcharts: typeof hc,
          HighchartsChartCount: hc?.charts?.length ?? 'n/a',
          ChartJs: typeof wAny['Chart'],
          ECharts: typeof wAny['echarts'],
          Plotly: typeof wAny['Plotly'],
          ApexCharts: typeof wAny['ApexCharts'],
        });
      }, 1500);
    }

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
            const matches = (c: Record<string, unknown> | null): boolean => {
              if (!c) return false;
              const candidates = [c['renderTo'], c['container']] as Array<Element | undefined>;
              for (const cand of candidates) {
                if (!cand) continue;
                if (cand === element) return true;
                if (cand.contains(element)) return true;
                if (element.contains(cand)) return true;
              }
              return false;
            };
            const chart = HC.charts.find(matches);

            if (DEBUG) {
              const matchCount = HC.charts.filter(matches).length;
              console.log('[Blueberry chart-bridge] Highcharts extract: total=', HC.charts.filter(Boolean).length, 'matched=', matchCount, 'element=', (element as HTMLElement).tagName, (element as HTMLElement).className);
            }

            if (chart) {
              const title = chart['title'] as { textStr?: string } | undefined;
              const series = chart['series'] as Array<{
                name: string;
                xAxis?: unknown;
                yAxis?: unknown;
                data: Array<{ x?: unknown; category?: unknown; y: unknown; name?: string }>;
              }>;
              const xAxis = chart['xAxis'] as unknown[] | undefined;
              const yAxis = chart['yAxis'] as unknown[] | undefined;

              const buildAxisInfo = (axes: unknown[] | undefined) =>
                (axes ?? []).map((ax, i) => {
                  const axObj = ax as Record<string, unknown>;
                  const opts = axObj['options'] as Record<string, unknown> | undefined;
                  const titleOpt = opts?.['title'] as Record<string, unknown> | undefined;
                  return {
                    index: i,
                    title: (titleOpt?.['text'] as string | null) ?? null,
                    categories: extractHighchartsAxisLabels(axObj),
                  };
                });

              chartData = {
                _library: 'Highcharts',
                title: title?.textStr || null,
                series: series.map((s) => {
                  const yIdx = yAxis ? yAxis.indexOf(s.yAxis) : -1;
                  const xIdx = xAxis ? xAxis.indexOf(s.xAxis) : -1;
                  return {
                    name: s.name,
                    xAxisIndex: xIdx >= 0 ? xIdx : null,
                    yAxisIndex: yIdx >= 0 ? yIdx : null,
                    data: s.data.map((p) => ({ x: p.x ?? p.category, y: p.y, name: p.name || null })),
                  };
                }),
                // First-axis convenience fields — kept for back-compat.
                xAxisCategories: extractHighchartsAxisLabels((xAxis?.[0] as Record<string, unknown>) ?? null),
                yAxisCategories: extractHighchartsAxisLabels((yAxis?.[0] as Record<string, unknown>) ?? null),
                // Full axis info — preferred for multi-axis charts.
                xAxes: buildAxisInfo(xAxis),
                yAxes: buildAxisInfo(yAxis),
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
