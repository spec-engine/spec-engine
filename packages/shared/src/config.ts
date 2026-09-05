import { z } from "zod";

/** The member config: the pin, the scan-skip prefixes, and the workspace-expansion glob. Every key the engine knows is declared here. */
export const SpecConfigSchema = z.object({
  specs: z
    .string()
    .regex(/^spec-engine@\d+$/, "must be of the form spec-engine@N where N is an integer"),
  ignore: z.array(z.string().min(1, "ignore entries must be non-empty strings")).optional(),
  members: z.string().min(1, "members must be a non-empty glob").optional(),
});

export type SpecConfig = z.infer<typeof SpecConfigSchema>;
