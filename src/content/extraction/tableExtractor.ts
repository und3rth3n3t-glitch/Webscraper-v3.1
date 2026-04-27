export function extractTable(element: Element | null): Record<string, unknown>[] {
  if (!element) return [];

  const tag = element.tagName;

  if (tag === 'TABLE') return extractHtmlTable(element as HTMLTableElement);

  const table = element.querySelector('table');
  if (table) return extractHtmlTable(table);

  const style = window.getComputedStyle(element as HTMLElement);
  if (style.display === 'grid' || style.display === 'inline-grid') return extractDivGrid(element as HTMLElement);
  if (style.display === 'flex' || style.display === 'inline-flex') return extractDivGrid(element as HTMLElement);

  if (
    typeof (element as Element).getAttribute === 'function' &&
    (element.getAttribute('role') === 'table' || element.getAttribute('role') === 'grid')
  ) {
    return extractAriaTable(element);
  }

  if (element.querySelector('.MuiDataGrid-virtualScroller, .MuiDataGrid-main')) {
    return extractAriaTable(element);
  }
  if (element.classList?.contains('tabulator') || element.querySelector('.tabulator-table')) {
    return extractDivRowGrid(element, '.tabulator-row', '.tabulator-cell');
  }
  if (element.querySelector('.slick-viewport')) {
    return extractDivRowGrid(element, '.slick-row', '.slick-cell');
  }
  if (element.classList?.contains('x-grid') || element.querySelector('.x-grid-item')) {
    return extractDivRowGrid(element, '.x-grid-row', '.x-grid-cell');
  }

  return [];
}

export function extractTableHeadersWithPaths(table: Element): { flatKey: string; path: string[] }[] {
  const thead = table.querySelector('thead');
  const headerRows = thead ? Array.from(thead.querySelectorAll('tr')) : detectHeaderRows(table);
  if (headerRows.length === 0) return [];
  const totalCols = getTableColumnCount(table);
  if (totalCols === 0) return [];
  const matrix = buildHeaderMatrix(headerRows, totalCols);
  const result: { flatKey: string; path: string[] }[] = [];
  for (let col = 0; col < totalCols; col++) {
    const parts = matrix
      .map((row) => row[col] || '')
      .filter(Boolean)
      .filter((v, i, a) => v !== a[i - 1]);
    const path = parts.length > 0 ? parts : [`Column ${col + 1}`];
    const flatKey = parts.length > 0 ? parts.join('.') : `Column ${col + 1}`;
    result.push({ flatKey, path });
  }
  return result;
}

export function extractTableHeaders(table: Element): string[] {
  return extractTableHeadersWithPaths(table).map((h) => h.flatKey);
}

function buildHeaderMatrix(headerRows: Element[], totalCols: number): string[][] {
  const matrix: string[][] = [];
  const occupied: Record<string, { text: string; remaining: number }> = {};

  for (let rowIdx = 0; rowIdx < headerRows.length; rowIdx++) {
    const row = Array<string>(totalCols).fill('');
    const cells = Array.from(headerRows[rowIdx].querySelectorAll('th, td'));
    let colCursor = 0;
    const rowspanCols = new Set<number>();

    for (let c = 0; c < totalCols; c++) {
      const key = `${rowIdx},${c}`;
      if (occupied[key]) {
        row[c] = occupied[key].text;
        rowspanCols.add(c);
        const remaining = occupied[key].remaining - 1;
        if (remaining > 0) occupied[`${rowIdx + 1},${c}`] = { text: occupied[key].text, remaining };
        delete occupied[key];
      }
    }

    for (const cell of cells) {
      while (colCursor < totalCols && rowspanCols.has(colCursor)) colCursor++;
      if (colCursor >= totalCols) break;

      const text = (cell instanceof HTMLElement ? cell.innerText : cell.textContent || '').trim();
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);

      for (let cs = 0; cs < colspan; cs++) {
        const c = colCursor + cs;
        if (c < totalCols) {
          row[c] = text;
          if (rowspan > 1) {
            for (let rs = 1; rs < rowspan; rs++) {
              occupied[`${rowIdx + rs},${c}`] = { text, remaining: rowspan - rs };
            }
          }
        }
      }
      colCursor += colspan;
    }

    matrix.push(row);
  }

  return matrix;
}

function getTableColumnCount(table: Element): number {
  const firstRow = table.querySelector('tr');
  if (!firstRow) return 0;
  let count = 0;
  for (const cell of firstRow.querySelectorAll('th, td')) {
    count += parseInt(cell.getAttribute('colspan') || '1', 10);
  }
  return count;
}

