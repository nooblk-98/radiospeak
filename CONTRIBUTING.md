# Contributing

Use Node.js 22.18 or newer. CI and Docker use Node.js 24. Application TypeScript runs directly in Node; keep it compatible with native type stripping and the existing `tsconfig.json` settings.

## Local workflow

```bash
npm ci
npm run format
npm run format:check
npm run check
npm test
```

Prettier formats source, tests, scripts and documentation. Its ignore file excludes dependencies, lockfiles, binary assets and local runtime data. The committed editor and Git settings keep indentation and line endings consistent across Windows and Linux.

Tests use temporary stores, local HTTP fixtures, jsdom and mocked platform connections. They do not require a TeamSpeak or Discord account. Real audio cases run when FFmpeg is available; set `FFMPEG_PATH` explicitly to ensure they run instead of skipping:

```bash
FFMPEG_PATH=/usr/bin/ffmpeg npm test
```

In PowerShell:

```powershell
$env:FFMPEG_PATH = 'C:\tools\ffmpeg\bin\ffmpeg.exe'
npm test
```

## Where changes belong

Keep provider lookups in `src/media/`, platform transport logic in `src/bots/`, persistence in store modules, and HTTP validation at the request boundary. Place browser templates in `src/web/views/`, reusable stateless markup in `src/web/ui/` and independent interaction controllers in `src/web/features/`.

Add comments for lifecycle decisions, data ownership, security boundaries and concurrency assumptions. Prefer clear names over comments that repeat a statement. Avoid unrelated reformatting when reviewing a behavioral change.

Preserve these contracts when refactoring:

- Public routes, role checks, status codes and stable bot identifiers.
- Stored filenames, TeamSpeak identities, encrypted credentials and portable library formats.
- User-queue priority, checkpoint recovery, listener pause and the 20 ms audio frame path.
- Lazy Discord initialization and shared gateway reference counting.
- Live view context, revisioned module imports and CSS cascade order.

Run the checks relevant to the change and the full suite before submitting a broad refactor. GitHub Actions checks formatting, types and tests, including real FFmpeg output.
