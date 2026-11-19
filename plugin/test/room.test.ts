import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseVmStat, waitReason, type Reading } from '../src/room.ts';

const GB = 1024 ** 3;
// About 0.3 GB free, 6.5 GB inactive and 16 MB speculative, in 16 KB pages.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    19661.
Pages active:                                 418160.
Pages inactive:                               425984.
Pages speculative:                              1000.
Pages throttled:                                   0.
Pages wired down:                             193084.
Pages purgeable:                                4983.
`;

test('vm_stat reading counts free, inactive and speculative pages, and nothing else', () => {
  assert.equal(parseVmStat(VM_STAT), (19661 + 425984 + 1000) * 16384);
});

test('vm_stat reading is undefined for output that is not vm_stat', () => {
  assert.equal(parseVmStat('command not found'), undefined);
});

test('0.3 GB free and 6.5 GB inactive on a Mac fits a 4 GB job with 2 GB kept free', () => {
  const machine: Reading = { freeBytes: parseVmStat(VM_STAT)!, load: 0.5, cores: 8 };
  assert.equal(waitReason({ job_memory: '4g', reserve_memory: '2g' }, [], undefined, machine), undefined);
  // The same machine by free pages alone (0.3 GB) would have to wait.
  assert.match(waitReason({}, [], undefined, { ...machine, freeBytes: 0.3 * GB })!, /^waiting for memory/);
});
