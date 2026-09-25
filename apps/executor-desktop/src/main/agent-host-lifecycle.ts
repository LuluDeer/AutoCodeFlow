/** Connection and workspace values captured when an AgentHost is created. */
export interface AgentHostIdentityParts {
  baseUrl: string;
  token: string | null;
  address: string;
  workDir: string;
}

export function agentHostIdentity(parts: AgentHostIdentityParts): string {
  return JSON.stringify([parts.baseUrl, parts.token, parts.address, parts.workDir]);
}

export function agentHostTransition(
  currentIdentity: string | null,
  desiredIdentity: string,
  tickInFlight: boolean,
): 'create' | 'keep' | 'defer' | 'replace' {
  if (currentIdentity === null) return 'create';
  if (currentIdentity === desiredIdentity) return 'keep';
  return tickInFlight ? 'defer' : 'replace';
}
