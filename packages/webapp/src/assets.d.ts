// bun-types declares `*.html` text imports but not `*.css` or `*.md`; Bun inlines the
// file as a string, including under `bun build --compile`.

declare module "*.css" {
  const contents: string;
  export default contents;
}

declare module "*.md" {
  const contents: string;
  export default contents;
}
