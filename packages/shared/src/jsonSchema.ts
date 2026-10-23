import { z } from "zod";
import { CheckConfigSchema } from "./checkConfig";
import { SpecConfigSchema } from "./config";
import { SpecDomainSchema } from "./domain";
import { SCHEMA_URLS } from "./schemaUrl";

const SOURCES: Record<keyof typeof SCHEMA_URLS, { schema: z.ZodType; title: string }> = {
  spec: { schema: SpecDomainSchema, title: "Spec Engine domain file (SPEC.json)" },
  check: { schema: CheckConfigSchema, title: "Spec Engine check configuration (check.json)" },
  member: {
    schema: SpecConfigSchema,
    title: "Spec Engine member configuration (spec-engine.member.json)",
  },
};

export const SCHEMA_OUT_DIR = `${import.meta.dir}/../../site/public/schema/v1`;

/**
 * File name to bytes for every published schema, generated from the zod
 * schemas the engine parses with. `io: "input"` describes the file as
 * authored, before defaults and transforms apply.
 * @spec SCHM-041
 */
export function renderJsonSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, { schema, title }] of Object.entries(SOURCES)) {
    const { $schema, ...body } = z.toJSONSchema(schema, { io: "input" });
    const $id = SCHEMA_URLS[name as keyof typeof SCHEMA_URLS];
    out[`${name}.json`] = `${JSON.stringify({ $schema, $id, title, ...body }, null, 2)}\n`;
  }
  return out;
}

// @spec DIST-021
if (import.meta.main) {
  for (const [file, text] of Object.entries(renderJsonSchemas())) {
    await Bun.write(`${SCHEMA_OUT_DIR}/${file}`, text);
  }
}
