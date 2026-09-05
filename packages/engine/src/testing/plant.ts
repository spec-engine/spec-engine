// packages/engine/src/testing/plant.ts
//
// Plant a state the engine refuses to author: an entry removed from the
// working tree, a status flipped without approval, a forward pointer at a
// missing id, a grammar declared after the fact. The edit runs on the parsed
// envelope and is written back through the validating seam, so a planted
// state is always schema-valid; a schema-invalid file belongs under
// ./fixtures/ instead.

import { type SpecDomain, validateAndWrite, validateDomainFile } from "@spec-engine/shared";
import { specPaths } from "../constants";

export async function plantEdit(
  platformDir: string,
  key: string,
  edit: (domain: SpecDomain) => void,
): Promise<void> {
  const { abs, rel } = specPaths(platformDir, key);
  const parsed = validateDomainFile(JSON.parse(await Bun.file(abs).text()), rel);
  if (!parsed.ok) {
    throw new Error(
      `${rel} is invalid before the edit: ${parsed.diagnostics.map((d) => d.detail).join("; ")}`,
    );
  }
  edit(parsed.data);
  const res = await validateAndWrite(abs, parsed.data, rel);
  if (!res.ok) {
    throw new Error(
      `${rel} is invalid after the edit: ${res.diagnostics.map((d) => d.detail).join("; ")}`,
    );
  }
}

/** The entry `id` names, or a thrown error naming what was expected. */
export function entryOf(domain: SpecDomain, id: string): SpecDomain["requirements"][number] {
  const entry = domain.requirements.find((r) => r.id === id);
  if (entry === undefined) throw new Error(`no entry ${id} in ${domain.key}`);
  return entry;
}
