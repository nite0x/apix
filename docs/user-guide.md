# Apix User Guide

Apix (**Agent Programmable Interface eXecution**) is a local-first desktop tool for observing and controlling AI-driven execution flows.

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
