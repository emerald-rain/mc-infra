// Server states from GET /api/server (see worker/api/server.js): label and dot colour

export const STATES = {
  none:          { label: "No server",       dot: "ring" },
  creating:      { label: "Creating",        dot: "amber" },
  booting:       { label: "Booting",         dot: "amber" },
  restoring:     { label: "Restoring world", dot: "amber" },
  starting:      { label: "Starting",        dot: "amber" },
  online:        { label: "Online",          dot: "green" },
  stopped:       { label: "Stopped",         dot: "red" },
  backing_up:    { label: "Backing up",      dot: "amber" },
  deleting:      { label: "Deleting",        dot: "amber" },
  backup_failed: { label: "Backup failed",   dot: "red" },
  start_failed:  { label: "Start failed",    dot: "red" },
};

// States in which the server can be shut down (the agent runs the backup; a failed start is just deleted)
export const STOPPABLE = ["starting", "online", "stopped", "backup_failed", "start_failed"];

// Shutdown plans (DESIGN.md §3.6)
export const PLANS = {
  now:   { title: "Now", desc: "Stops right away. Everyone online is disconnected." },
  hour:  { title: "Before next hour", desc: "Stops 10 min before the next billed hour, even if players are online." },
  empty: { title: "When everyone leaves", desc: "Stops 10 min before a billed hour if nobody’s online, otherwise waits an hour." },
};

// Minutes until a "hour" plan stops the server: 10 min before the next billed hour
export function minutesToPlannedStop(minutesLeft) {
  return Math.max(0, minutesLeft - 10);
}
