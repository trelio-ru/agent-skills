// Synthetic host seam, not another transport or a credential runtime.
export const prepareBrowserController = ({ environment }) => {
  if (environment.TRELIO_BROWSER_CONTROLLER_ENABLED !== '1') throw new Error('synthetic_host_refused');
  return { apiVersion: 1, sessionId: '33333333-3333-4333-8333-333333333333',
    deadlineAt: Number(environment.TRELIO_BROWSER_SESSION_DEADLINE_AT), moduleUrl: import.meta.url,
    ownerFile: '/synthetic/owner.json' };
};
