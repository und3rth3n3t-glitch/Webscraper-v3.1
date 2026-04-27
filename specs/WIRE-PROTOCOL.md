# WebScrape Wire Protocol — v1

This document is the portable contract between the extension/worker and any backend
that hosts it. A future production .NET backend implements the same SignalR hub method
signatures and accepts/returns the JSON shapes described here.

## Transport

SignalR WebSockets. Hub path: `/scraper-hub` (configurable in appsettings).

## Down-channel (Backend → Extension)

### ReceiveTask

```json
{
  "id": "task-uuid",
  "configId": "config-uuid",
  "configName": "ONS Census",
  "searchTerms": ["East Midlands", "Yorkshire"],
  "iterationLabel": "region",
  "iterationAssignments": {},
  "priority": 0,
  "createdAt": "2026-04-27T12:00:00Z",
  "status": "pending",
  "inlineConfig": { }
}
```

`inlineConfig` is the complete `ScraperConfig` object. The extension uses
`inlineConfig.steps[].options.elements[].outputKey` (optional, string) and
`inlineConfig.steps[].options.elements[].columnOverrides` (optional array) when
shaping results. If absent, keys and types are auto-derived.

`columnOverrides` shape per element:
```json
[{ "flatKey": "England.Country.count", "type": "text" }]
```

Valid `type` values: `text | number | percent | currency | date | boolean`.

## Up-channel (Extension → Backend)

### TaskComplete

```json
{
  "taskId": "task-uuid",
  "configId": "config-uuid",
  "configName": "ONS Census",
  "status": "success",
  "iterations": [],
  "totalTimeMs": 4500,
  "timestamp": "2026-04-27T12:00:04Z"
}
```

## `WireIteration` shape (schemaVersion: 1)

```json
{
  "schemaVersion": 1,
  "iterationKey": "east_midlands",
  "iterationLabel": "East Midlands",
  "searchTerm": "East Midlands",
  "status": "success",
  "outputs": {
    "sex_persons": {
      "kind": "table",
      "label": "sex_persons",
      "schema": {
        "rowKeyColumnId": "column_1",
        "columns": [
          {
            "id": "column_1",
            "headers": ["Column 1"],
            "displayName": "Column 1",
            "type": "text",
            "inferred": true
          },
          {
            "id": "england_country_count",
            "headers": ["England\nCountry", "count"],
            "displayName": "count",
            "type": "number",
            "format": { "thousands": "," },
            "inferred": true
          }
        ]
      },
      "rows": [
        {
          "id": "all_usual_residents",
          "key": "All usual residents",
          "cells": {
            "column_1": { "value": "All usual residents", "raw": "All usual residents" },
            "england_country_count": { "value": 56490048, "raw": "56,490,048" }
          }
        }
      ]
    }
  }
}
```

## Iteration key derivation

`iterationKey = slugify(searchTerm)` where `slugify` lowercases, maps known symbols
(`%`→`pct`, `£`→`gbp`, etc.), strips non-alphanumeric, collapses underscores,
truncates to 64 chars. If the result is empty, `"default"` is used. Duplicates within
a run are disambiguated with `_2`, `_3` suffix.

## Column id derivation

`column.id = slugify(headers.join('_'))` using the same slugify function. Duplicates
within one table disambiguated with `_2`, `_3`.

## schemaVersion evolution

`schemaVersion: 1` is stamped by the extension on every iteration. Future breaking shape
changes bump the version.
