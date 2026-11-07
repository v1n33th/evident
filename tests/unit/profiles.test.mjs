import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileDrift } from '../../skills/bug-bash/scripts/profiles.mjs';

test('profileDrift names the habits, focus types and profiles the copy lacks, and merges them', () => {
  const copy = { profiles: [{ id: 'bad-actor', name: 'Bad actor', who: 'A spammer on Acme', focus: ['security'], does: ['Pastes markup'] }] };
  const skill = { profiles: [
    { id: 'bad-actor', name: 'Bad actor', who: 'Someone', focus: ['security', 'bug'], does: ['Pastes markup', 'Tries URL tricks'] },
    { id: 'on-the-go', name: 'On the go', optIn: true, does: [] },
  ] };
  const { lines, merged } = profileDrift(copy, skill);
  assert.deepEqual(lines, ['bad-actor: new focus: bug', 'bad-actor: new habit: Tries URL tricks', 'New profile: on-the-go (On the go)']);
  assert.equal(merged.profiles[0].who, 'A spammer on Acme', 'what the project filled in stays');
  assert.deepEqual(merged.profiles[0].does, ['Pastes markup', 'Tries URL tricks']);
  assert.equal(merged.profiles[1].optIn, true);
  assert.deepEqual(copy.profiles[0].does, ['Pastes markup'], 'the copy passed in is not changed');
  assert.deepEqual(profileDrift(merged, skill).lines, []);
});
