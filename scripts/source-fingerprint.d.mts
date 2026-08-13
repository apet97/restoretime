export function sourceFingerprint(root?: string): string;
export function sourceFingerprintFromGit(candidateId: string, root?: string): string;
export function assertCleanGitCandidate(candidateId: string, root?: string): void;
export function releaseCandidateSourceFingerprint(candidateId: string, root?: string): string;
