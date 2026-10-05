# Playwright storage codec 1.60.0

These Apache-2.0 source files are copied without semantic changes from the
`v1.60.0` tag of microsoft/playwright. They preserve the existing encrypted
storage-state format, including IndexedDB values, while Trelio controls page
creation and never asks Playwright to create a foreground storage page.

- `storageScript.ts`: `packages/injected/src/storageScript.ts`
- `utilityScriptSerializers.ts`: `packages/isomorphic/utilityScriptSerializers.ts`
- `LICENSE`: upstream Apache-2.0 license

Run `node platform-skills/gosuslugi/development/build-storage-codec.mjs` from
the repository root with Node >= 22.13 to regenerate the runtime module. The
builder strips types and combines the fixed sources; it makes no network calls.
