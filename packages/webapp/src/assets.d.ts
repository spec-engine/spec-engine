// packages/webapp/src/assets.d.ts
//
// Ambient module declaration for `*.css` text-imports used by the SSR pages
// (plan 05-04). Bun's bun-types ships an ambient `*.html` declaration but
// no `*.css` declaration. Pages embed CSS via the canonical
// `import styleSheet from "./styles.css" with { type: "text" }` attribute;
// at runtime Bun inlines the file as a UTF-8 string (Shared 5 / D-14 /
// SERV-04 — survives `bun build --compile`). This declaration just teaches
// TS that the import resolves to `string` so we don't need to cast through
// `unknown` at every call site.
//
// D-09 / WORK-04: no runtime imports here — pure type declaration. Webapp
// package's `noRestrictedImports` rule applies to runtime imports, not
// ambient .d.ts declarations.

declare module "*.css" {
  const contents: string;
  export default contents;
}
