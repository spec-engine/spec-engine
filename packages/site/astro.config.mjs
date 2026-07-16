import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.spec-engine.dev",
  integrations: [
    starlight({
      title: "spec-check",
      description:
        "Durable domain requirements that survive past production, addressed by permanent ID, bound to code, and checkable in CI.",
      logo: {
        light: "./src/assets/spec-check-logo-light.svg",
        dark: "./src/assets/spec-check-logo-dark.svg",
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/spec-engine/spec-engine",
        },
      ],
      customCss: ["./src/assets/theme.css"],
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
