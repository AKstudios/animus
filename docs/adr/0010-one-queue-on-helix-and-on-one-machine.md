# One queue, on Helix and on one machine

Jobs ran in the foreground of whoever started them, and only Helix had a
queue. A job waiting on an earlier spec was a live process polling GitHub,
so closing a Claude session killed waiting and running jobs alike, and left
folders the display could only call "unknown project". On Helix a waiting
job held a slot.

The queue, its loop and its room check now live in the plugin, and Helix
runs on them: Helix adds people, containers, its HTTP API, Slack and
GitHub. On one machine `animus start` queues the job and makes sure the
same loop is running as a process of its own, detached from the session
that started it; it exits when the queue is empty and any `animus` command
starts it again while work is left. A job waiting on an earlier spec is a
row in the queue, not a process, and starts by itself once that spec's pull
request is merged.

## Considered options

- A local queue that only tells the next session a job is ready: a second
  system beside Helix's, and nothing starts while no session is open.
- launchd, systemd or a scheduled task: one mechanism per operating system,
  against the rule that nothing depends on one.
- Running Helix itself on the laptop: people, tokens and an HTTP server for
  one person.

## Consequences

Closing a session stops nothing; a machine that sleeps pauses the loop,
which picks up running jobs on wake as Helix does after a restart. Every
job writes a log file, so the display shows it wherever the job ran.
`animus status`, `answer` and `cancel` work the same on both. The room check
needs a reading of available memory per operating system, since Node's free
memory on macOS leaves out what the system would reclaim.
