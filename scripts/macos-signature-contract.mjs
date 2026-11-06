/** Parse codesign diagnostics without treating any team-bearing signature as Developer ID. */
export function signatureContract(diagnostics) {
  const team = diagnostics.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() ?? null;
  const authority = diagnostics.match(/^Authority=(.+)$/m)?.[1]?.trim() ?? null;
  const adhoc = /^Signature=adhoc$/m.test(diagnostics) || /^flags=.*\badhoc\b/m.test(diagnostics);
  const runtime = /^CodeDirectory .*flags=.*\bruntime\b/m.test(diagnostics);
  return { team, authority, runtime, developerId: !!team && team !== 'not set' && !adhoc
    && !!authority && authority.startsWith('Developer ID Application: ') && runtime };
}

export function matchingDeveloperIdSignatures(app, cli) {
  return app.developerId && cli.developerId && app.team === cli.team;
}