function detectHeaderRows(table: Element): Element[] {
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length === 0) return [];

  const first = rows[0];
  if (Array.from(first.children).every((c) => c.tagName === 'TH')) return [first];

  const firstCells = Array.from(first.children);
  const firstNonEmpty = firstCells.find((c) =>
    (c instanceof HTMLElement ? c.innerText : c.textContent || '').replace(/\u00a0/g, ' ').trim(),
  );
  if (firstNonEmpty) {
    const style = window.getComputedStyle(firstNonEmpty as HTMLElement);
    if (parseInt(style.fontWeight, 10) >= 700 || style.fontWeight === 'bold') return [first];
    if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent') return [first];
  }

  if (rows.length >= 2) {
    const normalize = (t: string) => (t || '').replace(/\u00a0/g, ' ').trim();
    const firstTexts = firstCells.map((c) => normalize(c instanceof HTMLElement ? c.innerText : c.textContent || '')).filter(Boolean);
    const secondTexts = Array.from(rows[1].children)
      .map((c) => normalize(c instanceof HTMLElement ? c.innerText : c.textContent || ''))
      .filter(Boolean);

    if (firstTexts.length > 0 && secondTexts.length > 0) {
      const NUM_PATTERN = /^[$£€¥]?[\d,.]+%?$/;
      const firstHasNumbers = firstTexts.some((t) => NUM_PATTERN.test(t));
      const secondHasNumbers = secondTexts.some((t) => NUM_PATTERN.test(t));
      if (!firstHasNumbers && secondHasNumbers) return [first];
    }
  }

  return [];
}

type RowsWithGroup = Array<Record<string, unknown>> & { lastGroup?: string };

function extractHtmlTable(table: HTMLTableElement): Record<string, unknown>[] {
  const thead = table.querySelector('thead');
  const detectedHeaderRows = thead ? [] : detectHeaderRows(table);
  const headers = extractTableHeaders(table);

  let totalCols = headers.length;
  if (totalCols === 0) {
    totalCols = getTableColumnCount(table);
    for (let i = 0; i < totalCols; i++) headers.push(`Column ${i + 1}`);
  }

  const headerRowSet = new Set(detectedHeaderRows);
  const tbody = table.querySelector('tbody');
  const candidateRows = tbody
    ? Array.from(tbody.querySelectorAll(':scope > tr'))
    : getDataRows(table, headers);
  const dataRows = candidateRows.filter((r) => !headerRowSet.has(r));

  const carryForward: Record<number, { value: unknown; remaining: number }> = {};

  const rows: RowsWithGroup = [];

  for (const row of dataRows) {
    const cells = Array.from(row.querySelectorAll('td, th'));

    if (cells.length === 1) {
      const span = parseInt(cells[0].getAttribute('colspan') || '1', 10);
      if (span >= totalCols - 1 || span >= 3) {
        rows.lastGroup = (cells[0] instanceof HTMLElement ? cells[0].innerText : cells[0].textContent || '').trim();
        continue;
      }
    }

    const rowObj: Record<string, unknown> = {};
    if (rows.lastGroup) rowObj['_group'] = rows.lastGroup;

    let colCursor = 0;
    for (const cell of cells) {
      while (colCursor < totalCols && carryForward[colCursor]?.remaining > 0) {
        const cf = carryForward[colCursor];
        rowObj[headers[colCursor] || `col${colCursor}`] = cf.value;
        cf.remaining--;
        colCursor++;
      }
      if (colCursor >= totalCols) break;

      const text = getCellValue(cell as HTMLElement);
      const colspan = parseInt(cell.getAttribute('colspan') || '1', 10);
      const rowspan = parseInt(cell.getAttribute('rowspan') || '1', 10);

      const nestedTable = cell.querySelector('table');
      const value = nestedTable ? extractHtmlTable(nestedTable) : text;

      for (let cs = 0; cs < colspan; cs++) {
        const c = colCursor + cs;
        if (c < totalCols) {
          rowObj[headers[c] || `col${c}`] = value;
          if (rowspan > 1) {
            carryForward[c] = { value, remaining: rowspan - 1 };
          }
        }
      }
      colCursor += colspan;
    }

    for (let c = colCursor; c < totalCols; c++) {
      if (carryForward[c]?.remaining > 0) {
        rowObj[headers[c] || `col${c}`] = carryForward[c].value;
        carryForward[c].remaining--;
      }
    }

    if (Object.keys(rowObj).filter((k) => k !== '_group').length > 0) {
      rows.push(rowObj);
    }
  }

  return rows;
}

