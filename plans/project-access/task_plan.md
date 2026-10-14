# Project Access Design Task

Date: 2026-10-11
Mode: design only; no application or schema changes.

## Objective

Design explicit per-project access for invited organization members, with
separate viewing, collaboration, and project-management rights.

## Phases

1. Repository and current invitation/authorization discovery: complete.
2. Inventory direct, aggregate, notification, and credential access: complete.
3. Write a self-contained Chinese design and implementation plan: complete.
4. Check design consistency and deliver: complete.

## Constraints

- Only planning documents under plans/ may be changed.
- Preserve existing dirty files and unrelated plans.
- Respect existing Project -> Monitor ownership.
- Do not run migrations or change production data.
- Current HEAD: 04e9253; uncommitted changes are also part of the live baseline.

## Errors

- Combined README/config read exceeded output budget. Relevant config and
  authorization files were read directly; do not rely on the truncated README.
- PowerShell rejected shell brace/glob expressions used for grouped rg paths;
  corrected searches use rg --glob against actual directories.
- A few guessed module/interface paths and optional NestJS rule references do
  not exist; read actual module/storage files discovered with rg --files.
- Web reference tool returned no usable documentation content; design relies on
  inspected local source and skills, not unverified external claims.
- Final refinement patch initially mismatched a Markdown table row prefix;
  retried with the exact row. No source files were changed.
