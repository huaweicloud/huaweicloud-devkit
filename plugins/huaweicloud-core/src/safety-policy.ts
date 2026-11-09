// Stable public face of the safety subsystem. The internals live in the
// src/safety/ family (policy loading and pattern appliers, the redaction
// walk, the secret vocabulary, the shell text model, the unwrap engine,
// the segment scanner and its xargs feeder, the hcloud and text
// classifiers); this module is the re-export seam every consumer imports —
// same exported names, same import path, same behavior.

export { loadPolicy } from './safety/default-policy.ts';
export type { ClassifyOptions, Policy } from './safety/policy.ts';
export { deriveSecretOperationAlternation } from './safety/vocabulary.ts';
export { redactSecrets } from './safety/redact.ts';
export { splitShellSegments } from './safety/shell-text.ts';
export { isCredentialFilePath } from './safety/credential-path.ts';
export { classifyHcloudArgs, assertAllowed } from './safety/classify-hcloud.ts';
export { classifyTextCommand } from './safety/classify-text.ts';
export { stripExecutable } from './safety/unwrap.ts';