function getDataRows(table: Element, headers: string[]): Element[] {
  const allRows = Array.from(table.querySelectorAll('tr'));
  if (allRows.length === 0) return [];
  const first = allRows[0];
  if (Array.from(first.children).every((c) => c.tagName === 'TH') || headers.length > 0) {
    return allRows.slice(1);
  }
  return allRows;
}

function getCellValue(cell: HTMLElement): string {
  const input = cell.querySelector('input:not([type="hidden"]), select, textarea');
  if (input) {
    if (input.tagName === 'SELECT') {
      const sel = input as HTMLSelectElement;
      return sel.options[sel.selectedIndex]?.text || sel.value;
    }
    return (input as HTMLInputElement | HTMLTextAreaElement).value;
  }
  return (cell.innerText || cell.textContent || '').trim();
}

function extractDivGrid(container: HTMLElement): Record<string, unknown>[] {
  const children = Array.from(container.children) as HTMLElement[];
  if (children.length === 0) return [];

  const firstTexts = Array.from(children[0].children).map((c) =>
    (c instanceof HTMLElement ? c.innerText : c.textContent || '').trim(),
  );
  const looksLikeHeader = firstTexts.every((t) => t && t.length < 50);
  const headers = looksLikeHeader ? firstTexts : firstTexts.map((_, i) => `Column ${i + 1}`);
  const dataChildren = looksLikeHeader ? children.slice(1) : children;

  return dataChildren.map((child) => {
    const cells = Array.from(child.children);
    const obj: Record<string, unknown> = {};
    cells.forEach((cell, i) => {
      obj[headers[i] || `col${i}`] = (cell instanceof HTMLElement ? cell.innerText : cell.textContent || '').trim();
    });
    return obj;
  });
}

function extractAriaTable(element: Element): Record<string, unknown>[] {
  const rowEls = element.querySelectorAll('[role="row"]');
  if (rowEls.length === 0) return [];

  const rows = Array.from(rowEls);
  const headerRow =
    rows.find((r) =>
      Array.from(r.children).every(
        (c) => c.getAttribute?.('role') === 'columnheader' || c.tagName === 'TH',
      ),
    ) || rows[0];

  const headers = Array.from(headerRow.querySelectorAll('[role="columnheader"], th')).map(
    (c, i) => (c instanceof HTMLElement ? c.innerText : c.textContent || '').trim() || `Column ${i + 1}`,
  );

  return rows
    .filter((r) => r !== headerRow)
    .map((row) => {
      const cells = Array.from(row.querySelectorAll('[role="cell"], [role="gridcell"], td'));
      const obj: Record<string, unknown> = {};
      cells.forEach((cell, i) => {
        obj[headers[i] || `col${i}`] = (cell instanceof HTMLElement ? cell.innerText : cell.textContent || '').trim();
      });
      return obj;
    });
}

function extractDivRowGrid(element: Element, rowSelector: string, cellSelector: string): Record<string, unknown>[] {
  const rows = Array.from(element.querySelectorAll(rowSelector));
  if (rows.length === 0) return [];

  const headerSelectors = [
    '.tabulator-headers .tabulator-col-title',
    '.slick-header-column',
    '.x-column-header-text',
  ];
  let headers: string[] = [];
  for (const hs of headerSelectors) {
    const hEls = element.querySelectorAll(hs);
    if (hEls.length > 0) {
      headers = Array.from(hEls).map((h) => (h instanceof HTMLElement ? h.innerText : h.textContent || '').trim());
      break;
    }
  }

  if (headers.length === 0) {
    const ariaHeaders = element.querySelectorAll('[role="columnheader"]');
    if (ariaHeaders.length > 0) {
      headers = Array.from(ariaHeaders).map((h) => (h instanceof HTMLElement ? h.innerText : h.textContent || '').trim());
    }
  }

  return rows.map((row) => {
    const cells = Array.from(row.querySelectorAll(cellSelector));
    const obj: Record<string, unknown> = {};
    cells.forEach((cell, i) => {
      obj[headers[i] || `Column ${i + 1}`] = (cell instanceof HTMLElement ? cell.innerText : cell.textContent || '').trim();
    });
    return obj;
  });
}

export function getTableColumnNames(element: Element | null): string[] {
  if (!element) return [];
  const table = element.tagName === 'TABLE' ? element : element.querySelector('table');
  if (!table) return [];
  return extractTableHeaders(table);
}

export function getTablePreview(element: Element | null, maxRows = 3): Record<string, unknown>[] {
  const rows = extractTable(element);
  return rows.slice(0, maxRows);
}
