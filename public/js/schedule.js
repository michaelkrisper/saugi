// Cleaning schedule, stored twice like the Roborock app (S7 plugin) does it:
// - in the cloud as a "job" that fires server_scheduled_start, cron "MM HH ? * d,d";
// - on the vacuum via set_server_timer, keyed by the same name, cron "M H * * d,d".
// Days are 0 = Sunday ... 6 = Saturday in both. The Roborock app lists only jobs the
// vacuum knows (get_server_timer).

export function parseCron(cron) {
  const [min, hour, , , dow] = String(cron).trim().split(/\s+/);
  let days = [];
  if (dow === '*' || dow === '?') days = [0, 1, 2, 3, 4, 5, 6];
  else if (dow) {
    for (const part of dow.split(',')) {
      const [a, b = a] = part.split('-').map(Number);
      for (let d = a; d <= b; d++) days.push(d % 7);
    }
  }
  return { hour: Number(hour), minute: Number(min), days: [...new Set(days)].sort() };
}

export function formatCron({ hour, minute, days }) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(minute)} ${pad(hour)} ? * ${[...days].sort().join(',')}`;
}

export const jobName = (job) => job?.param?.params?.[0]?.name;

// set_server_timer parameter: [name, [cron, ['start_clean', params without name]]].
export function deviceTimer(job, { hour, minute, days }) {
  const { name, ...params } = job.param.params[0];
  return [name, [`${minute} ${hour} * * ${[...days].sort().join(',')}`, ['start_clean', params]]];
}

// A whole-home clean with the current suction/mop settings, shaped like the jobs
// the Roborock app creates.
export function newJob({ hour, minute, days, enabled }, status, timeZoneId, now = Date.now()) {
  return {
    cron: formatCron({ hour, minute, days }),
    timeZoneId,
    repeated: true,
    enabled,
    param: {
      id: 1,
      method: 'server_scheduled_start',
      params: [
        {
          repeat: 1,
          water_box_mode: status?.water_box_mode ?? 203,
          segments: '0',
          fan_power: status?.fan_power ?? 102,
          mop_mode: status?.mop_mode ?? 300,
          clean_mop: 1,
          map_index: -1,
          name: String(now),
        },
      ],
    },
  };
}

// PUT replaces the job, so send everything the server returned except its own fields.
export function updatedJob(job, { hour, minute, days, enabled }) {
  const { id: _id, nextFireTime: _next, ...rest } = job;
  return { ...rest, cron: formatCron({ hour, minute, days }), enabled };
}
