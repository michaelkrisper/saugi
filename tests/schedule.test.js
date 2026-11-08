import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deviceTimer, formatCron, jobName, newJob, parseCron, updatedJob } from '../public/js/schedule.js';

// Crons as written by the Roborock app (S7): weekdays 10:00, Sunday only.
test('parses Roborock app crons', () => {
  assert.deepEqual(parseCron('00 10 ? * 1,2,3,4,5'), { hour: 10, minute: 0, days: [1, 2, 3, 4, 5] });
  assert.deepEqual(parseCron('00 10 ? * 0'), { hour: 10, minute: 0, days: [0] });
  assert.deepEqual(parseCron('5 7 ? * 1-3,7'), { hour: 7, minute: 5, days: [0, 1, 2, 3] });
  assert.deepEqual(parseCron('30 6 * * *').days, [0, 1, 2, 3, 4, 5, 6]);
});

test('formats crons like the Roborock app', () => {
  assert.equal(formatCron({ hour: 10, minute: 0, days: [5, 1, 3] }), '00 10 ? * 1,3,5');
  assert.equal(formatCron({ hour: 7, minute: 5, days: [6, 0] }), '05 07 ? * 0,6');
});

test('update keeps the job and replaces cron and enabled', () => {
  const job = {
    id: 7,
    cron: '00 10 ? * 0',
    timeZoneId: 'Europe/Vienna',
    repeated: true,
    enabled: false,
    param: { id: 1, method: 'server_scheduled_start' },
    nextFireTime: 'x',
  };
  assert.deepEqual(updatedJob(job, { hour: 8, minute: 30, days: [1, 2], enabled: true }), {
    cron: '30 08 ? * 1,2',
    timeZoneId: 'Europe/Vienna',
    repeated: true,
    enabled: true,
    param: { id: 1, method: 'server_scheduled_start' },
  });
});

test('new job is a whole-home clean with the current fan power', () => {
  const j = newJob({ hour: 9, minute: 0, days: [6], enabled: true }, { fan_power: 104 }, 'Europe/Vienna', 1);
  assert.equal(j.cron, '00 09 ? * 6');
  assert.equal(j.param.method, 'server_scheduled_start');
  assert.deepEqual(j.param.params[0], {
    repeat: 1,
    water_box_mode: 203,
    segments: '0',
    fan_power: 104,
    mop_mode: 300,
    clean_mop: 1,
    map_index: -1,
    name: '1',
  });
});

// set_server_timer as the Roborock S7 plugin builds it (setTimerOnServer, ConvertToCronStr).
test('device timer mirrors the cloud job', () => {
  const job = newJob(
    { hour: 9, minute: 5, days: [5, 1], enabled: true },
    { fan_power: 102 },
    'Europe/Vienna',
    42,
  );
  assert.equal(jobName(job), '42');
  assert.deepEqual(deviceTimer(job, { hour: 9, minute: 5, days: [5, 1] }), [
    '42',
    [
      '5 9 * * 1,5',
      [
        'start_clean',
        {
          repeat: 1,
          water_box_mode: 203,
          segments: '0',
          fan_power: 102,
          mop_mode: 300,
          clean_mop: 1,
          map_index: -1,
        },
      ],
    ],
  ]);
});
