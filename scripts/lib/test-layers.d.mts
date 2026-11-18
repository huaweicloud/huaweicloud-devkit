export declare const FULL_ONLY_TESTS: ReadonlySet<string>;
export declare const ENV_GATED_TESTS: ReadonlySet<string>;
export declare function listTestFiles(testDir: string): string[];
export declare function isFamilyMember(body: string): boolean;
export declare function partitionTests(testDir: string): {
  family: string[];
  quick: string[];
  fullOnly: string[];
  envGated: string[];
};
