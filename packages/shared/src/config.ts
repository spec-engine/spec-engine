import { z } from "zod";

/** The member config: the pin and the scan-skip prefixes. Every key the engine knows is declared here; membership lives in platform-map's files. */
export const SpecConfigSchema = z.object({
  specs: z
    .string()
    .regex(/^spec-engine@\d+$/, "must be of the form spec-engine@N where N is an integer"),
  ignore: z.array(z.string().min(1, "ignore entries must be non-empty strings")).optional(),
});

export type SpecConfig = z.infer<typeof SpecConfigSchema>;
