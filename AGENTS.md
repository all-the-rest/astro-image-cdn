# Project rules

- Use pnpm for package operations and tests.
- Keep generated image variants and their incremental cache outside Astro's `dist/`.
- Do not add metadata, YAML, slug, deployment, or upload dependencies to the image pipeline.
- Verify native Astro integration changes with the real build tests in `pnpm check`.
- Never publish or deploy unless the user explicitly asks.
