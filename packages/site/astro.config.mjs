import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.spec-engine.dev",
  integrations: [
    starlight({
      title: "Spec Engine",
      description:
        "Durable domain requirements that survive past production, addressed by permanent ID, bound to code, and checkable in CI.",
      // The clamp mark as the site logo (swaps per color scheme);
      // the "Spec Engine" title renders beside it in Archivo.
      logo: {
        light: "./src/assets/spec-mark-black.svg",
        dark: "./src/assets/spec-mark-white.svg",
        alt: "Spec Engine",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/spec-engine/spec-engine",
        },
      ],
      customCss: ["./src/styles/spec-engine.css"],
      // Brand fonts, favicons, and social-card meta, loaded once in the
      // document head. Starlight already emits per-page og:title /
      // og:description / twitter:card — only the image + icons live here.
      head: [
        {
          tag: "link",
          attrs: {
            rel: "preconnect",
            href: "https://fonts.gstatic.com",
            crossorigin: true,
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "stylesheet",
            href: "https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
          },
        },
        { tag: "link", attrs: { rel: "icon", href: "/favicon.ico", sizes: "any" } },
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32.png" },
        },
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16.png" },
        },
        {
          tag: "link",
          attrs: { rel: "apple-touch-icon", sizes: "180x180", href: "/favicon-180.png" },
        },
        { tag: "link", attrs: { rel: "manifest", href: "/site.webmanifest" } },
        { tag: "meta", attrs: { name: "theme-color", content: "#0F1214" } },
        {
          tag: "meta",
          attrs: {
            property: "og:image",
            content: "https://docs.spec-engine.dev/og-spec-engine-docs.png",
          },
        },
        { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
        { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
        {
          tag: "meta",
          attrs: {
            name: "twitter:image",
            content: "https://docs.spec-engine.dev/og-spec-engine-docs.png",
          },
        },
      ],
      editLink: {
        baseUrl: "https://github.com/spec-engine/spec-engine/edit/main/packages/site/",
      },
      sidebar: [
        {
          label: "Overview",
          slug: "overview",
        },
        {
          label: "Getting Started",
          slug: "getting-started",
        },
        {
          label: "Architecture",
          slug: "architecture",
        },
        {
          label: "Commands",
          slug: "commands",
        },
        {
          label: "SPEC.json Format",
          slug: "format",
        },
        {
          label: "Tags",
          slug: "tags",
        },
        {
          label: "Integrity Checks",
          slug: "checks",
        },
        {
          label: "Guides",
          items: [{ autogenerate: { directory: "guides" } }],
        },
        {
          label: "Agent Reference",
          slug: "agent-reference",
        },
      ],
    }),
  ],
});
