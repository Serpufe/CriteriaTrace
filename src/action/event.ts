export function requirePullRequestEvent(eventName: string): void {
  if (eventName !== 'pull_request') {
    throw new Error('CriteriaTrace action requires a pull_request event.');
  }
}
