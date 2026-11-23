// Server states from GET /api/server (see worker/api/server.js): label and dot colour

// The pill names the stage only: "Starting" covers every step of a start
export const STATES = {
  none:          { label: "No server",       dot: "ring" },
  creating:      { label: "Starting",        dot: "amber" },
  booting:       { label: "Starting",        dot: "amber" },
  restoring:     { label: "Starting",        dot: "amber" },
  starting:      { label: "Starting",        dot: "amber" },
  online:        { label: "Online",          dot: "green" },
  stopped:       { label: "Stopped",         dot: "red" },
  backing_up:    { label: "Backing up",      dot: "amber" },
  deleting:      { label: "Backing up",      dot: "amber" },
  backup_failed: { label: "Backup failed",   dot: "red" },
  start_failed:  { label: "Start failed",    dot: "red" },
};

// States in which the server can be shut down (the agent runs the backup; a failed start is just deleted)
export const STOPPABLE = ["starting", "online", "stopped", "backup_failed", "start_failed"];

// A start in progress: the No server screen stays up (locked) until the server is online
export const STARTING = ["creating", "booting", "restoring", "starting"];

// A stop in progress: the Online screen stays up until the server is gone
export const STOPPING = ["backing_up", "deleting"];
