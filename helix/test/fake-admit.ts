// Draft Submit admits a spec against a project's profile on GitHub (admit.ts).
// This stands in for that read: the plugin's own admit on an in-memory profile,
// with every branch and path present. Nothing touches git or the network.
import { admit } from '../../plugin/src/admit.ts';
import { parseProfile } from '../../plugin/src/profile.ts';
import { loadFactory } from '../../plugin/src/profiles.ts';
import type { AdmitSubmission } from '../src/admit.ts';

export const fakeAdmit = (profileText = 'commands:\n  test: npm test\n'): AdmitSubmission => async (_person, _repo, spec, name) => ({
  admitted: admit(loadFactory(), spec, { profile: parseProfile(profileText), read: 'origin/main on GitHub', hasBranch: () => true, hasPath: () => true }, name),
  warnings: [],
});
