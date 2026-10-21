// bun-types declares `*.html` text imports but not `*.css`; Bun inlines the
// file as a string, including under `bun build --compile`.

declare module "*.css" {
  const contents: string;
  export default contents;
}
