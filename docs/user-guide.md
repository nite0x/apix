# Apix User Guide

Apix (**Agentic Procedural Interface eXecution**) is a local-first desktop tool for observing and controlling AI-driven execution flows.

## What Apix Does

- Streams runtime activity into a desktop timeline.
- Lets users inspect each execution step in real time.
- Supports manual requests alongside AI-driven sessions.
- Provides a foundation for guardrails such as pause rules, approval flows, and reusable variables.

## Local Development

Start the full development stack:

```bash
pnpm dev
```

Start browser-first development without launching Tauri:

```bash
pnpm dev:browser
```

Run modules independently:

```bash
pnpm dev:frontend
pnpm dev:backend
pnpm dev:tauri
```

Build the desktop application:

```bash
pnpm build
```

## Runtime Endpoints

- Frontend: `http://127.0.0.1:1420`
- Runtime API: `http://127.0.0.1:4317`
- Health check: `GET /health`
- Log stream: `GET /ws/logs`

## Core Concepts

### Sessions

A session groups the execution history for one AI task or one manual workflow.

### Steps

Each session contains ordered steps such as requests, reasoning gaps, and manual actions.

### Variables

Variables capture reusable values from one step and make them available to later steps.

### Rules

Rules describe when Apix should pause or require user confirmation before an operation continues.

## Current Capabilities

- A desktop shell built with Tauri
- A React timeline UI
- A Go runtime service
- HTTP request execution
- Stored API definitions and collections
- Pause rules, approval flows, and reusable variables

## Card-based Flow tests

Open **测试流程** in the Runtime Web workspace (`http://127.0.0.1:4317/flows`).
Create a Flow, then arrange HTTP, SQL, or service cards in execution order. Expand a card to edit
its request, name, assertions, response extractors, and failure policy. Flow
changes save automatically; running first flushes the saved definition and
records its version.

- Define shared variables in the right-hand Flow panel. Names use letters,
  digits, and underscores, starting with a letter or underscore. Reference them
  in requests using `{{token}}` or `{{order_id}}`.
- Variable precedence is environment, Flow default, run input, then response
  extraction. Every run starts independently. Blank run inputs inherit defaults
  or environment values. Required Flow variables must be available before a run;
  values produced by earlier cards should instead use a required extractor.
- Sensitive Flow variables have no saved default; provide their values under
  the input dialog shown before starting a run. Run input and extraction records
  mask values marked sensitive.
- Extract values from a response body, header, or status into run variables.
  Body paths use dot notation (`data.id`, `items.0.id`), not JSONPath. An empty
  body path selects the entire body. Required missing extractions fail the step.
- Assert an expected HTTP status or add response assertions using **等于**,
  **不等于**, **包含**, or **存在**. Comparisons use text; missing values fail
  every operator. All assertions must pass. Extraction runs after assertions pass.
- The Flow-level stop-on-error setting can be overridden by a card's
  continue-on-error option. A failed card still makes the overall test fail.
- **运行流程** opens run cards with request/response details, timing, assertion
  results, and extracted variables. **运行记录** in the right panel reopens
  historical Flow runs. Editing a Flow never changes an existing run snapshot.

The Web page uses the Runtime that serves it; no separate frontend dev server
is needed. Rebuild and restart the Runtime after changing embedded Web assets.
