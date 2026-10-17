export interface BoundaryViolation {
  file: string;
  line: number;
  specifier: string;
  reason: string;
}

export interface BoundaryCheckResult {
  ok: boolean;
  packFiles: number;
  violations: BoundaryViolation[];
  lines: string[];
}

export function checkPackBoundaries(options?: { root?: string }): BoundaryCheckResult;
